/**
 * HTML shell + JSON APIs to pause/resume check-humidity (auto dry) via Cloud Scheduler.
 * Browser uses Firebase Auth (Google); API routes use src/firebase-ops-auth.ts + src/scheduler-ops.ts.
 */
import { Response, Router } from 'express';
import { config } from './config';
import logger from './logger';
import type { OpsRequest } from './firebase-ops-auth';
import { requireFirebaseOpsAuth } from './firebase-ops-auth';
import { renderOpsSchedulerMisconfigured, renderOpsSchedulerShell } from './ops-scheduler-html';
import { CheckHumiditySchedulerOps } from './scheduler-ops';

function pickProjectId(): string {
  return (
    config.ops.gcpProjectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    ''
  );
}

let opsSingleton: CheckHumiditySchedulerOps | null = null;
function getOps(): CheckHumiditySchedulerOps {
  if (opsSingleton) return opsSingleton;
  const projectId = pickProjectId();
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT (or config) is required for /ops/scheduler on Cloud Run');
  }
  opsSingleton = new CheckHumiditySchedulerOps(
    undefined,
    projectId,
    config.ops.schedulerRegion,
    config.ops.schedulerCheckHumidityJobName,
  );
  return opsSingleton;
}

export function createOpsRouter(): Router {
  const router = Router();

  /** Public HTML — loads Firebase client SDK; APIs below require Bearer token. */
  router.get('/scheduler', (_req, res: Response) => {
    const apiKey = config.ops.firebaseWebApiKey?.trim();
    if (!apiKey) {
      res
        .status(503)
        .type('html')
        .send(
          renderOpsSchedulerMisconfigured(
            'Set FIREBASE_WEB_API_KEY (Firebase Console → Project settings → Your apps). ' +
              'Also set GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID.',
          ),
        );
      return;
    }
    const pid = config.ops.firebaseProjectId.trim();
    const domain = config.ops.firebaseAuthDomain.trim();
    if (!pid || !domain) {
      res
        .status(503)
        .type('html')
        .send(renderOpsSchedulerMisconfigured('Set GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID.'));
      return;
    }
    res
      .status(200)
      .type('html')
      .send(
        renderOpsSchedulerShell({
          firebaseWebApiKey: apiKey,
          firebaseAuthDomain: domain,
          firebaseProjectId: pid,
          schedulerJobName: config.ops.schedulerCheckHumidityJobName,
        }),
      );
  });

  router.get('/scheduler/state', requireFirebaseOpsAuth, async (req: OpsRequest, res: Response) => {
    const who = req.opsEmail ?? 'unknown';
    try {
      const stateLabel = await getOps().getStateLabel();
      res.status(200).json({ stateLabel, email: who });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error({ err: m, who }, 'GET /ops/scheduler/state failed');
      res.status(500).json({ error: 'server_error', message: m });
    }
  });

  router.post('/scheduler', requireFirebaseOpsAuth, async (req: OpsRequest, res: Response) => {
    const who = req.opsEmail ?? 'unknown';
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    try {
      const ops = getOps();
      if (action === 'pause') {
        await ops.pause();
        logger.info({ who, action: 'pause' }, 'ops/scheduler pause check-humidity');
      } else if (action === 'resume') {
        await ops.resume();
        logger.info({ who, action: 'resume' }, 'ops/scheduler resume check-humidity');
      } else {
        res.status(400).json({ error: 'bad_request', message: 'invalid action' });
        return;
      }
      const stateLabel = await ops.getStateLabel();
      res.status(200).json({ ok: true, stateLabel, message: 'Updated.' });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error({ err: m, who, action }, 'POST /ops/scheduler failed');
      let stateLabel = 'unknown';
      try {
        stateLabel = await getOps().getStateLabel();
      } catch {
        // ignore secondary failure
      }
      res.status(500).json({ error: 'server_error', message: m, stateLabel });
    }
  });

  return router;
}
