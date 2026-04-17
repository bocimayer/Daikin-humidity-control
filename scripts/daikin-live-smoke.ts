/**
 * Live integration smoke against Daikin Onecta (uses .env — not run in CI).
 *
 * Cross-references:
 *   - API client: ../src/daikin.ts
 *   - Gateway list (same source as Cloud Run tasks): ../src/device-ids.ts
 *   - Run: npm run daikin:live-smoke [-- <deviceId>]
 *
 * Steps: list gateway devices → read each device state → optional reversible
 * heating setpoint nudge on one device (requires readable heating setpoint).
 */

import 'dotenv/config';
import { config } from '../src/config';
import { DaikinClient } from '../src/daikin';
import { createRefreshTokenStore } from '../src/token-store';

const log = (...args: unknown[]) => console.log('[daikin-live-smoke]', ...args);

function parseArgs(): { deviceId?: string; dumpRaw: boolean } {
  const argv = process.argv.slice(2);
  const dumpRaw = argv.includes('--raw');
  const rest = argv.filter((a) => a !== '--raw');
  const deviceId = rest[0]?.trim() || undefined;
  return { deviceId, dumpRaw };
}

async function main(): Promise<void> {
  const { deviceId: overrideDeviceId, dumpRaw } = parseArgs();
  const refreshTokenStore = createRefreshTokenStore({
    backend: config.daikin.tokenStore.backend,
    bootstrapRefreshToken: config.daikin.bootstrapRefreshToken,
    localFilePath: config.daikin.tokenStore.localFilePath,
    firestoreCollection: config.daikin.tokenStore.firestoreCollection,
    firestoreDocument: config.daikin.tokenStore.firestoreDocument,
  });

  const client = new DaikinClient(
    config.daikin.clientId,
    config.daikin.clientSecret,
    config.daikin.baseUrl,
    config.daikin.authUrl,
    refreshTokenStore,
    config.daikin.writeConcurrency,
  );

  log('Fetching GET /v1/gateway-devices …');
  const rawList = await client.getDevices();
  log(`Found ${rawList.length} gateway device(s).`);

  if (dumpRaw && rawList.length > 0) {
    const id = overrideDeviceId ?? rawList[0].id;
    log(`--raw: full JSON for GET /v1/gateway-devices/${id}`);
    const raw = await client.getGatewayDeviceRaw(id);
    console.log(JSON.stringify(raw, null, 2));
    console.log('');
  }

  if (rawList.length === 0) {
    log('Nothing to inspect.');
    return;
  }

  console.log('\n--- Devices (summary) ---');
  for (const d of rawList) {
    console.log(`  id: ${d.id}`);
  }

  console.log('\n--- Per-device state (parsed) ---');
  const states = [];
  for (const d of rawList) {
    const s = await client.getDeviceState(d.id);
    states.push(s);
    console.log(
      JSON.stringify(
        {
          deviceId: s.deviceId,
          name: s.name,
          operationMode: s.operationMode,
          humidity: s.humidity,
          setpointTempC: s.setpointTempC,
        },
        null,
        2,
      ),
    );
  }

  const targetId = overrideDeviceId ?? rawList[0].id;
  const targetState = states.find((s) => s.deviceId === targetId);
  if (!targetState) {
    log(`Device id not in list: ${targetId}`);
    process.exit(1);
  }

  console.log(`\n--- Write test target: ${targetId} (${targetState.name}) ---`);

  if (targetState.setpointTempC === null) {
    log(
      'Skipping PATCH: no heating room setpoint readable for this device (mode/model may differ).',
    );
    log('Pass a device id that exposes heating setpoint, or switch unit to a mode with heat SP.');
    return;
  }

  const original = targetState.setpointTempC;
  const bumped = Math.min(30, Math.max(5, Math.round((original + 0.5) * 2) / 2));

  log(`Temporary setpoint change: ${original} °C → ${bumped} °C (then restore)`);
  await client.setTemperature(targetId, bumped);
  const afterBump = await client.getDeviceState(targetId);
  log('After bump:', afterBump.setpointTempC);

  await client.setTemperature(targetId, original);
  const afterRestore = await client.getDeviceState(targetId);
  log('After restore:', afterRestore.setpointTempC);

  console.log('\n--- Live smoke finished OK ---');
}

main().catch((err: unknown) => {
  console.error('[daikin-live-smoke] FAILED.');
  if (err && typeof err === 'object' && 'response' in err) {
    const ax = err as { response?: { status?: number; data?: unknown } };
    console.error('HTTP', ax.response?.status, ax.response?.data);
  } else if (err instanceof Error) {
    console.error(err.message);
  }
  process.exit(1);
});
