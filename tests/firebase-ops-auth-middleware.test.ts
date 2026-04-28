/**
 * Mocks `firebase-admin` with `jest.doMock` + fresh `process.env` so `config` reloads.
 */

const baseEnv = () => ({
  DAIKIN_CLIENT_ID: 'test-client',
  DAIKIN_CLIENT_SECRET: 'test-secret',
  EXPECTED_AUDIENCE: 'https://svc.example.run.app',
  NODE_ENV: 'production' as const,
  GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
  // Production now requires a non-empty allowlist for /ops; tests that hit token checks need at least one entry.
  ALLOWED_OPS_EMAILS: 'default-allowed@test.com',
});

function getRequireFirebaseOpsAuth() {
  jest.resetModules();
  const verifyIdToken = jest.fn();
  jest.doMock('firebase-admin', () => ({
    apps: [],
    initializeApp: jest.fn(),
    credential: { applicationDefault: jest.fn(() => ({})) },
    auth: jest.fn(() => ({ verifyIdToken })),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('../src/firebase-ops-auth') as typeof import('../src/firebase-ops-auth')).requireFirebaseOpsAuth;
}

function getVerifyIdToken(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const firebaseAdmin = require('firebase-admin') as {
    auth: () => { verifyIdToken: jest.Mock };
  };
  return firebaseAdmin.auth().verifyIdToken;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requireFirebaseOpsAuth', () => {
  it('503 in production when ALLOWED_OPS_EMAILS is empty', () => {
    Object.assign(process.env, baseEnv());
    delete process.env.ALLOWED_OPS_EMAILS;
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return requireFirebaseOpsAuth(
      { get: () => undefined, path: '/scheduler/state' } as never,
      res as never,
      next,
    ).then(() => {
      expect(res.status).toHaveBeenCalledWith(503);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toBe('not_configured');
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('503 in production when GOOGLE_CLOUD_PROJECT / FIREBASE_PROJECT_ID would be empty', () => {
    Object.assign(process.env, baseEnv());
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return requireFirebaseOpsAuth(
      { get: () => undefined, path: '/scheduler/state' } as never,
      res as never,
      next,
    ).then(() => {
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('401 when Authorization Bearer is missing', () => {
    Object.assign(process.env, baseEnv());
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();
    getVerifyIdToken().mockReset();

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return requireFirebaseOpsAuth(
      { get: () => undefined, path: '/scheduler/state' } as never,
      res as never,
      next,
    ).then(() => {
      expect(res.status).toHaveBeenCalledWith(401);
      expect(getVerifyIdToken()).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('403 when verifyIdToken throws', () => {
    Object.assign(process.env, baseEnv());
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();
    getVerifyIdToken().mockRejectedValue(new Error('bad token'));

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return requireFirebaseOpsAuth(
      { get: () => 'Bearer abc', path: '/scheduler/state' } as never,
      res as never,
      next,
    ).then(() => {
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('403 when email not in ALLOWED_OPS_EMAILS', () => {
    Object.assign(process.env, {
      ...baseEnv(),
      ALLOWED_OPS_EMAILS: 'other@gmail.com',
    });
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();
    getVerifyIdToken().mockResolvedValue({
      email: 'user@gmail.com',
    });

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return requireFirebaseOpsAuth(
      { get: () => 'Bearer valid.jwt', path: '/scheduler/state' } as never,
      res as never,
      next,
    ).then(() => {
      expect(res.status).toHaveBeenCalledWith(403);
      expect((res.json as jest.Mock).mock.calls[0][0].message as string).toMatch(/not allowed/);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('calls next and sets opsEmail when token and allowlist pass', () => {
    Object.assign(process.env, {
      ...baseEnv(),
      ALLOWED_OPS_EMAILS: 'user@gmail.com, other@x.com',
    });
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();
    getVerifyIdToken().mockResolvedValue({
      email: 'user@gmail.com',
    });

    const req: { get: () => string; path: string; opsEmail?: string } = {
      get: () => 'Bearer valid.jwt',
      path: '/scheduler/state',
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    return requireFirebaseOpsAuth(req as never, res as never, next).then(() => {
      expect(req.opsEmail).toBe('user@gmail.com');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  it('dev bypass: skips Firebase when OPS_FIREBASE_BYPASS=1 and NODE_ENV=development', () => {
    Object.assign(process.env, {
      ...baseEnv(),
      NODE_ENV: 'development',
      OPS_FIREBASE_BYPASS: '1',
    });
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    const requireFirebaseOpsAuth = getRequireFirebaseOpsAuth();
    getVerifyIdToken().mockReset();

    const req: { get: () => undefined; path: string; opsEmail?: string } = {
      get: () => undefined,
      path: '/scheduler/state',
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    return requireFirebaseOpsAuth(req as never, res as never, next).then(() => {
      expect(req.opsEmail).toBe('dev-bypass@local.invalid');
      expect(next).toHaveBeenCalled();
      expect(getVerifyIdToken()).not.toHaveBeenCalled();
    });
  });
});
