import { z } from 'zod';
import { resolveDefaultTokenFilePath, TokenStoreBackend } from './token-store';
import {
  DEFAULT_DAIKIN_AUTH_URL,
  DEFAULT_DAIKIN_BASE_URL,
  DEFAULT_DRY_DURATION_MINUTES,
  DEFAULT_FIRESTORE_COLLECTION,
  DEFAULT_FIRESTORE_DOCUMENT,
  DEFAULT_HEAT_TARGET_TEMP_C,
  DEFAULT_HUMIDITY_HIGH_THRESHOLD,
  DEFAULT_HUMIDITY_LOW_THRESHOLD,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MODE_STRATEGY,
  DEFAULT_NODE_ENV,
  DEFAULT_PORT,
  resolveDefaultTokenStoreBackend,
} from './env-defaults';

function optionalTrimmedString() {
  return z.preprocess((val) => {
    if (typeof val !== 'string') return val;
    const trimmed = val.trim();
    return trimmed === '' ? undefined : trimmed;
  }, z.string().optional());
}

const EnvSchema = z.object({
  PORT: z.string().default(DEFAULT_PORT),
  NODE_ENV: z.string().default(DEFAULT_NODE_ENV),

  DAIKIN_CLIENT_ID: z.string().min(1, 'DAIKIN_CLIENT_ID is required'),
  DAIKIN_CLIENT_SECRET: z.string().min(1, 'DAIKIN_CLIENT_SECRET is required'),
  DAIKIN_REFRESH_TOKEN: optionalTrimmedString(),
  DAIKIN_BASE_URL: z.string().url().default(DEFAULT_DAIKIN_BASE_URL),
  DAIKIN_AUTH_URL: z
    .string()
    .url()
    .default(DEFAULT_DAIKIN_AUTH_URL),
  DAIKIN_TOKEN_STORE: z.enum(['local-file', 'firestore']).optional(),
  DAIKIN_TOKEN_FILE_PATH: optionalTrimmedString(),
  DAIKIN_FIRESTORE_COLLECTION: z.string().default(DEFAULT_FIRESTORE_COLLECTION),
  DAIKIN_FIRESTORE_DOCUMENT: z.string().default(DEFAULT_FIRESTORE_DOCUMENT),

  DRY_DURATION_MINUTES: z.coerce.number().int().positive().default(DEFAULT_DRY_DURATION_MINUTES),
  HEAT_TARGET_TEMP_C: z.coerce.number().min(5).max(30).default(DEFAULT_HEAT_TARGET_TEMP_C),
  HUMIDITY_HIGH_THRESHOLD: z.coerce.number().min(1).max(100).default(DEFAULT_HUMIDITY_HIGH_THRESHOLD),
  HUMIDITY_LOW_THRESHOLD: z.coerce.number().min(1).max(100).default(DEFAULT_HUMIDITY_LOW_THRESHOLD),

  MODE_STRATEGY: z.enum(['timer', 'humidity']).default(DEFAULT_MODE_STRATEGY),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default(DEFAULT_LOG_LEVEL),

  // Must match the Cloud Run service URL. Used to verify the OIDC token audience.
  // In development, can be any non-empty string (auth is skipped).
  EXPECTED_AUDIENCE: z.string().min(1, 'EXPECTED_AUDIENCE is required (Cloud Run service URL)'),
});

export type AppConfig = {
  port: number;
  nodeEnv: string;
  daikin: {
    clientId: string;
    clientSecret: string;
    bootstrapRefreshToken?: string;
    baseUrl: string;
    authUrl: string;
    tokenStore: {
      backend: TokenStoreBackend;
      localFilePath: string;
      firestoreCollection: string;
      firestoreDocument: string;
    };
  };
  dryDurationMinutes: number;
  heatTargetTempC: number;
  humidityHighThreshold: number;
  humidityLowThreshold: number;
  modeStrategy: 'timer' | 'humidity';
  logLevel: string;
  expectedAudience: string;
};

function loadConfig(): AppConfig {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const messages = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${messages}`);
  }

  const env = result.data;
  const tokenStoreBackend = env.DAIKIN_TOKEN_STORE ?? resolveDefaultTokenStoreBackend(env.NODE_ENV);
  const localTokenFilePath = env.DAIKIN_TOKEN_FILE_PATH ?? resolveDefaultTokenFilePath();

  if (env.HUMIDITY_LOW_THRESHOLD >= env.HUMIDITY_HIGH_THRESHOLD) {
    throw new Error(
      `HUMIDITY_LOW_THRESHOLD (${env.HUMIDITY_LOW_THRESHOLD}) must be less than HUMIDITY_HIGH_THRESHOLD (${env.HUMIDITY_HIGH_THRESHOLD})`,
    );
  }

  return {
    port: parseInt(env.PORT, 10),
    nodeEnv: env.NODE_ENV,
    daikin: {
      clientId: env.DAIKIN_CLIENT_ID,
      clientSecret: env.DAIKIN_CLIENT_SECRET,
      bootstrapRefreshToken: env.DAIKIN_REFRESH_TOKEN,
      baseUrl: env.DAIKIN_BASE_URL,
      authUrl: env.DAIKIN_AUTH_URL,
      tokenStore: {
        backend: tokenStoreBackend,
        localFilePath: localTokenFilePath,
        firestoreCollection: env.DAIKIN_FIRESTORE_COLLECTION,
        firestoreDocument: env.DAIKIN_FIRESTORE_DOCUMENT,
      },
    },
    dryDurationMinutes: env.DRY_DURATION_MINUTES,
    heatTargetTempC: env.HEAT_TARGET_TEMP_C,
    humidityHighThreshold: env.HUMIDITY_HIGH_THRESHOLD,
    humidityLowThreshold: env.HUMIDITY_LOW_THRESHOLD,
    modeStrategy: env.MODE_STRATEGY,
    logLevel: env.LOG_LEVEL,
    expectedAudience: env.EXPECTED_AUDIENCE,
  };
}

export const config: AppConfig = loadConfig();
