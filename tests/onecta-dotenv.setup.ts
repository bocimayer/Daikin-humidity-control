/**
 * Runs before integration tests so `process.env` is populated before `src/config` loads.
 * Local live tests use the repo-root `.env` for static credentials and token-store settings.
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
