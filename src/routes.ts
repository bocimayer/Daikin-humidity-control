import { Router, Request, Response } from 'express';
import {
  collectSettableCharacteristicsSnapshot,
  DaikinClient,
  OperationMode,
  RawDevice,
  readOperationModeFromRawDevice,
  sortSnapshotEntriesForRestore,
} from './daikin';
import { runWithGatewayDeviceRetries } from './onecta-transient-retry';
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
const TASK_NOTIFY_TEST = 'notify-test';

// ─── Per-device result types ──────────────────────────────────────────────────

interface DeviceResult {
  deviceId: string;
  success: boolean;
  error?: string;
}

/** Checked before idempotency so disabling automation does not consume the duplicate window. */
function respondIfAutomationDisabled(res: Response, taskName: string): boolean {
  if (config.automationEnabled) return false;
  logger.warn('AUTOMATION_ENABLED is off — skipping Onecta task');
  void notifyTaskOutcome(config, {
    taskName,
    devicesTotal: 0,
    devicesSucceeded: 0,
    detail: 'AUTOMATION_ENABLED is false/0/off/disabled',
    subjectOverride: `[Daikin humidity] ${taskName}: automation disabled`,
  });
  res.status(200).json({ skipped: true, reason: 'automation-disabled' });
  return true;
}

/** One mail per check-humidity invocation (scheduler visibility). */
function emailCheckHumiditySummary(
  deviceCount: number,
  humiditySampleCount: number,
  responseBody: Record<string, unknown>,
): void {
  const action = responseBody.action;
  const reason = responseBody.reason;
  const skipped = responseBody.skipped === true;
  let headline: string;
  if (skipped) {
    headline = `skipped (${String(reason ?? 'unknown')})`;
  } else if (typeof action === 'string') {
    headline =
      responseBody.humidity !== undefined && responseBody.humidity !== null
        ? `${action} maxRH=${String(responseBody.humidity)}`
        : String(action);
  } else if (reason) {
    headline = `no-action (${String(reason)})`;
  } else {
    headline = 'ok';
  }
  void notifyTaskOutcome(config, {
    taskName: TASK_CHECK_HUMIDITY,
    devicesTotal: deviceCount,
    devicesSucceeded: humiditySampleCount,
    detail: JSON.stringify(responseBody),
    subjectOverride: `[Daikin humidity] check-humidity: ${headline}`,
  });
}

// ─── Dry-start logic (shared between direct and humidity-triggered paths) ─────
// Sequential + per-device retries: every head must succeed before the FSM marks dry active.
// Each attempt re-reads the gateway (preflight still gates the route before idempotency).

async function executeDryStart(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
  deviceIds: string[],
  restoreStore: DeviceRestoreStore,
): Promise<DeviceResult[]> {
  for (const deviceId of deviceIds) {
    await runWithGatewayDeviceRetries('dry-start', deviceId, async () => {
      const raw = await client.getGatewayDeviceRaw(deviceId);
      const currentMode = readOperationModeFromRawDevice(raw);
      if (currentMode === 'dry') {
        logger.warn({ deviceId }, 'Device already in dry mode — skipping dry-start for this unit');
        return;
      }
      const entries = collectSettableCharacteristicsSnapshot(raw);
      await restoreStore.save(deviceId, {
        entries,
        capturedAt: new Date().toISOString(),
      });
      await client.setOperationMode(deviceId, 'dry' as OperationMode, raw);
    });
  }
  humidityFsm.setActive(true);
  return deviceIds.map((deviceId) => ({ deviceId, success: true }));
}

// ─── Dry-stop: one gateway, no swallowed PATCH errors (failed restore must retry or abort) ─

async function dryStopSingleDevice(
  client: DaikinClient,
  deviceId: string,
  restoreStore: DeviceRestoreStore,
): Promise<void> {
  const snap = await restoreStore.load(deviceId);
  if (snap && snap.entries.length > 0) {
    const ordered = sortSnapshotEntriesForRestore(snap.entries);
    for (const e of ordered) {
      await client.patchCharacteristic(
        deviceId,
        e.mpSlug,
        e.characteristicKey,
        e.value,
      );
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
}

// ─── Dry-stop logic (shared between direct and humidity-triggered paths) ──────
// Every head must complete (with transient retries); otherwise throws — no partial success JSON.

async function executeDryStop(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
  deviceIds: string[],
  restoreStore: DeviceRestoreStore,
): Promise<DeviceResult[]> {
  for (const deviceId of deviceIds) {
    await runWithGatewayDeviceRetries('dry-stop', deviceId, async () => {
      await dryStopSingleDevice(client, deviceId, restoreStore);
    });
  }
  humidityFsm.setActive(false);
  return deviceIds.map((deviceId) => ({ deviceId, success: true }));
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

  // ── POST /tasks/notify-test ─────────────────────────────────────────────────
  // OIDC-protected manual probe for Gmail + NOTIFY_EMAIL (does not touch Onecta).
  router.post('/tasks/notify-test', async (_req: Request, res: Response) => {
    try {
      await notifyTaskOutcome(config, {
        taskName: TASK_NOTIFY_TEST,
        devicesTotal: 1,
        devicesSucceeded: 1,
        detail: `POST /tasks/notify-test at ${new Date().toISOString()}`,
        subjectOverride: '[Daikin humidity] notify-test (mail path OK)',
      });
      res.status(200).json({ ok: true, message: 'If Gmail is configured, one test email was sent.' });
    } catch (err) {
      logger.error({ task: TASK_NOTIFY_TEST, err }, 'notify-test failed');
      res.status(500).json({ ok: false, error: 'notify-test failed (see logs)' });
    }
  });

  // ── POST /tasks/dry-start ───────────────────────────────────────────────────
  router.post('/tasks/dry-start', async (_req: Request, res: Response) => {
    if (respondIfAutomationDisabled(res, TASK_DRY_START)) return;

    const deviceIds = await resolveGatewayDeviceIds(client);
    if (deviceIds.length === 0) {
      logger.warn({ task: TASK_DRY_START }, 'Onecta lists no gateway devices — skipping dry-start');
      res.status(200).json({ skipped: true, reason: 'no-gateway-devices' });
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_START,
        devicesTotal: 0,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-start: no gateway devices`,
        detail: 'Onecta returned zero gateway devices',
      });
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
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_START,
        devicesTotal: deviceIds.length,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-start: skipped (${preflight.reason})`,
        detail: JSON.stringify({ reason: preflight.reason, modesByDeviceId: preflight.modesByDeviceId }),
      });
      return;
    }

    if (!idempotency.checkAndMark(TASK_DRY_START)) {
      logger.info({ task: TASK_DRY_START }, 'Idempotency guard: skipping duplicate trigger');
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_START,
        devicesTotal: deviceIds.length,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-start: duplicate (idempotency window)`,
        detail: 'duplicate-within-window',
      });
      return;
    }

    logger.info({ task: TASK_DRY_START, devices: deviceIds }, 'Starting dry cycle');

    try {
      const results = await executeDryStart(client, humidityFsm, deviceIds, restoreStore);
      logger.info(
        { task: TASK_DRY_START, succeeded: results.length, total: results.length },
        'Dry cycle started',
      );
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_START,
        devicesTotal: results.length,
        devicesSucceeded: results.length,
      });
      res.status(200).json({ success: true, devicesControlled: results.length, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ task: TASK_DRY_START, err }, 'dry-start did not complete on all gateway devices');
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_START,
        devicesTotal: deviceIds.length,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-start: FAILED (${deviceIds.length} heads — see logs)`,
        detail: message,
      });
      res.status(500).json({
        success: false,
        error: 'dry-start did not complete on all gateway devices',
        message,
      });
    }
  });

  // ── POST /tasks/dry-stop ────────────────────────────────────────────────────
  router.post('/tasks/dry-stop', async (_req: Request, res: Response) => {
    if (respondIfAutomationDisabled(res, TASK_DRY_STOP)) return;

    const deviceIds = await resolveGatewayDeviceIds(client);
    if (deviceIds.length === 0) {
      logger.warn({ task: TASK_DRY_STOP }, 'Onecta lists no gateway devices — skipping dry-stop');
      res.status(200).json({ skipped: true, reason: 'no-gateway-devices' });
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_STOP,
        devicesTotal: 0,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-stop: no gateway devices`,
        detail: 'Onecta returned zero gateway devices',
      });
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
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_STOP,
        devicesTotal: deviceIds.length,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-stop: skipped (${stopPreflight.reason})`,
        detail: JSON.stringify({ reason: stopPreflight.reason, modesByDeviceId: stopPreflight.modesByDeviceId }),
      });
      return;
    }

    if (!idempotency.checkAndMark(TASK_DRY_STOP)) {
      logger.info({ task: TASK_DRY_STOP }, 'Idempotency guard: skipping duplicate trigger');
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_STOP,
        devicesTotal: deviceIds.length,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-stop: duplicate (idempotency window)`,
        detail: 'duplicate-within-window',
      });
      return;
    }

    logger.info(
      { task: TASK_DRY_STOP, devices: deviceIds },
      'Stopping dry cycle - restoring saved settings',
    );

    try {
      const results = await executeDryStop(client, humidityFsm, deviceIds, restoreStore);
      logger.info(
        { task: TASK_DRY_STOP, succeeded: results.length, total: results.length },
        'Dry cycle stopped (restored or fallback heat)',
      );
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_STOP,
        devicesTotal: results.length,
        devicesSucceeded: results.length,
      });
      res.status(200).json({ success: true, devicesControlled: results.length, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ task: TASK_DRY_STOP, err }, 'dry-stop did not complete on all gateway devices');
      void notifyTaskOutcome(config, {
        taskName: TASK_DRY_STOP,
        devicesTotal: deviceIds.length,
        devicesSucceeded: 0,
        subjectOverride: `[Daikin humidity] dry-stop: FAILED (${deviceIds.length} heads — see logs)`,
        detail: message,
      });
      res.status(500).json({
        success: false,
        error: 'dry-stop did not complete on all gateway devices',
        message,
      });
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
    if (respondIfAutomationDisabled(res, TASK_CHECK_HUMIDITY)) return;

    if (!idempotency.checkAndMark(TASK_CHECK_HUMIDITY)) {
      logger.info(
        { task: TASK_CHECK_HUMIDITY },
        'Idempotency guard: skipping duplicate trigger',
      );
      const body = { skipped: true, reason: 'duplicate-within-window' };
      emailCheckHumiditySummary(0, 0, body);
      res.status(200).json(body);
      return;
    }

    const deviceIds = await resolveGatewayDeviceIds(client);
    if (deviceIds.length === 0) {
      logger.warn({ task: TASK_CHECK_HUMIDITY }, 'Onecta lists no gateway devices — skipping');
      const body = { skipped: true, reason: 'no-gateway-devices' };
      emailCheckHumiditySummary(0, 0, body);
      res.status(200).json(body);
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
        const body = {
          action: 'no-action',
          reason: clusterGate.reason,
          modesByDeviceId: clusterGate.modesByDeviceId,
          humidity: null,
        };
        emailCheckHumiditySummary(deviceIds.length, 0, body);
        res.status(200).json(body);
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
        const body = { action: 'no-action', reason: 'no-humidity-data', humidity: null };
        emailCheckHumiditySummary(deviceIds.length, 0, body);
        res.status(200).json(body);
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

      const thresholds = {
        high: config.humidityHighThreshold,
        low: config.humidityLowThreshold,
      };

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
          const body = {
            action: 'no-action',
            reason: startPreflight.reason,
            modesByDeviceId: startPreflight.modesByDeviceId,
            humidity: maxHumidity,
            thresholds,
          };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(200).json(body);
          return;
        }
        if (!idempotency.checkAndMark(TASK_DRY_START)) {
          logger.info('Humidity triggered dry-start but idempotency guard blocked it');
          const body = { action: 'start-blocked', humidity: maxHumidity, thresholds };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(200).json(body);
          return;
        }
        try {
          await executeDryStart(client, humidityFsm, deviceIds, restoreStore);
          const body = {
            action: decision,
            humidity: maxHumidity,
            thresholds,
            dryStartDevicesSucceeded: deviceIds.length,
            dryStartDevicesTotal: deviceIds.length,
          };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(200).json(body);
        } catch (startErr) {
          const message = startErr instanceof Error ? startErr.message : String(startErr);
          logger.error({ task: TASK_CHECK_HUMIDITY, err: startErr }, 'Humidity-triggered dry-start failed');
          const body = {
            action: 'start-failed',
            humidity: maxHumidity,
            thresholds,
            error: message,
          };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(500).json(body);
        }
        return;
      }

      if (decision === 'stop') {
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
          const body = {
            action: 'no-action',
            reason: stopPreflight.reason,
            modesByDeviceId: stopPreflight.modesByDeviceId,
            humidity: maxHumidity,
            thresholds,
          };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(200).json(body);
          return;
        }
        if (!idempotency.checkAndMark(TASK_DRY_STOP)) {
          logger.info('Humidity triggered dry-stop but idempotency guard blocked it');
          const body = { action: 'stop-blocked', humidity: maxHumidity, thresholds };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(200).json(body);
          return;
        }
        try {
          await executeDryStop(client, humidityFsm, deviceIds, restoreStore);
          const body = {
            action: decision,
            humidity: maxHumidity,
            thresholds,
            dryStopDevicesSucceeded: deviceIds.length,
            dryStopDevicesTotal: deviceIds.length,
          };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(200).json(body);
        } catch (stopErr) {
          const message = stopErr instanceof Error ? stopErr.message : String(stopErr);
          logger.error({ task: TASK_CHECK_HUMIDITY, err: stopErr }, 'Humidity-triggered dry-stop failed');
          const body = {
            action: 'stop-failed',
            humidity: maxHumidity,
            thresholds,
            error: message,
          };
          emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
          res.status(500).json(body);
        }
        return;
      }

      const body = { action: decision, humidity: maxHumidity, thresholds };
      emailCheckHumiditySummary(deviceIds.length, humidityReadings.length, body);
      res.status(200).json(body);
    } catch (err) {
      logger.error({ task: TASK_CHECK_HUMIDITY, err }, 'Unexpected error in check-humidity');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
