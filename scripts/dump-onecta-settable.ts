/**
 * One-off: list all settable Onecta characteristics per gateway device (inventory for reviewers).
 * Run from repo root: npx ts-node scripts/dump-onecta-settable.ts
 * Requires valid .env (same as daikin-live-smoke).
 *
 * Commit sanitized output under data/ (see data/onecta-settable-inventory.sample.json for shape).
 */

import 'dotenv/config';
import { collectSettableCharacteristicsSnapshot, DaikinClient } from '../src/daikin';
import { config } from '../src/config';
import { createRefreshTokenStore } from '../src/token-store';
import { resolveGatewayDeviceIds } from '../src/device-ids';

async function main(): Promise<void> {
  const refreshTokenStore = createRefreshTokenStore({
    backend: config.daikin.tokenStore.backend,
    bootstrapRefreshToken: config.daikin.bootstrapRefreshToken,
    localFilePath: config.daikin.tokenStore.localFilePath,
    firestoreCollection: config.daikin.tokenStore.firestoreCollection,
    firestoreDocument: config.daikin.tokenStore.firestoreDocument,
  });

  const client = new DaikinClient(
    config.daikin.clientId,
    config.daikin.clientSecret,
    config.daikin.baseUrl,
    config.daikin.authUrl,
    refreshTokenStore,
    config.daikin.writeConcurrency,
    config.daikin.httpPaceMs,
  );

  const ids = await resolveGatewayDeviceIds(client);
  for (const id of ids) {
    const raw = await client.getGatewayDeviceRaw(id);
    const entries = collectSettableCharacteristicsSnapshot(raw);
    console.log(JSON.stringify({ deviceId: id, settableCount: entries.length, entries }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
