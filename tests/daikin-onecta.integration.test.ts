/**
 * Live calls to Daikin Onecta (uses repo-root .env). Excluded from default `npm test`.
 *
 * Run (from repo root, after valid DAIKIN_* in .env):
 *   DAIKIN_INTEGRATION_TEST=1 npm run test:onnecta
 *
 * Windows PowerShell:
 *   $env:DAIKIN_INTEGRATION_TEST='1'; npm run test:onnecta
 *
 * Cross-references:
 *   - Client: ../src/daikin.ts
 *   - CLI twin: ../scripts/daikin-live-smoke.ts
 */

import { config } from '../src/config';
import {
  collectSettableCharacteristicsSnapshot,
  DaikinClient,
  readOperationModeFromRawDevice,
  sortSnapshotEntriesForRestore,
} from '../src/daikin';
import { createRefreshTokenStore } from '../src/token-store';

const enabled = process.env.DAIKIN_INTEGRATION_TEST === '1';

(enabled ? describe : describe.skip)(
  'Daikin Onecta live API (set DAIKIN_INTEGRATION_TEST=1)',
  () => {
    let client: DaikinClient;

    beforeAll(() => {
      const refreshTokenStore = createRefreshTokenStore({
        backend: config.daikin.tokenStore.backend,
        bootstrapRefreshToken: config.daikin.bootstrapRefreshToken,
        localFilePath: config.daikin.tokenStore.localFilePath,
        firestoreCollection: config.daikin.tokenStore.firestoreCollection,
        firestoreDocument: config.daikin.tokenStore.firestoreDocument,
      });
      client = new DaikinClient(
        config.daikin.clientId,
        config.daikin.clientSecret,
        config.daikin.baseUrl,
        config.daikin.authUrl,
        refreshTokenStore,
        config.daikin.writeConcurrency,
        config.daikin.httpPaceMs,
      );
    });

    it('lists gateway devices (GET /v1/gateway-devices)', async () => {
      const devices = await client.getDevices();
      expect(Array.isArray(devices)).toBe(true);
      expect(devices.length).toBeGreaterThan(0);
      for (const d of devices) {
        expect(d.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    });

    it('reads parsed state for every listed device', async () => {
      const devices = await client.getDevices();
      expect(devices.length).toBeGreaterThan(0);

      for (const d of devices) {
        const state = await client.getDeviceState(d.id);
        expect(state.deviceId).toBe(d.id);
        expect(state.name).toBeTruthy();
        // mode / humidity / setpoint may be null per model — only assert shape
        if (state.operationMode !== null) {
          expect(typeof state.operationMode).toBe('string');
        }
        if (state.humidity !== null) {
          expect(state.humidity).toBeGreaterThanOrEqual(0);
          expect(state.humidity).toBeLessThanOrEqual(100);
        }
        if (state.setpointTempC !== null) {
          expect(state.setpointTempC).toBeGreaterThanOrEqual(5);
          expect(state.setpointTempC).toBeLessThanOrEqual(30);
        }
      }
    });

    it('applies a reversible heating setpoint nudge on one device (PATCH)', async () => {
      const devices = await client.getDevices();
      const states = await Promise.all(devices.map((d) => client.getDeviceState(d.id)));

      const target = states.find((s) => s.setpointTempC !== null);
      if (!target) {
        console.warn(
          '[integration] No device with readable heating setpoint — skipping write test.',
        );
        return;
      }

      const original = target.setpointTempC as number;
      const bumped = Math.min(30, Math.max(5, Math.round((original + 0.5) * 2) / 2));

      await client.setTemperature(target.deviceId, bumped);
      const mid = await client.getDeviceState(target.deviceId);
      expect(mid.setpointTempC).not.toBeNull();
      // Hardware often quantises to 0.5 °C — allow small delta from requested value.
      expect(Math.abs((mid.setpointTempC as number) - bumped)).toBeLessThanOrEqual(0.5);

      await client.setTemperature(target.deviceId, original);
      const final = await client.getDeviceState(target.deviceId);
      expect(final.setpointTempC).not.toBeNull();
      expect(Math.abs((final.setpointTempC as number) - original)).toBeLessThanOrEqual(0.5);
    });

    /**
     * Full snapshot → DRY → PATCH replay restore (same path as production dry-stop).
     * Runs with other live tests when DAIKIN_INTEGRATION_TEST=1 (real hardware).
     */
    it(
      'dry cycle on one device: snapshot, set dry, restore via patchCharacteristic replay',
      async () => {
        const devices = await client.getDevices();
        expect(devices.length).toBeGreaterThan(0);
        const deviceId = devices[0].id;

        const rawBefore = await client.getGatewayDeviceRaw(deviceId);
        const modeBefore = readOperationModeFromRawDevice(rawBefore);
        if (modeBefore === 'dry') {
          console.warn('[integration] Device already in dry — skipping dry-restore test.');
          return;
        }

        const entries = collectSettableCharacteristicsSnapshot(rawBefore);
        expect(entries.length).toBeGreaterThan(0);

        await client.setOperationMode(deviceId, 'dry');
        const mid = await client.getDeviceState(deviceId);
        expect(mid.operationMode).toBe('dry');

        const ordered = sortSnapshotEntriesForRestore(entries);
        for (const e of ordered) {
          try {
            await client.patchCharacteristic(deviceId, e.mpSlug, e.characteristicKey, e.value);
          } catch (err) {
            console.warn('[integration] restore PATCH failed', e, err);
          }
        }

        const after = await client.getDeviceState(deviceId);
        expect(after.operationMode).not.toBe('dry');
        if (modeBefore !== null) {
          expect(after.operationMode).toBe(modeBefore);
        }
      },
      120_000,
    );
  },
);

