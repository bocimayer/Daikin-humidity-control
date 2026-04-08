#!/usr/bin/env node
/**
 * One-time Daikin Onecta OIDC onboarding: print authorize URL, exchange code for tokens.
 *
 * Cross-references:
 *   - Runtime token refresh: ../../src/daikin.ts (grant_type=refresh_token)
 *   - Env template: ../../.env.example
 *   - Redirect landing page: ../../oauth-stub/server.js
 *
 * Usage (from repo root, after filling .env):
 *   node setup/oauth-onboarding/onecta-oauth-setup.js authorize-url
 *   node setup/oauth-onboarding/onecta-oauth-setup.js exchange <authorization_code>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

const DEFAULT_AUTHORIZE_BASE = 'https://idp.onecta.daikineurope.com/v1/oidc/authorize';
const DEFAULT_TOKEN_URL = 'https://idp.onecta.daikineurope.com/v1/oidc/token';
const DEFAULT_SCOPE = 'openid onecta:basic.integration';

/**
 * Load .env into process.env without overwriting existing variables (shell wins).
 */
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
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

function printAuthorizeUrl() {
  const clientId = requireEnv('DAIKIN_CLIENT_ID');
  const redirectUri = requireEnv('DAIKIN_REDIRECT_URI');
  const authorizeBase =
    process.env.DAIKIN_AUTHORIZE_URL?.trim() || DEFAULT_AUTHORIZE_BASE;

  const u = new URL(authorizeBase);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', DEFAULT_SCOPE);

  console.log('\nOpen this URL in a browser (log in and approve):\n');
  console.log(u.toString());
  console.log('\nAfter redirect, copy the "code" query parameter and run:\n');
  console.log(
    `  node setup/oauth-onboarding/onecta-oauth-setup.js exchange '<code>'\n`,
  );
}

/**
 * POST application/x-www-form-urlencoded to token URL (no extra deps).
 */
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

async function exchangeCode(code) {
  const clientId = requireEnv('DAIKIN_CLIENT_ID');
  const clientSecret = requireEnv('DAIKIN_CLIENT_SECRET');
  const redirectUri = requireEnv('DAIKIN_REDIRECT_URI');
  const tokenUrl = process.env.DAIKIN_AUTH_URL?.trim() || DEFAULT_TOKEN_URL;

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code: code.trim(),
    redirect_uri: redirectUri,
  });

  console.log(`POST ${tokenUrl} (authorization_code grant)…\n`);

  const { status, body } = await postForm(tokenUrl, params.toString());

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    console.error(`HTTP ${status} — non-JSON response:\n${body}`);
    process.exit(1);
  }

  if (status < 200 || status >= 300) {
    console.error('Token endpoint returned an error:\n');
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }

  console.log('Response:\n');
  console.log(JSON.stringify(json, null, 2));
  console.log('');

  if (json.refresh_token) {
    console.log('---');
    console.log('Set this in .env and in Secret Manager (DAIKIN_REFRESH_TOKEN):\n');
    console.log(json.refresh_token);
    console.log('');
  } else {
    console.warn('No refresh_token in response — check scope and portal app settings.');
  }
}

function main() {
  loadDotEnv(ENV_PATH);

  const [, , cmd, arg] = process.argv;

  if (cmd === 'authorize-url' || cmd === 'url') {
    printAuthorizeUrl();
    return;
  }

  if (cmd === 'exchange') {
    const code = arg || process.env.DAIKIN_AUTH_CODE;
    if (!code || !code.trim()) {
      console.error(
        'Usage: node setup/oauth-onboarding/onecta-oauth-setup.js exchange <authorization_code>',
      );
      console.error('Or set DAIKIN_AUTH_CODE in the environment.');
      process.exit(1);
    }
    exchangeCode(code).catch((err) => {
      console.error(err);
      process.exit(1);
    });
    return;
  }

  console.error(`Usage:
  node setup/oauth-onboarding/onecta-oauth-setup.js authorize-url
  node setup/oauth-onboarding/onecta-oauth-setup.js exchange <code>

Optional .env (repo root): DAIKIN_CLIENT_ID, DAIKIN_CLIENT_SECRET, DAIKIN_REDIRECT_URI
Optional: DAIKIN_AUTH_URL (default ${DEFAULT_TOKEN_URL})
Optional: DAIKIN_AUTHORIZE_URL (default ${DEFAULT_AUTHORIZE_BASE})
`);
  process.exit(1);
}

main();
