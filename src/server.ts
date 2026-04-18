/**
 * Application entry point.
 *
 * Startup order:
 *   1. Load & validate config (exits on misconfiguration).
 *   2. Construct shared singletons (DaikinClient, FSM, idempotency guard).
 *   3. Build Express app and mount routes.
 *   4. Start HTTP server.
 *   5. Register SIGTERM handler for graceful Cloud Run shutdown.
 */

import 'dotenv/config';
import express from 'express';
import { config } from './config';
import logger from './logger';
import { DaikinClient } from './daikin';
import { HumidityStateMachine } from './humidity';
import { IdempotencyGuard } from './idempotency';
import { requireSchedulerAuth } from './scheduler-auth';
import { createRouter } from './routes';
import { DeviceRestoreStore } from './device-restore-store';
import { createRefreshTokenStore } from './token-store';

// ── Singletons ────────────────────────────────────────────────────────────────

const refreshTokenStore = createRefreshTokenStore({
  backend: config.daikin.tokenStore.backend,
  bootstrapRefreshToken: config.daikin.bootstrapRefreshToken,
  localFilePath: config.daikin.tokenStore.localFilePath,
  firestoreCollection: config.daikin.tokenStore.firestoreCollection,
  firestoreDocument: config.daikin.tokenStore.firestoreDocument,
});

const daikinClient = new DaikinClient(
  config.daikin.clientId,
  config.daikin.clientSecret,
  config.daikin.baseUrl,
  config.daikin.authUrl,
  refreshTokenStore,
  config.daikin.writeConcurrency,
  config.daikin.httpPaceMs,
);

const humidityFsm = new HumidityStateMachine();

// 10-minute minimum gap between repeated executions of the same task.
const idempotency = new IdempotencyGuard(10 * 60 * 1000);

const deviceRestoreStore = new DeviceRestoreStore(config.daikinRestoreCollection);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

app.use(express.json());

// Protect all task endpoints with OIDC verification.
// Task routes use OIDC; GET /health is unauthenticated (see routes.ts — avoid /healthz on Cloud Run).
app.use('/tasks', requireSchedulerAuth);

// Mount all routes.
app.use('/', createRouter(daikinClient, humidityFsm, idempotency, deviceRestoreStore));

// 404 handler for unknown routes.
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start server ──────────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      nodeEnv: config.nodeEnv,
      automationEnabled: config.automationEnabled,
      deviceSource: 'onecta-gateway-list',
      tokenStore: refreshTokenStore.describe(),
    },
    'Daikin humidity control service started',
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force-exit if graceful shutdown takes too long (Cloud Run allows ~10 s).
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 9_000);
});

export { app };
