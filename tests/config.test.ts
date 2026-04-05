/**
 * Config validation tests.
 *
 * Because config.ts executes loadConfig() at import time, each test that needs
 * a different environment must:
 *   1. Set process.env before importing the module.
 *   2. Call jest.resetModules() so the next import gets a fresh module instance.
 */

/** Minimal valid environment that satisfies all required fields. */
const VALID_ENV: Record<string, string> = {
  DAIKIN_CLIENT_ID: 'test-client-id',
  DAIKIN_CLIENT_SECRET: 'test-client-secret',
  DAIKIN_REFRESH_TOKEN: 'test-refresh-token',
  DAIKIN_DEVICE_IDS_JSON: '["device-1","device-2"]',
  DAIKIN_HUMIDITY_LEADER_IDS_JSON: '["device-1"]',
  EXPECTED_AUDIENCE: 'https://my-service-abc-uc.a.run.app',
};

function setEnv(overrides: Record<string, string | undefined>): void {
  // Clear all known env vars first (required + optional).
  for (const key of [
    ...Object.keys(VALID_ENV),
    'PORT', 'NODE_ENV', 'DAIKIN_BASE_URL', 'DAIKIN_AUTH_URL',
    'DRY_DURATION_MINUTES', 'HEAT_TARGET_TEMP_C',
    'HUMIDITY_HIGH_THRESHOLD', 'HUMIDITY_LOW_THRESHOLD',
    'MODE_STRATEGY', 'LOG_LEVEL',
  ]) {
    delete process.env[key];
  }
  // Apply the base valid env.
  Object.assign(process.env, VALID_ENV);
  // Apply overrides: explicitly delete keys whose value is undefined,
  // otherwise Node.js would stringify undefined as the literal "undefined".
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadConfig(): Promise<typeof import('../src/config')> {
  jest.resetModules();
  return import('../src/config');
}

// ── Valid configuration ───────────────────────────────────────────────────────

describe('config — valid environment', () => {
  beforeEach(() => setEnv({}));

  it('parses device IDs from JSON', async () => {
    const { config } = await loadConfig();
    expect(config.daikin.deviceIds).toEqual(['device-1', 'device-2']);
  });

  it('parses humidity leader IDs from JSON', async () => {
    const { config } = await loadConfig();
    expect(config.daikin.humidityLeaderIds).toEqual(['device-1']);
  });

  it('uses default port 8080', async () => {
    const { config } = await loadConfig();
    expect(config.port).toBe(8080);
  });

  it('uses default mode strategy "timer"', async () => {
    const { config } = await loadConfig();
    expect(config.modeStrategy).toBe('timer');
  });

  it('uses default heat target 16°C', async () => {
    const { config } = await loadConfig();
    expect(config.heatTargetTempC).toBe(16);
  });

  it('uses default humidity thresholds 70/60', async () => {
    const { config } = await loadConfig();
    expect(config.humidityHighThreshold).toBe(70);
    expect(config.humidityLowThreshold).toBe(60);
  });

  it('respects custom PORT', async () => {
    setEnv({ PORT: '9090' });
    const { config } = await loadConfig();
    expect(config.port).toBe(9090);
  });

  it('respects humidity strategy override', async () => {
    setEnv({ MODE_STRATEGY: 'humidity' });
    const { config } = await loadConfig();
    expect(config.modeStrategy).toBe('humidity');
  });
});

// ── Missing required fields ───────────────────────────────────────────────────

describe('config — missing required fields', () => {
  it('throws when DAIKIN_CLIENT_ID is missing', async () => {
    setEnv({ DAIKIN_CLIENT_ID: undefined });
    await expect(loadConfig()).rejects.toThrow(/DAIKIN_CLIENT_ID/);
  });

  it('throws when DAIKIN_CLIENT_SECRET is missing', async () => {
    setEnv({ DAIKIN_CLIENT_SECRET: undefined });
    await expect(loadConfig()).rejects.toThrow(/DAIKIN_CLIENT_SECRET/);
  });

  it('throws when DAIKIN_REFRESH_TOKEN is missing', async () => {
    setEnv({ DAIKIN_REFRESH_TOKEN: undefined });
    await expect(loadConfig()).rejects.toThrow(/DAIKIN_REFRESH_TOKEN/);
  });

  it('throws when EXPECTED_AUDIENCE is missing', async () => {
    setEnv({ EXPECTED_AUDIENCE: undefined });
    await expect(loadConfig()).rejects.toThrow(/EXPECTED_AUDIENCE/);
  });

  it('throws when DAIKIN_DEVICE_IDS_JSON is missing', async () => {
    setEnv({ DAIKIN_DEVICE_IDS_JSON: undefined });
    await expect(loadConfig()).rejects.toThrow();
  });
});

// ── Malformed JSON ────────────────────────────────────────────────────────────

describe('config — malformed JSON fields', () => {
  it('throws when DAIKIN_DEVICE_IDS_JSON is not valid JSON', async () => {
    setEnv({ DAIKIN_DEVICE_IDS_JSON: 'not-json' });
    await expect(loadConfig()).rejects.toThrow();
  });

  it('throws when DAIKIN_DEVICE_IDS_JSON is a JSON object instead of an array', async () => {
    setEnv({ DAIKIN_DEVICE_IDS_JSON: '{"id":"x"}' });
    await expect(loadConfig()).rejects.toThrow();
  });
});

// ── Hysteresis validation ─────────────────────────────────────────────────────

describe('config — hysteresis threshold validation', () => {
  it('throws when LOW threshold >= HIGH threshold', async () => {
    setEnv({ HUMIDITY_HIGH_THRESHOLD: '60', HUMIDITY_LOW_THRESHOLD: '60' });
    await expect(loadConfig()).rejects.toThrow(/HUMIDITY_LOW_THRESHOLD/);
  });

  it('throws when LOW threshold > HIGH threshold', async () => {
    setEnv({ HUMIDITY_HIGH_THRESHOLD: '55', HUMIDITY_LOW_THRESHOLD: '60' });
    await expect(loadConfig()).rejects.toThrow(/HUMIDITY_LOW_THRESHOLD/);
  });

  it('accepts valid thresholds where LOW < HIGH', async () => {
    setEnv({ HUMIDITY_HIGH_THRESHOLD: '75', HUMIDITY_LOW_THRESHOLD: '55' });
    const { config } = await loadConfig();
    expect(config.humidityHighThreshold).toBe(75);
    expect(config.humidityLowThreshold).toBe(55);
  });
});
