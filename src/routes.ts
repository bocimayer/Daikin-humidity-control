import { Router, Request, Response } from 'express';
import { DaikinClient, OperationMode } from './daikin';
import { HumidityStateMachine } from './humidity';
import { IdempotencyGuard } from './idempotency';
import { config } from './config';
import logger from './logger';

// ─── Task name constants ──────────────────────────────────────────────────────

const TASK_DRY_START = 'dry-start';
const TASK_DRY_STOP = 'dry-stop';
const TASK_CHECK_HUMIDITY = 'check-humidity';

// ─── Per-device result types ──────────────────────────────────────────────────

interface DeviceResult {
  deviceId: string;
  success: boolean;
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Applies an async operation to every configured device, collecting per-device
 * results. Errors on individual devices are caught and logged so that a single
 * failing unit does not abort the whole batch.
 */
async function applyToAllDevices(
  op: (deviceId: string) => Promise<void>,
  deviceIds: string[],
  opLabel: string,
): Promise<DeviceResult[]> {
  const results = await Promise.allSettled(deviceIds.map((id) => op(id)));

  return results.map((result, idx) => {
    const deviceId = deviceIds[idx];
    if (result.status === 'fulfilled') {
      logger.info({ deviceId, op: opLabel }, 'Device operation succeeded');
      return { deviceId, success: true };
    } else {
      const error =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error({ deviceId, op: opLabel, error }, 'Device operation failed');
      return { deviceId, success: false, error };
    }
  });
}

// ─── Dry-start logic (shared between direct and humidity-triggered paths) ─────

async function executeDryStart(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
): Promise<DeviceResult[]> {
  const results = await applyToAllDevices(
    (id) => client.setOperationMode(id, 'dry' as OperationMode),
    config.daikin.deviceIds,
    'setMode:dry',
  );
  humidityFsm.setActive(true);
  return results;
}

// ─── Dry-stop logic (shared between direct and humidity-triggered paths) ──────

async function executeDryStop(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
): Promise<DeviceResult[]> {
  // First set all units back to heating mode.
  const modeResults = await applyToAllDevices(
    (id) => client.setOperationMode(id, 'heating' as OperationMode),
    config.daikin.deviceIds,
    'setMode:heating',
  );

  // Then apply the frost-protection setpoint only to units where mode succeeded.
  const successfulIds = modeResults.filter((r) => r.success).map((r) => r.deviceId);
  if (successfulIds.length > 0) {
    await applyToAllDevices(
      (id) => client.setTemperature(id, config.heatTargetTempC),
      successfulIds,
      `setTemp:${config.heatTargetTempC}`,
    );
  }

  humidityFsm.setActive(false);
  return modeResults;
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function createRouter(
  client: DaikinClient,
  humidityFsm: HumidityStateMachine,
  idempotency: IdempotencyGuard,
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
    if (!idempotency.checkAndMark(TASK_DRY_START)) {
      logger.info({ task: TASK_DRY_START }, 'Idempotency guard: skipping duplicate trigger');
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      return;
    }

    logger.info({ task: TASK_DRY_START, devices: config.daikin.deviceIds }, 'Starting dry cycle');

    try {
      const results = await executeDryStart(client, humidityFsm);
      const succeeded = results.filter((r) => r.success).length;
      logger.info(
        { task: TASK_DRY_START, succeeded, total: results.length },
        'Dry cycle started',
      );
      res.status(200).json({ success: true, devicesControlled: succeeded, results });
    } catch (err) {
      logger.error({ task: TASK_DRY_START, err }, 'Unexpected error in dry-start');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /tasks/dry-stop ────────────────────────────────────────────────────
  router.post('/tasks/dry-stop', async (_req: Request, res: Response) => {
    if (!idempotency.checkAndMark(TASK_DRY_STOP)) {
      logger.info({ task: TASK_DRY_STOP }, 'Idempotency guard: skipping duplicate trigger');
      res.status(200).json({ skipped: true, reason: 'duplicate-within-window' });
      return;
    }

    logger.info(
      { task: TASK_DRY_STOP, devices: config.daikin.deviceIds, targetTempC: config.heatTargetTempC },
      'Stopping dry cycle, reverting to frost-protection heat',
    );

    try {
      const results = await executeDryStop(client, humidityFsm);
      const succeeded = results.filter((r) => r.success).length;
      logger.info(
        { task: TASK_DRY_STOP, succeeded, total: results.length },
        'Reverted to heating mode',
      );
      res.status(200).json({ success: true, devicesControlled: succeeded, results });
    } catch (err) {
      logger.error({ task: TASK_DRY_STOP, err }, 'Unexpected error in dry-stop');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /tasks/check-humidity ──────────────────────────────────────────────
  router.post('/tasks/check-humidity', async (_req: Request, res: Response) => {
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

    logger.info(
      { leaderIds: config.daikin.humidityLeaderIds },
      'Checking humidity from leader devices',
    );

    try {
      // Read state from each leader device.
      const stateResults = await Promise.allSettled(
        config.daikin.humidityLeaderIds.map((id) => client.getDeviceState(id)),
      );

      const humidityReadings: number[] = [];
      for (const [idx, result] of stateResults.entries()) {
        const deviceId = config.daikin.humidityLeaderIds[idx];
        if (result.status === 'fulfilled') {
          const { humidity } = result.value;
          if (humidity !== null) {
            humidityReadings.push(humidity);
            logger.info({ deviceId, humidity }, 'Humidity reading');
          } else {
            logger.warn({ deviceId }, 'Device returned no humidity value');
          }
        } else {
          const error =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          logger.error({ deviceId, error }, 'Failed to read device state');
        }
      }

      if (humidityReadings.length === 0) {
        logger.warn('No humidity readings available — cannot make hysteresis decision');
        res
          .status(200)
          .json({ action: 'no-action', reason: 'no-humidity-data', humidity: null });
        return;
      }

      const avgHumidity =
        humidityReadings.reduce((a, b) => a + b, 0) / humidityReadings.length;

      const decision = humidityFsm.evaluate(
        avgHumidity,
        config.humidityHighThreshold,
        config.humidityLowThreshold,
      );

      logger.info(
        {
          avgHumidity,
          highThreshold: config.humidityHighThreshold,
          lowThreshold: config.humidityLowThreshold,
          decision,
          dryCycleActive: humidityFsm.isActive(),
        },
        'Hysteresis decision',
      );

      if (decision === 'start') {
        if (!idempotency.checkAndMark(TASK_DRY_START)) {
          logger.info('Humidity triggered dry-start but idempotency guard blocked it');
          res.status(200).json({ action: 'start-blocked', humidity: avgHumidity });
          return;
        }
        await executeDryStart(client, humidityFsm);
      } else if (decision === 'stop') {
        if (!idempotency.checkAndMark(TASK_DRY_STOP)) {
          logger.info('Humidity triggered dry-stop but idempotency guard blocked it');
          res.status(200).json({ action: 'stop-blocked', humidity: avgHumidity });
          return;
        }
        await executeDryStop(client, humidityFsm);
      }

      res.status(200).json({ action: decision, humidity: avgHumidity });
    } catch (err) {
      logger.error({ task: TASK_CHECK_HUMIDITY, err }, 'Unexpected error in check-humidity');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
