/**
 * Limits how many async Onecta write operations run at once (PATCH burst → 429).
 * Used by DaikinClient for all characteristic PATCHes. Cross-ref: daikin.ts.
 */

export class WriteConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('WriteConcurrencyGate: maxConcurrent must be a finite number >= 1');
    }
  }

  /** Run fn while holding one write slot; order is FIFO under the concurrency cap. */
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
