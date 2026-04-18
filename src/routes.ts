import { Router, Request, Response } from 'express';
import {
  collectSettableCharacteristicsSnapshot,
  DaikinClient,
  OperationMode,
  RawDevice,
  readOperationModeFromRawDevice,
  sortSnapshotEntriesForRestore,
} from './daikin';
import type { DeviceClimateRow } from './dry-cycle-guards';
import {
  evaluateDryStartPreflight,
  evaluateDryStopPreflight,
  evaluateHumidityAutomationCluster,
  fetchGatewayRawsSequential,
} from './dry-cycle-guards';
import { resolveGatewayDeviceIds } from './device-ids';
import { DeviceRestoreStore } from './device-restore-store';
import { HumidityStateMachine } from './humidity';
import { IdempotencyGuard } from './idempotency';
import { config } from './config';
import logger from './logger';
import { notifyTaskOutcome } from './task-notify';
import { buildGatewayDeviceStatusReport } from './gateway-device-status';

// ─── Task name constants ──────────────────────────────────────────────────────

const TASK_DRY_START = 'dry-start';
const TASK_DRY_STOP = 'dry-stop';
const TASK_CHECK_HUMIDITY = 'check-humidity';
const TASK_DEVICE_STATUS = 'device-status';

// ─── Per-device result types ──────────────────────────────────────────────────

interface DeviceResult {
  deviceId: string;
  success: boolean;
  error?: string;
}

/** Checked before idempotency so disabling automation does not consume the duplicate window. */
function respondIfAutomationDisabled(res: Response): boolean {
  if (config.automationEnabled) return false;
  logger.warn('AUTOMATION_ENABLED is off — skipping Onecta task');
  res.status(200).json({ skipped: true, reason: 'automation-disabled' });
  return true;
}

// ─── Dry-start logic (shared between direct and humidity-triggered paths) ─────

async function executeDryStart(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
  deviceIds: string[],
  restoreStore: DeviceRestoreStore,
  rawsByDeviceId: Map<string, RawDevice>,
): Promise<DeviceResult[]> {
  const results = await Promise.allSettled(
    deviceIds.map(async (deviceId) => {
      try {
        const raw = rawsByDeviceId.get(deviceId);
        if (!raw) {
          return { deviceId, success: false, error: 'missing preflight raw payload' };
        }
        const currentMode = readOperationModeFromRawDevice(raw);
        if (currentMode === 'dry') {
          logger.warn({ deviceId }, 'Device already in dry mode — skipping dry-start for this unit');
          return { deviceId, success: true };
        }
        const entries = collectSettableCharacteristicsSnapshot(raw);
        await restoreStore.save(deviceId, {
          entries,
          capturedAt: new Date().toISOString(),
        });
        await client.setOperationMode(deviceId, 'dry' as OperationMode, raw);
        return { deviceId, success: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error({ deviceId, error }, 'dry-start failed for device');
        return { deviceId, success: false, error };
      }
    }),
  );

  const mapped: DeviceResult[] = results.map((result, idx) => {
    const deviceId = deviceIds[idx];
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      deviceId,
      success: false,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });

  if (mapped.every((r) => r.success)) {
    humidityFsm.setActive(true);
  } else {
    logger.error(
      { failed: mapped.filter((r) => !r.success).length, total: mapped.length },
      'dry-start partial failure — leaving humidity FSM inactive',
    );
  }
  return mapped;
}

// ─── Dry-stop logic (shared between direct and humidity-triggered paths) ──────

async function executeDryStop(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
  deviceIds: string[],
  restoreStore: DeviceRestoreStore,
): Promise<DeviceResult[]> {
  // One device at a time: each dry-stop issues many restore PATCHes; parallel chains still
  // serialized HTTP-wise but sequential end-to-end keeps Onecta + Firestore work ordered
  // and pairs with DAIKIN_HTTP_PACE_MS between every gated call (see daikin.ts).
  const mapped: DeviceResult[] = [];
  for (const deviceId of deviceIds) {
    try {
      const snap = await restoreStore.load(deviceId);
      if (snap && snap.entries.length > 0) {
        const ordered = sortSnapshotEntriesForRestore(snap.entries);
        for (const e of ordered) {
          try {
            await client.patchCharacteristic(
              deviceId,
              e.mpSlug,
              e.characteristicKey,
              e.value,
            );
          } catch (patchErr) {
            const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
            logger.error(
              {
                deviceId,
                mpSlug: e.mpSlug,
                characteristicKey: e.characteristicKey,
                error: msg,
              },
              'Restore PATCH failed',
            );
          }
        }
        await restoreStore.delete(deviceId);
        const rawAfterRestore = await client.getGatewayDeviceRaw(deviceId);
        const state = client.parseGatewayPayload(rawAfterRestore);
        if (state.operationMode === 'dry') {
          logger.warn({ deviceId }, 'Still in dry after restore — applying heat fallback');
          await client.setOperationMode(deviceId, 'heating' as OperationMode, rawAfterRestore);
          await client.setTemperature(deviceId, config.heatTargetTempC, rawAfterRestore);
        }
      } else {
        logger.error({ deviceId }, 'No restore snapshot — applying heat fallback');
        const rawFallback = await client.getGatewayDeviceRaw(deviceId);
        await client.setOperationMode(deviceId, 'heating' as OperationMode, rawFallback);
        await client.setTemperature(deviceId, config.heatTargetTempC, rawFallback);
      }
      mapped.push({ deviceId, success: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ deviceId, error }, 'dry-stop failed for device');
      mapped.push({ deviceId, success: false, error });
    }
  }

  if (mapped.every((r) => r.success)) {
    humidityFsm.setActive(false);
  } else {
    logger.error(
      { failed: mapped.filter((r) => !r.success).length, total: mapped.length },
      'dry-stop partial failure — leaving humidity FSM active',
    );
  }
  return mapped;
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function createRouter(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
  idempotency: IdempotencyGuard,
  restoreStore: DeviceRestoreStore,
): Router {
  const router = Router();

  // ── GET /health ─────────────────────────────────────────────────────────────
  // Do not use /healthz on Cloud Run: the Google front end intercepts that path and
  // returns a generic HTML 404 before the request reaches this container (even with OIDC).
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── POST /tasks/dry-start ───────────────────────────────────────────────────
  router.post('/tasks/dry-start', async (_req: Request, res: Response) => {
    if (respondIfAutomationDisabled(res)) return;

    const deviceIds = await resolveGatewayDeviceIds(client);
    if (deviceIds.length === 0) {
      logger.warn({ task: TASK_DRY_START }, 'Onecta lists no gateway devices — skipping dry-start');
      res.status(200).json({ skipped: true, reason: 'no-gateway-devices' });
      return;
    }

    let raws: Map<string, RawDevice>;
    try {
      raws = await fetchGatewayRawsSequential(client, deviceIds);
    } catch (err) {
      logger.error({ task: TASK_DRY_START, err }, 'Dry-start preflight: failed to read gateway devices');
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    const preflight = evaluateDryStartPreflight(deviceIds, raws);
    if (!preflight.ok) {
      logger.warn(
        {
          task: TASK_DRY_START,
          reason: preflight.reason,
          modesByDeviceId: preflight.modesByDeviceId,
        },
        'Dry-start preflight blocked — cluster must share one mode; dry is blocked only in cooling (already dehumidifies)',
      );
      res.status(200).json({
        skipped: true,
        reason: preflight.reason,
        modesByDeviceId: preflight.modesByDeviceId,
      });
      return;
    }

    if (!idempotency.checkAndMark(TASK_DRY_START)) {
      logger.info({ task: TASK_DRY_START }, 'Idempotency guard: skipping duplicate trigger');
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      return;
    }

    logger.info({ task: TASK_DRY_START, devices: deviceIds }, 'Starting dry cycle');

    try {
      const results = await executeDryStart(
        client,
        humidityFsm,
        deviceIds,
        restoreStore,
        preflight.raws,
      );
      const succeeded = results.filter((r) => r.success).length;
      logger.info(
        { task: TASK_DRY_START, succeeded, total: results.length },
        'Dry cycle started',
      );
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_START,
        devicesTotal: results.length,
        devicesSucceeded: succeeded,
      });
      res.status(200).json({ success: true, devicesControlled: succeeded, results });
    } catch (err) {
      logger.error({ task: TASK_DRY_START, err }, 'Unexpected error in dry-start');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /tasks/dry-stop ────────────────────────────────────────────────────
  router.post('/tasks/dry-stop', async (_req: Request, res: Response) => {
    if (respondIfAutomationDisabled(res)) return;

    const deviceIds = await resolveGatewayDeviceIds(client);
    if (deviceIds.length === 0) {
      logger.warn({ task: TASK_DRY_STOP }, 'Onecta lists no gateway devices — skipping dry-stop');
      res.status(200).json({ skipped: true, reason: 'no-gateway-devices' });
      return;
    }

    let stopRows: DeviceClimateRow[];
    try {
      const raws = await fetchGatewayRawsSequential(client, deviceIds);
      stopRows = deviceIds.map((id) => {
        const raw = raws.get(id)!;
        const st = client.parseGatewayPayload(raw);
        return { deviceId: id, mode: st.operationMode, humidity: st.humidity };
      });
    } catch (err) {
      logger.error({ task: TASK_DRY_STOP, err }, 'Dry-stop preflight: failed to read gateway devices');
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    const stopPreflight = evaluateDryStopPreflight(stopRows);
    if (!stopPreflight.ok) {
      logger.warn(
        {
          task: TASK_DRY_STOP,
          reason: stopPreflight.reason,
          modesByDeviceId: stopPreflight.modesByDeviceId,
        },
        'Dry-stop preflight blocked — refuse to restore a split cluster for the outdoor unit',
      );
      if (stopPreflight.reason === 'cluster-not-in-dry') {
        humidityFsm.setActive(false);
      }
      res.status(200).json({
        skipped: true,
        reason: stopPreflight.reason,
        modesByDeviceId: stopPreflight.modesByDeviceId,
      });
      return;
    }

    if (!idempotency.checkAndMark(TASK_DRY_STOP)) {
      logger.info({ task: TASK_DRY_STOP }, 'Idempotency guard: skipping duplicate trigger');
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      return;
    }

    logger.info(
      { task: TASK_DRY_STOP, devices: deviceIds },
      'Stopping dry cycle - restoring saved settings',
    );

    try {
      const results = await executeDryStop(client, humidityFsm, deviceIds, restoreStore);
      const succeeded = results.filter((r) => r.success).length;
      logger.info(
        { task: TASK_DRY_STOP, succeeded, total: results.length },
        'Dry cycle stopped (restored or fallback heat)',
      );
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_STOP,
        devicesTotal: results.length,
        devicesSucceeded: succeeded,
      });
      res.status(200).json({ success: true, devicesControlled: succeeded, results });
    } catch (err) {
      logger.error({ task: TASK_DRY_STOP, err }, 'Unexpected error in dry-stop');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── GET /tasks/device-status ─────────────────────────────────────────────────
  // Read-only Onecta snapshot (same OIDC gate as other /tasks routes). No idempotency — safe to poll.
  router.get('/tasks/device-status', async (_req: Request, res: Response) => {
    try {
      const report = await buildGatewayDeviceStatusReport(client);
      logger.info(
        { task: TASK_DEVICE_STATUS, deviceCount: report.devices.length },
        'Gateway device status snapshot',
      );
      res.status(200).json(report);
    } catch (err) {
      logger.error({ task: TASK_DEVICE_STATUS, err }, 'device-status failed');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /tasks/check-humidity ──────────────────────────────────────────────
  router.post('/tasks/check-humidity', async (_req: Request, res: Response) => {
    if (respondIfAutomationDisabled(res)) return;
    if (config.modeStrategy !== 'humidity') {
      logger.info(
        { modeStrategy: config.modeStrategy },
        'check-humidity called but MODE_STRATEGY is not humidity — skipping',
      );
      res.status(200).json({ skipped: true, reason: 'mode-strategy-is-timer' });
      return;
    }

    if (!idempotency.checkAndMark(TASK_CHECK_HUMIDITY)) {
      logger.info(
        { task: TASK_CHECK_HUMIDITY },
        'Idempotency guard: skipping duplicate trigger',
      );
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      return;
    }

    const deviceIds = await resolveGatewayDeviceIds(client);
    if (deviceIds.length === 0) {
      logger.warn({ task: TASK_CHECK_HUMIDITY }, 'Onecta lists no gateway devices — skipping');
      res.status(200).json({ skipped: true, reason: 'no-gateway-devices' });
      return;
    }

    logger.info({ task: TASK_CHECK_HUMIDITY, devices: deviceIds }, 'Checking humidity from gateway devices');

    try {
      const raws = await fetchGatewayRawsSequential(client, deviceIds);
      const climateRows: DeviceClimateRow[] = deviceIds.map((id) => {
        const st = client.parseGatewayPayload(raws.get(id)!);
        return { deviceId: id, mode: st.operationMode, humidity: st.humidity };
      });

      const clusterGate = evaluateHumidityAutomationCluster(climateRows);
      if (!clusterGate.ok) {
        logger.warn(
          {
            task: TASK_CHECK_HUMIDITY,
            reason: clusterGate.reason,
            modesByDeviceId: clusterGate.modesByDeviceId,
          },
          'Humidity automation blocked — indoor heads must agree on operation mode for the outdoor unit',
        );
        res.status(200).json({
          action: 'no-action',
          reason: clusterGate.reason,
          modesByDeviceId: clusterGate.modesByDeviceId,
          humidity: null,
        });
        return;
      }

      const humidityReadings: number[] = [];
      for (const row of climateRows) {
        if (row.humidity !== null) {
          humidityReadings.push(row.humidity);
          logger.info(
            { deviceId: row.deviceId, humidity: row.humidity, operationMode: row.mode },
            'Humidity reading (real installs: whether a head sends RH while idle depends on that model and Onecta payload)',
          );
        } else {
          logger.warn(
            { deviceId: row.deviceId, operationMode: row.mode },
            'No indoor RH from Onecta for this head — it will not contribute to max(RH) until the device reports a value (common when not actively conditioning)',
          );
        }
      }

      if (humidityReadings.length === 0) {
        logger.warn('No humidity readings available — cannot make hysteresis decision');
        res
          .status(200)
          .json({ action: 'no-action', reason: 'no-humidity-data', humidity: null });
        return;
      }

      // Aggregate across devices with a sensor: max RH >= high ⇒ at least one unit is "wet";
      // max RH <= low ⇒ every unit that reported is below low (same threshold for hysteresis).
      const maxHumidity = Math.max(...humidityReadings);

      const decision = humidityFsm.evaluate(
        maxHumidity,
        config.humidityHighThreshold,
        config.humidityLowThreshold,
      );

      logger.info(
        {
          maxHumidity,
          readingsCount: humidityReadings.length,
          highThreshold: config.humidityHighThreshold,
          lowThreshold: config.humidityLowThreshold,
          decision,
          dryCycleActive: humidityFsm.isActive(),
        },
        'Hysteresis decision',
      );

      if (decision === 'start') {
        const startPreflight = evaluateDryStartPreflight(deviceIds, raws);
        if (!startPreflight.ok) {
          logger.warn(
            {
              task: TASK_CHECK_HUMIDITY,
              reason: startPreflight.reason,
              modesByDeviceId: startPreflight.modesByDeviceId,
            },
            'Humidity start blocked by dry-start policy (e.g. all cooling, or cluster rules)',
          );
          res.status(200).json({
            action: 'no-action',
            reason: startPreflight.reason,
            modesByDeviceId: startPreflight.modesByDeviceId,
            humidity: maxHumidity,
          });
          return;
        }
        if (!idempotency.checkAndMark(TASK_DRY_START)) {
          logger.info('Humidity triggered dry-start but idempotency guard blocked it');
          res.status(200).json({ action: 'start-blocked', humidity: maxHumidity });
          return;
        }
        const startResults = await executeDryStart(
          client,
          humidityFsm,
          deviceIds,
          restoreStore,
          startPreflight.raws,
        );
        const startOk = startResults.filter((r) => r.success).length;
        void notifyTaskOutcome(config, {
          taskName: TASK_DRY_START,
          devicesTotal: startResults.length,
          devicesSucceeded: startOk,
          detail: `humidity-driven maxRH=${maxHumidity.toFixed(1)}`,
        });
      } else if (decision === 'stop') {
        const stopPreflight = evaluateDryStopPreflight(climateRows);
        if (!stopPreflight.ok) {
          logger.warn(
            {
              task: TASK_CHECK_HUMIDITY,
              reason: stopPreflight.reason,
              modesByDeviceId: stopPreflight.modesByDeviceId,
            },
            'Humidity stop blocked — refuse dry-stop unless every head still reports dry',
          );
          if (stopPreflight.reason === 'cluster-not-in-dry') {
            humidityFsm.setActive(false);
          }
          res.status(200).json({
            action: 'no-action',
            reason: stopPreflight.reason,
            modesByDeviceId: stopPreflight.modesByDeviceId,
            humidity: maxHumidity,
          });
          return;
        }
        if (!idempotency.checkAndMark(TASK_DRY_STOP)) {
          logger.info('Humidity triggered dry-stop but idempotency guard blocked it');
          res.status(200).json({ action: 'stop-blocked', humidity: maxHumidity });
          return;
        }
        const stopResults = await executeDryStop(client, humidityFsm, deviceIds, restoreStore);
        const stopOk = stopResults.filter((r) => r.success).length;
        void notifyTaskOutcome(config, {
          taskName: TASK_DRY_STOP,
          devicesTotal: stopResults.length,
          devicesSucceeded: stopOk,
          detail: `humidity-driven maxRH=${maxHumidity.toFixed(1)}`,
        });
      }

      res.status(200).json({ action: decision, humidity: maxHumidity });
    } catch (err) {
      logger.error({ task: TASK_CHECK_HUMIDITY, err }, 'Unexpected error in check-humidity');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
