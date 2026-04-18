/**
 * Shared backoff for Onecta gateway operations that must succeed on every device
 * (dry-start / dry-stop). Used by `routes.ts` — see `src/daikin.ts` for HTTP-level axios-retry.
 */

import axios from 'axios';
import type { AxiosError } from 'axios';
import logger from './logger';

/** Per-device attempts before surfacing failure to the HTTP handler (429 storms need headroom). */
export const MAX_GATEWAY_DEVICE_ATTEMPTS = 15;

export function isLikelyTransientOnectaFailure(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const ax = err as AxiosError;
  if (!ax.response) return true;
  const s = ax.response.status;
  if (s === 429 || s === 408) return true;
  if (s >= 500 && s < 600) return true;
  return false;
}

/** Parse Retry-After seconds when present; cap so Scheduler jobs do not hang forever. */
export function parseRetryAfterDelayMs(err: unknown): number | undefined {
  if (!axios.isAxiosError(err) || !err.response) return undefined;
  const raw = err.response.headers?.['retry-after'];
  if (raw === undefined || raw === null) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const sec = parseInt(String(first).trim(), 10);
  if (!Number.isFinite(sec) || sec < 0) return undefined;
  return Math.min(sec * 1000, 120_000);
}

export function computeBackoffMsAfterFailure(err: unknown, attemptIndex: number): number {
  const fromHeader = parseRetryAfterDelayMs(err);
  if (fromHeader !== undefined) {
    return fromHeader + Math.floor(Math.random() * 500);
  }
  const exp = Math.min(60_000, 2000 * 2 ** Math.max(0, attemptIndex - 1));
  return exp + Math.floor(Math.random() * 800);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runWithGatewayDeviceRetries(
  label: string,
  deviceId: string,
  op: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_GATEWAY_DEVICE_ATTEMPTS; attempt++) {
    try {
      await op();
      if (attempt > 1) {
        logger.info({ label, deviceId, attempt }, 'Gateway device operation succeeded after retry');
      }
      return;
    } catch (err) {
      const transient = isLikelyTransientOnectaFailure(err);
      if (attempt >= MAX_GATEWAY_DEVICE_ATTEMPTS || !transient) {
        logger.error(
          { label, deviceId, attempt, transient, err },
          'Gateway device operation failed — giving up on this device',
        );
        throw err;
      }
      const delayMs = computeBackoffMsAfterFailure(err, attempt);
      logger.warn(
        { label, deviceId, attempt, delayMs, status: axios.isAxiosError(err) ? err.response?.status : undefined },
        'Transient gateway failure — retrying same device',
      );
      await sleep(delayMs);
    }
  }
}
