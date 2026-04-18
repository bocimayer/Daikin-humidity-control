/**
 * Config validation tests.
 *
 * Because config.ts executes loadConfig() at import time, each test that needs
 * a different environment must:
 *   1. Set process.env before importing the module.
 *   2. Call jest.resetModules() so the next import gets a fresh module instance.
 */

import { DEFAULT_DAIKIN_HTTP_PACE_MS } from '../src/env-defaults';

/** Minimal valid environment that satisfies all required fields. */
const VALID_ENV: Record<string, string> = {
  DAIKIN_CLIENT_ID: 'test-client-id',
  DAIKIN_CLIENT_SECRET: 'test-client-secret',
  DAIKIN_REFRESH_TOKEN: 'test-refresh-token',
  EXPECTED_AUDIENCE: 'https://my-service-abc-uc.a.run.app',
};

function setEnv(overrides: Record<string, string | undefined>): void {
  // Clear all known env vars first (required + optional).
  for (const key of [
    ...Object.keys(VALID_ENV),
    'PORT', 'NODE_ENV', 'DAIKIN_BASE_URL', 'DAIKIN_AUTH_URL',
    'DAIKIN_TOKEN_STORE', 'DAIKIN_TOKEN_FILE_PATH',
    'DAIKIN_FIRESTORE_COLLECTION', 'DAIKIN_FIRESTORE_DOCUMENT', 'DAIKIN_RESTORE_COLLECTION',
    'DRY_DURATION_MINUTES', 'HEAT_TARGET_TEMP_C',
    'HUMIDITY_HIGH_THRESHOLD', 'HUMIDITY_LOW_THRESHOLD',
    'MODE_STRATEGY', 'LOG_LEVEL',
    'NOTIFY_EMAIL',
    'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_SENDER',
    'NOTIFY_WEBHOOK_URL',
    'DAIKIN_WRITE_CONCURRENCY',
    'DAIKIN_HTTP_PACE_MS',
    'AUTOMATION_ENABLED',
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

  it('defaults to local-file token storage in development', async () => {
    const { config } = await loadConfig();
    expect(config.daikin.tokenStore.backend).toBe('local-file');
    expect(config.daikin.bootstrapRefreshToken).toBe('test-refresh-token');
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

  it('defaults to firestore token storage in production', async () => {
    setEnv({ NODE_ENV: 'production' });
    const { config } = await loadConfig();
    expect(config.daikin.tokenStore.backend).toBe('firestore');
  });

  it('respects custom token store settings', async () => {
    setEnv({
      DAIKIN_TOKEN_STORE: 'local-file',
      DAIKIN_TOKEN_FILE_PATH: '/tmp/daikin-refresh.json',
      DAIKIN_FIRESTORE_COLLECTION: 'custom_collection',
      DAIKIN_FIRESTORE_DOCUMENT: 'custom_document',
    });
    const { config } = await loadConfig();
    expect(config.daikin.tokenStore.localFilePath).toBe('/tmp/daikin-refresh.json');
    expect(config.daikin.tokenStore.firestoreCollection).toBe('custom_collection');
    expect(config.daikin.tokenStore.firestoreDocument).toBe('custom_document');
  });

  it('parses optional Gmail + webhook env vars', async () => {
    setEnv({
      NOTIFY_EMAIL: 'ops@example.com',
      GMAIL_OAUTH_CLIENT_ID: 'gmail-client-id',
      GMAIL_OAUTH_CLIENT_SECRET: 'gmail-secret',
      GMAIL_REFRESH_TOKEN: 'gmail-refresh',
      GMAIL_SENDER: 'notify@example.com',
      NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/daikin',
    });
    const { config } = await loadConfig();
    expect(config.notifyEmail).toBe('ops@example.com');
    expect(config.gmailOAuthClientId).toBe('gmail-client-id');
    expect(config.gmailOAuthClientSecret).toBe('gmail-secret');
    expect(config.gmailRefreshToken).toBe('gmail-refresh');
    expect(config.gmailSender).toBe('notify@example.com');
    expect(config.notifyWebhookUrl).toBe('https://hooks.example.com/daikin');
  });

  it('defaults DAIKIN_RESTORE_COLLECTION', async () => {
    const { config } = await loadConfig();
    expect(config.daikinRestoreCollection).toBe('device_restore_state');
  });

  it('defaults DAIKIN_HTTP_PACE_MS for Onecta pacing', async () => {
    const { config } = await loadConfig();
    expect(config.daikin.httpPaceMs).toBe(DEFAULT_DAIKIN_HTTP_PACE_MS);
  });

  it('respects DAIKIN_HTTP_PACE_MS override', async () => {
    setEnv({ DAIKIN_HTTP_PACE_MS: '0' });
    const { config } = await loadConfig();
    expect(config.daikin.httpPaceMs).toBe(0);
  });

  it('defaults AUTOMATION_ENABLED to true', async () => {
    const { config } = await loadConfig();
    expect(config.automationEnabled).toBe(true);
  });

  it('parses AUTOMATION_ENABLED off', async () => {
    setEnv({ AUTOMATION_ENABLED: 'false' });
    const { config } = await loadConfig();
    expect(config.automationEnabled).toBe(false);
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

  it('does not require DAIKIN_REFRESH_TOKEN when another token store will provide it', async () => {
    setEnv({ DAIKIN_REFRESH_TOKEN: undefined });
    const { config } = await loadConfig();
    expect(config.daikin.bootstrapRefreshToken).toBeUndefined();
  });

  it('throws when EXPECTED_AUDIENCE is missing', async () => {
    setEnv({ EXPECTED_AUDIENCE: undefined });
    await expect(loadConfig()).rejects.toThrow(/EXPECTED_AUDIENCE/);
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
