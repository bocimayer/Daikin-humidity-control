import { TokenStoreBackend } from './token-store';

export const DEFAULT_PORT = '8080';
export const DEFAULT_NODE_ENV = 'development';
export const DEFAULT_DAIKIN_BASE_URL = 'https://api.onecta.daikineurope.com';
export const DEFAULT_DAIKIN_AUTH_URL = 'https://idp.onecta.daikineurope.com/v1/oidc/token';
export const DEFAULT_FIRESTORE_COLLECTION = 'oauth_tokens';
export const DEFAULT_FIRESTORE_DOCUMENT = 'daikin_onecta';
/** Firestore collection for per-device pre-dry Onecta snapshots (restore after dry-stop). */
export const DEFAULT_DAIKIN_RESTORE_COLLECTION = 'device_restore_state';
export const DEFAULT_DRY_DURATION_MINUTES = 120;
export const DEFAULT_HEAT_TARGET_TEMP_C = 16;
export const DEFAULT_HUMIDITY_HIGH_THRESHOLD = 70;
export const DEFAULT_HUMIDITY_LOW_THRESHOLD = 60;
export const DEFAULT_MODE_STRATEGY = 'timer' as const;
export const DEFAULT_LOG_LEVEL = 'info' as const;
/** Max concurrent Onecta gateway HTTP calls (GET+PATCH) per process (1 = strict serialization). */
export const DEFAULT_DAIKIN_WRITE_CONCURRENCY = 1;
export const MAX_DAIKIN_WRITE_CONCURRENCY = 3;
/**
 * After each gated Onecta GET/PATCH completes, wait this many ms before releasing the gate slot.
 * Keeps a minimum spacing between calls (dry-stop replays many PATCHes; 429 without pacing).
 * Set to 0 to disable. Upper bound enforced in config schema.
 */
export const DEFAULT_DAIKIN_HTTP_PACE_MS = 75;
export const MAX_DAIKIN_HTTP_PACE_MS = 10_000;

export function resolveDefaultTokenStoreBackend(nodeEnv: string): TokenStoreBackend {
  return nodeEnv === 'production' ? 'firestore' : 'local-file';
}

export function isProductionNodeEnv(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}
