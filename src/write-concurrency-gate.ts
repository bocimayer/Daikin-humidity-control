/**
 * Limits concurrent calls to the Onecta gateway HTTP API (GET + PATCH on this.http).
 * Daikin rate limits hit on parallel device reads as well as writes; this gate applies to both.
 * Cross-ref: daikin.ts (DAIKIN_WRITE_CONCURRENCY / config.daikin.writeConcurrency).
 */

export class WriteConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('WriteConcurrencyGate: maxConcurrent must be a finite number >= 1');
    }
  }

  /** Run fn while holding one slot; order is FIFO under the concurrency cap. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const wake = this.waiters.shift();
    if (wake) {
      wake();
    }
  }
}
