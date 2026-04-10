#!/usr/bin/env node
/**
 * Fetch a short-lived access token from the Onecta token endpoint using
 * grant_type=refresh_token (same as src/daikin.ts).
 *
 * Reads repo-root .env for static credentials and token-store settings.
 * It prefers the persisted token store and only falls back to DAIKIN_REFRESH_TOKEN
 * as a one-time bootstrap value.
 *
 * Usage (from repo root):
 *   node setup/oauth-onboarding/get-access-token.js
 *
 * Cross-references:
 *   - Runtime refresh: ../../src/daikin.ts
 *   - OAuth onboarding: ./onecta-oauth-setup.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const { describeTokenStore, getTokenStoreConfig, loadRefreshToken, saveRefreshToken } = require('./token-store');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const DEFAULT_TOKEN_URL = 'https://idp.onecta.daikineurope.com/v1/oidc/token';

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    console.error(`Missing ${name}. Set it in .env or the environment.`);
    process.exit(1);
  }
  return v.trim();
}

function postForm(urlString, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();

    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  loadDotEnv(ENV_PATH);
  const tokenStoreDescription = describeTokenStore(getTokenStoreConfig());

  const clientId = requireEnv('DAIKIN_CLIENT_ID');
  const clientSecret = requireEnv('DAIKIN_CLIENT_SECRET');
  const refreshToken =
    (await loadRefreshToken()) ||
    process.env.DAIKIN_REFRESH_TOKEN?.trim() ||
    '';
  if (!refreshToken) {
    console.error(
      `Missing Daikin refresh token. Run oauth-exchange first so it can be stored in ${tokenStoreDescription}, or provide DAIKIN_REFRESH_TOKEN as a one-time bootstrap value.`,
    );
    process.exit(1);
  }
  const tokenUrl = process.env.DAIKIN_AUTH_URL?.trim() || DEFAULT_TOKEN_URL;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  console.error(`POST ${tokenUrl} (refresh_token grant)…\n`);
  console.error(`Using token source: ${tokenStoreDescription}\n`);

  const { status, body } = await postForm(tokenUrl, params.toString());

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    console.error(`HTTP ${status} — non-JSON body:\n${body.slice(0, 500)}`);
    process.exit(1);
  }

  if (status < 200 || status >= 300) {
    console.error('Token endpoint error:\n');
    console.error(JSON.stringify(json, null, 2));
    if (json.error === 'invalid_grant') {
      const rt = refreshToken;
      console.error(`
Why invalid_grant on refresh_token grant:
  • The token store must contain the latest "refresh_token" string from the TOKEN response
    (after you run: npm run daikin:oauth-exchange -- '<authorization_code>').
  • It is NOT the browser redirect "code=" value. That value is a one-time
    authorization code: use it only with oauth-exchange, then copy refresh_token from JSON.
  • Do not store "code=" as if it were a refresh token.
  • Auth codes expire quickly and are single-use; exchange immediately.
`);
      if (rt.includes('code=') || rt.includes('&state=')) {
        console.error(
          'Your bootstrap DAIKIN_REFRESH_TOKEN looks like a URL/query — use the refresh_token from exchange JSON instead.\n',
        );
      }
    }
    process.exit(1);
  }

  if (!json.access_token) {
    console.error('Response has no access_token:\n', JSON.stringify(json, null, 2));
    process.exit(1);
  }

  console.log('--- access_token (Authorization: Bearer <this value>) ---');
  console.log(json.access_token);
  console.log('');
  console.log('--- meta (safe to share: type + expiry only) ---');
  console.log(
    JSON.stringify(
      {
        token_type: json.token_type,
        expires_in: json.expires_in,
      },
      null,
      2,
    ),
  );
  if (json.refresh_token) {
    const persistedTo = await saveRefreshToken(json.refresh_token, 'refresh-grant');
    console.log('');
    console.log(`--- NEW refresh_token persisted to ${persistedTo} ---`);
  }
  console.error('\nDo not commit tokens or paste access_token in public chats.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
