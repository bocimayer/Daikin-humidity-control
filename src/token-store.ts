import { Firestore } from '@google-cloud/firestore';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import logger from './logger';

export type TokenStoreBackend = 'local-file' | 'firestore';

export type TokenStoreConfig = {
  backend: TokenStoreBackend;
  bootstrapRefreshToken?: string;
  localFilePath: string;
  firestoreCollection: string;
  firestoreDocument: string;
};

export interface RefreshTokenStore {
  getRefreshToken(): Promise<string>;
  saveRefreshToken(refreshToken: string, source: string): Promise<void>;
  describe(): string;
}

type StoredTokenFile = {
  refreshToken: string;
  updatedAt: string;
  source: string;
};

function defaultLocalTokenPath(): string {
  const baseDir =
    process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(baseDir, 'daikin-humidity-control', 'refresh-token.json');
}

function assertNonEmptyRefreshToken(refreshToken: string | undefined, source: string): string {
  const trimmed = refreshToken?.trim();
  if (!trimmed) {
    throw new Error(`Daikin refresh token from ${source} is missing or empty.`);
  }
  return trimmed;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

class LocalFileRefreshTokenStore implements RefreshTokenStore {
  constructor(
    private readonly filePath: string,
    private readonly bootstrapRefreshToken?: string,
  ) {}

  describe(): string {
    return `local file (${this.filePath})`;
  }

  async getRefreshToken(): Promise<string> {
    const stored = await this.readStoredToken();
    if (stored) {
      return assertNonEmptyRefreshToken(stored.refreshToken, this.describe());
    }

    if (this.bootstrapRefreshToken?.trim()) {
      const refreshToken = assertNonEmptyRefreshToken(
        this.bootstrapRefreshToken,
        'DAIKIN_REFRESH_TOKEN bootstrap env',
      );
      await this.saveRefreshToken(refreshToken, 'bootstrap-env');
      logger.info({ tokenStore: this.describe() }, 'Bootstrapped Daikin refresh token into local token store');
      return refreshToken;
    }

    throw new Error(
      `No Daikin refresh token found in ${this.describe()} and no DAIKIN_REFRESH_TOKEN bootstrap value was provided.`,
    );
  }

  async saveRefreshToken(refreshToken: string, source: string): Promise<void> {
    const trimmed = assertNonEmptyRefreshToken(refreshToken, `${this.describe()} save`);
    const payload: StoredTokenFile = {
      refreshToken: trimmed,
      updatedAt: new Date().toISOString(),
      source,
    };
    await ensureParentDirectory(this.filePath);
    await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  private async readStoredToken(): Promise<StoredTokenFile | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredTokenFile>;
      if (typeof parsed.refreshToken !== 'string') {
        throw new Error('refreshToken field is missing');
      }
      return {
        refreshToken: parsed.refreshToken,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
      };
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return null;
      }
      throw new Error(`Failed to read Daikin token store file ${this.filePath}: ${nodeErr.message}`);
    }
  }
}

class FirestoreRefreshTokenStore implements RefreshTokenStore {
  private readonly firestore = new Firestore();

  constructor(
    private readonly collectionName: string,
    private readonly documentId: string,
    private readonly bootstrapRefreshToken?: string,
  ) {}

  describe(): string {
    return `Firestore (${this.collectionName}/${this.documentId})`;
  }

  async getRefreshToken(): Promise<string> {
    const docRef = this.firestore.collection(this.collectionName).doc(this.documentId);
    const snapshot = await docRef.get();

    if (snapshot.exists) {
      const refreshToken = snapshot.get('refreshToken');
      return assertNonEmptyRefreshToken(
        typeof refreshToken === 'string' ? refreshToken : undefined,
        this.describe(),
      );
    }

    if (this.bootstrapRefreshToken?.trim()) {
      const refreshToken = assertNonEmptyRefreshToken(
        this.bootstrapRefreshToken,
        'DAIKIN_REFRESH_TOKEN bootstrap env',
      );
      await this.saveRefreshToken(refreshToken, 'bootstrap-env');
      logger.info({ tokenStore: this.describe() }, 'Bootstrapped Daikin refresh token into Firestore');
      return refreshToken;
    }

    throw new Error(
      `No Daikin refresh token found in ${this.describe()} and no DAIKIN_REFRESH_TOKEN bootstrap value was provided.`,
    );
  }

  async saveRefreshToken(refreshToken: string, source: string): Promise<void> {
    const trimmed = assertNonEmptyRefreshToken(refreshToken, `${this.describe()} save`);
    const docRef = this.firestore.collection(this.collectionName).doc(this.documentId);
    await docRef.set(
      {
        refreshToken: trimmed,
        updatedAt: new Date().toISOString(),
        source,
      },
      { merge: true },
    );
  }
}

export function createRefreshTokenStore(config: TokenStoreConfig): RefreshTokenStore {
  if (config.backend === 'firestore') {
    return new FirestoreRefreshTokenStore(
      config.firestoreCollection,
      config.firestoreDocument,
      config.bootstrapRefreshToken,
    );
  }

  return new LocalFileRefreshTokenStore(
    config.localFilePath || defaultLocalTokenPath(),
    config.bootstrapRefreshToken,
  );
}

export function resolveDefaultTokenFilePath(): string {
  return defaultLocalTokenPath();
}
