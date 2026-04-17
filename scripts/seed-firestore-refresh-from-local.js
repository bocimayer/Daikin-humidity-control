#!/usr/bin/env node
/**
 * Copy the Daikin refresh token from the local file store into Firestore
 * (same document shape as runtime: refreshToken, updatedAt, source).
 *
 * Use when local Onecta already works (refresh-token.json populated) and
 * production Cloud Run uses DAIKIN_TOKEN_STORE=firestore but the document is empty.
 *
 * Requires Application Default Credentials for the target GCP project, e.g.:
 *   gcloud auth application-default login
 *
 * Env:
 *   GOOGLE_CLOUD_PROJECT  (required) — e.g. tihany-daikin-humidity
 *   SOURCE_TOKEN_FILE     (optional) — path to local JSON; default: same as app local-file default
 *   DAIKIN_FIRESTORE_COLLECTION (optional, default oauth_tokens)
 *   DAIKIN_FIRESTORE_DOCUMENT   (optional, default daikin_onecta)
 *
 * Cross-references:
 *   - Firestore writer: ../src/token-store.ts
 *   - OAuth exchange: ../setup/oauth-onboarding/token-store.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Firestore } = require('@google-cloud/firestore');

function defaultLocalTokenPath() {
  const baseDir = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(baseDir, 'daikin-humidity-control', 'refresh-token.json');
}

function main() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) {
    console.error('Missing GOOGLE_CLOUD_PROJECT (target GCP project id).');
    process.exit(1);
  }

  const sourcePath =
    process.env.SOURCE_TOKEN_FILE?.trim() ||
    process.env.DAIKIN_TOKEN_FILE_PATH?.trim() ||
    defaultLocalTokenPath();

  const collection = process.env.DAIKIN_FIRESTORE_COLLECTION?.trim() || 'oauth_tokens';
  const documentId = process.env.DAIKIN_FIRESTORE_DOCUMENT?.trim() || 'daikin_onecta';

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source token file not found: ${sourcePath}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse JSON from ${sourcePath}: ${e.message}`);
    process.exit(1);
  }

  const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken.trim() : '';
  if (!refreshToken) {
    console.error(`No refreshToken string in ${sourcePath}`);
    process.exit(1);
  }

  const firestore = new Firestore({ projectId });
  const docRef = firestore.collection(collection).doc(documentId);

  return docRef
    .set(
      {
        refreshToken,
        updatedAt: new Date().toISOString(),
        source: 'seed-firestore-refresh-from-local',
      },
      { merge: true },
    )
    .then(() => {
      console.log(
        `OK: wrote refresh token metadata to Firestore project=${projectId} path=${collection}/${documentId} (token not printed).`,
      );
    });
}

main().catch((err) => {
  console.error('FAILED:', err.message || String(err));
  process.exit(1);
});
