import axios from 'axios';
import {
  MIN_MS_BETWEEN_DEVICE_ATTEMPTS,
  computeBackoffMsAfterFailure,
  isLikelyTransientOnectaFailure,
  parseRetryAfterDelayMs,
  sleep,
} from '../src/onecta-transient-retry';

describe('onecta-transient-retry', () => {
  it('treats 429 as transient', () => {
    const err = new axios.AxiosError('too many');
    err.response = { status: 429, data: {}, headers: {}, statusText: '', config: {} as never };
    expect(isLikelyTransientOnectaFailure(err)).toBe(true);
  });

  it('treats 400 as non-transient', () => {
    const err = new axios.AxiosError('bad');
    err.response = { status: 400, data: {}, headers: {}, statusText: '', config: {} as never };
    expect(isLikelyTransientOnectaFailure(err)).toBe(false);
  });

  it('parses Retry-After seconds with cap', () => {
    const err = new axios.AxiosError('wait');
    err.response = {
      status: 429,
      data: {},
      headers: { 'retry-after': '3' },
      statusText: '',
      config: {} as never,
    };
    expect(parseRetryAfterDelayMs(err)).toBe(3000);
  });

  it('computeBackoff uses header when present', () => {
    const err = new axios.AxiosError('wait');
    err.response = {
      status: 429,
      data: {},
      headers: { 'retry-after': '2' },
      statusText: '',
      config: {} as never,
    };
    const ms = computeBackoffMsAfterFailure(err, 1);
    expect(ms).toBeGreaterThanOrEqual(MIN_MS_BETWEEN_DEVICE_ATTEMPTS);
    expect(ms).toBeLessThan(4000);
  });

  it('floors small Retry-After to MIN_MS_BETWEEN_DEVICE_ATTEMPTS', () => {
    const err = new axios.AxiosError('wait');
    err.response = {
      status: 429,
      data: {},
      headers: { 'retry-after': '0' },
      statusText: '',
      config: {} as never,
    };
    expect(parseRetryAfterDelayMs(err)).toBe(0);
    expect(computeBackoffMsAfterFailure(err, 1)).toBeGreaterThanOrEqual(MIN_MS_BETWEEN_DEVICE_ATTEMPTS);
  });

  it('sleep resolves', async () => {
    const t0 = Date.now();
    await sleep(15);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });
});
