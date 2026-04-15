/** Live Onecta tests only — run: DAIKIN_INTEGRATION_TEST=1 npm run test:onnecta */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.integration.test.ts'],
  testTimeout: 120_000,
  setupFiles: ['<rootDir>/tests/onecta-dotenv.setup.ts'],
};
