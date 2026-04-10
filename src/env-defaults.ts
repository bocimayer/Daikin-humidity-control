import { TokenStoreBackend } from './token-store';

export const DEFAULT_PORT = '8080';
export const DEFAULT_NODE_ENV = 'development';
export const DEFAULT_DAIKIN_BASE_URL = 'https://api.onecta.daikineurope.com';
export const DEFAULT_DAIKIN_AUTH_URL = 'https://idp.onecta.daikineurope.com/v1/oidc/token';
export const DEFAULT_FIRESTORE_COLLECTION = 'oauth_tokens';
export const DEFAULT_FIRESTORE_DOCUMENT = 'daikin_onecta';
export const DEFAULT_DRY_DURATION_MINUTES = 120;
export const DEFAULT_HEAT_TARGET_TEMP_C = 16;
export const DEFAULT_HUMIDITY_HIGH_THRESHOLD = 70;
export const DEFAULT_HUMIDITY_LOW_THRESHOLD = 60;
export const DEFAULT_MODE_STRATEGY = 'timer' as const;
export const DEFAULT_LOG_LEVEL = 'info' as const;

export function resolveDefaultTokenStoreBackend(nodeEnv: string): TokenStoreBackend {
  return nodeEnv === 'production' ? 'firestore' : 'local-file';
}

export function isProductionNodeEnv(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}
