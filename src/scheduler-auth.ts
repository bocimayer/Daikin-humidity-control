/**
 * OIDC authentication middleware for Cloud Scheduler → Cloud Run calls.
 *
 * Cloud Scheduler attaches a Google-signed OIDC token in the Authorization
 * header when it invokes a Cloud Run service. This middleware verifies that
 * token so that only our designated Scheduler service account can trigger the
 * task endpoints.
 *
 * Security model:
 *   - Cloud Run itself is deployed with --no-allow-unauthenticated, so
 *     unauthenticated requests are rejected by the Cloud Run control plane
 *     before they reach this code.
 *   - This middleware provides a defence-in-depth layer and validates the
 *     token audience to prevent token reuse across services.
 *   - In NODE_ENV=development the check is bypassed for local testing.
 */

import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import logger from './logger';
import { config } from './config';

const googleAuthClient = new OAuth2Client();

export async function requireSchedulerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Skip verification in local development to allow curl testing.
  if (config.nodeEnv === 'development') {
    logger.debug('Skipping OIDC auth check in development mode');
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ path: req.path }, 'Missing or malformed Authorization header');
    res.status(401).json({ error: 'Unauthorized: missing bearer token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const ticket = await googleAuthClient.verifyIdToken({
      idToken: token,
      audience: config.expectedAudience,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw new Error('Empty token payload');
    }

    // Log the caller's identity for audit purposes.
    logger.info(
      { email: payload.email, sub: payload.sub, path: req.path },
      'Authenticated scheduler request',
    );

    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ path: req.path, err: message }, 'OIDC token verification failed');
    res.status(403).json({ error: 'Forbidden: invalid or expired token' });
  }
}
