'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Firestore } = require('@google-cloud/firestore');

function resolveDefaultTokenFilePath() {
  const baseDir = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(baseDir, 'daikin-humidity-control', 'refresh-token.json');
}

function getTokenStoreConfig() {
  const backend =
    process.env.DAIKIN_TOKEN_STORE?.trim() ||
    (process.env.NODE_ENV === 'production' ? 'firestore' : 'local-file');
  return {
    backend,
    localFilePath: process.env.DAIKIN_TOKEN_FILE_PATH?.trim() || resolveDefaultTokenFilePath(),
    firestoreCollection: process.env.DAIKIN_FIRESTORE_COLLECTION?.trim() || 'oauth_tokens',
    firestoreDocument: process.env.DAIKIN_FIRESTORE_DOCUMENT?.trim() || 'daikin_onecta',
  };
}

function describeTokenStore(config) {
  if (config.backend === 'firestore') {
    return `Firestore (${config.firestoreCollection}/${config.firestoreDocument})`;
  }
  return `local file (${config.localFilePath})`;
}

function saveLocalFileRefreshToken(filePath, refreshToken, source) {
  const payload = {
    refreshToken,
    updatedAt: new Date().toISOString(),
    source,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function saveFirestoreRefreshToken(config, refreshToken, source) {
  const firestore = new Firestore();
  await firestore.collection(config.firestoreCollection).doc(config.firestoreDocument).set(
    {
      refreshToken,
      updatedAt: new Date().toISOString(),
      source,
    },
    { merge: true },
  );
}

async function saveRefreshToken(refreshToken, source) {
  const config = getTokenStoreConfig();
  const trimmed = String(refreshToken || '').trim();
  if (!trimmed) {
    throw new Error('Cannot persist an empty Daikin refresh token.');
  }

  if (config.backend === 'firestore') {
    await saveFirestoreRefreshToken(config, trimmed, source);
    return describeTokenStore(config);
  }

  saveLocalFileRefreshToken(config.localFilePath, trimmed, source);
  return describeTokenStore(config);
}

function loadRefreshTokenFromLocalFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.refreshToken !== 'string') {
    throw new Error(`Token store file ${filePath} does not contain a valid refreshToken.`);
  }
  return parsed.refreshToken.trim();
}

async function loadRefreshToken() {
  const config = getTokenStoreConfig();
  if (config.backend === 'firestore') {
    const firestore = new Firestore();
    const snapshot = await firestore
      .collection(config.firestoreCollection)
      .doc(config.firestoreDocument)
      .get();
    if (!snapshot.exists) {
      return null;
    }
    const refreshToken = snapshot.get('refreshToken');
    return typeof refreshToken === 'string' ? refreshToken.trim() : null;
  }

  return loadRefreshTokenFromLocalFile(config.localFilePath);
}

module.exports = {
  describeTokenStore,
  getTokenStoreConfig,
  loadRefreshToken,
  resolveDefaultTokenFilePath,
  saveRefreshToken,
};
