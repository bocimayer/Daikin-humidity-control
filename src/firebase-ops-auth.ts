/**
 * Firebase Authentication: verify `Authorization: Bearer <Firebase ID token>` for /ops API routes.
 * Browser obtains tokens via Firebase client SDK (Google provider); Firebase Console must enable Auth + authorized domains.
 * Decision (implementation): Firebase-only for ops — see README browser ops section (no IAP JWT path).
 * Cross-ref: src/ops-routes.ts, src/ops-email-allowlist.ts, src/server.ts
 */
import * as admin from 'firebase-admin';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { isEmailInOpsAllowlist } from './ops-email-allowlist';
import logger from './logger';

/** Express locals set by requireFirebaseOpsAuth. */
export type OpsRequest = Request & { opsEmail?: string };

export { isEmailInOpsAllowlist } from './ops-email-allowlist';

function ensureFirebaseAdminInitialized(): void {
  if (admin.apps.length > 0) return;
  const projectId = config.ops.firebaseProjectId.trim();
  if (!projectId) {
    throw new Error('Firebase Admin requires FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT');
  }
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
}

/**
 * Require a valid Firebase Auth ID token and ALLOWED_OPS_EMAILS (non-empty in production — see ops-email-allowlist.ts).
 */
export async function requireFirebaseOpsAuth(req: OpsRequest, res: Response, next: NextFunction): Promise<void> {
  if (config.nodeEnv === 'development' && config.ops.firebaseBypass) {
    logger.warn(
      { path: req.path },
      'OPS_FIREBASE_BYPASS=1 in development — skipping Firebase verification (NEVER in production)',
    );
    req.opsEmail = 'dev-bypass@local.invalid';
    next();
    return;
  }

  if (config.nodeEnv === 'production' && !config.ops.firebaseProjectId.trim()) {
    logger.error('GOOGLE_CLOUD_PROJECT / FIREBASE_PROJECT_ID missing — /ops API disabled in production');
    res.status(503).json({
      error: 'not_configured',
      message: 'Set GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID for Firebase Admin.',
    });
    return;
  }

  if (!config.ops.firebaseProjectId.trim()) {
    res.status(503).json({
      error: 'not_configured',
      message:
        'Set GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID (or NODE_ENV=development with OPS_FIREBASE_BYPASS=1 for local).',
    });
    return;
  }

  // Empty allowlist + production = any Google account could call /ops JSON routes (see ops-email-allowlist.ts).
  if (config.nodeEnv === 'production' && config.ops.allowedOpsEmails.length === 0) {
    logger.error('ALLOWED_OPS_EMAILS is empty in production — refuse /ops API until configured');
    res.status(503).json({
      error: 'not_configured',
      message:
        'Set ALLOWED_OPS_EMAILS to a comma-separated list of allowed Google account emails for /ops (scheduler control).',
    });
    return;
  }

  const authHeader = req.get('authorization') ?? req.get('Authorization');
  const raw = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!raw) {
    logger.warn({ path: req.path }, 'Missing Authorization Bearer Firebase ID token');
    res
      .status(401)
      .json({ error: 'unauthorized', message: 'Firebase ID token required (Authorization: Bearer).' });
    return;
  }

  try {
    ensureFirebaseAdminInitialized();
    const decoded = await admin.auth().verifyIdToken(raw);
    const email = decoded.email;
    if (!email) {
      logger.warn('Firebase token has no email claim');
      res.status(403).json({ error: 'forbidden', message: 'No email in Firebase token' });
      return;
    }
    if (!isEmailInOpsAllowlist(email, config.ops.allowedOpsEmails)) {
      logger.warn({ email }, 'Firebase user not in ALLOWED_OPS_EMAILS');
      res.status(403).json({ error: 'forbidden', message: 'This Google account is not allowed for /ops' });
      return;
    }
    req.opsEmail = email;
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ path: req.path, err: message }, 'Firebase ID token verification failed');
    res.status(403).json({ error: 'forbidden', message: 'Invalid or expired Firebase ID token' });
  }
}
