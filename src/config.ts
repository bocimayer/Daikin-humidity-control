import { z } from 'zod';

/**
 * Parses a JSON array of strings from an environment variable.
 * Fails fast with a descriptive error if the value is missing or malformed.
 */
function jsonStringArray(envKey: string): z.ZodEffects<z.ZodString, string[], string> {
  return z.string().transform((val, ctx) => {
    try {
      const parsed = JSON.parse(val) as unknown;
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${envKey} must be a JSON array of strings, e.g. ["id1","id2"]`,
        });
        return z.NEVER;
      }
      return parsed as string[];
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envKey} is not valid JSON`,
      });
      return z.NEVER;
    }
  });
}

const EnvSchema = z.object({
  PORT: z.string().default('8080'),
  NODE_ENV: z.string().default('development'),

  DAIKIN_CLIENT_ID: z.string().min(1, 'DAIKIN_CLIENT_ID is required'),
  DAIKIN_CLIENT_SECRET: z.string().min(1, 'DAIKIN_CLIENT_SECRET is required'),
  DAIKIN_REFRESH_TOKEN: z.string().min(1, 'DAIKIN_REFRESH_TOKEN is required'),
  DAIKIN_BASE_URL: z.string().url().default('https://api.onecta.daikineurope.com'),
  DAIKIN_AUTH_URL: z
    .string()
    .url()
    .default('https://idp.onecta.daikineurope.com/v1/oidc/token'),

  DAIKIN_DEVICE_IDS_JSON: jsonStringArray('DAIKIN_DEVICE_IDS_JSON'),
  DAIKIN_HUMIDITY_LEADER_IDS_JSON: jsonStringArray('DAIKIN_HUMIDITY_LEADER_IDS_JSON'),

  DRY_DURATION_MINUTES: z.coerce.number().int().positive().default(120),
  HEAT_TARGET_TEMP_C: z.coerce.number().min(5).max(30).default(16),
  HUMIDITY_HIGH_THRESHOLD: z.coerce.number().min(1).max(100).default(70),
  HUMIDITY_LOW_THRESHOLD: z.coerce.number().min(1).max(100).default(60),

  MODE_STRATEGY: z.enum(['timer', 'humidity']).default('timer'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

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
    refreshToken: string;
    baseUrl: string;
    authUrl: string;
    deviceIds: string[];
    humidityLeaderIds: string[];
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
      refreshToken: env.DAIKIN_REFRESH_TOKEN,
      baseUrl: env.DAIKIN_BASE_URL,
      authUrl: env.DAIKIN_AUTH_URL,
      deviceIds: env.DAIKIN_DEVICE_IDS_JSON,
      humidityLeaderIds: env.DAIKIN_HUMIDITY_LEADER_IDS_JSON,
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
