import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createRefreshTokenStore } from '../src/token-store';

function tempTokenFilePath(): string {
  const unique = `daikin-token-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  return path.join(os.tmpdir(), unique);
}

describe('token store — local file backend', () => {
  it('bootstraps from the bootstrap token and persists it for the next process', async () => {
    const filePath = tempTokenFilePath();

    const firstStore = createRefreshTokenStore({
      backend: 'local-file',
      bootstrapRefreshToken: 'bootstrap-token',
      localFilePath: filePath,
      firestoreCollection: 'unused',
      firestoreDocument: 'unused',
    });

    await expect(firstStore.getRefreshToken()).resolves.toBe('bootstrap-token');

    const raw = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(raw).refreshToken).toBe('bootstrap-token');

    const secondStore = createRefreshTokenStore({
      backend: 'local-file',
      localFilePath: filePath,
      firestoreCollection: 'unused',
      firestoreDocument: 'unused',
    });

    await expect(secondStore.getRefreshToken()).resolves.toBe('bootstrap-token');

    await fs.rm(filePath, { force: true });
  });

  it('persists rotated tokens so a fresh store instance reads the latest value', async () => {
    const filePath = tempTokenFilePath();

    const firstStore = createRefreshTokenStore({
      backend: 'local-file',
      bootstrapRefreshToken: 'initial-token',
      localFilePath: filePath,
      firestoreCollection: 'unused',
      firestoreDocument: 'unused',
    });

    await firstStore.getRefreshToken();
    await firstStore.saveRefreshToken('rotated-token', 'test');

    const secondStore = createRefreshTokenStore({
      backend: 'local-file',
      localFilePath: filePath,
      firestoreCollection: 'unused',
      firestoreDocument: 'unused',
    });

    await expect(secondStore.getRefreshToken()).resolves.toBe('rotated-token');

    await fs.rm(filePath, { force: true });
  });

  it('throws when no bootstrap token and no stored token exist', async () => {
    const filePath = tempTokenFilePath();

    const store = createRefreshTokenStore({
      backend: 'local-file',
      localFilePath: filePath,
      firestoreCollection: 'unused',
      firestoreDocument: 'unused',
    });

    await expect(store.getRefreshToken()).rejects.toThrow(/No Daikin refresh token found/);
    await fs.rm(filePath, { force: true });
  });
});
