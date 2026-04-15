/**
 * In-memory idempotency guard.
 *
 * Prevents the same task from being re-triggered within a configurable minimum
 * gap during a single container lifetime. This guards against Cloud Scheduler
 * duplicate deliveries and accidental rapid re-invocations.
 *
 * Note: state is not persisted across container restarts. For a single-instance
 * Cloud Run service this is sufficient; if you scale to multiple instances,
 * use a shared store (e.g. Firestore, Memorystore) instead.
 */

export class IdempotencyGuard {
  private readonly lastRun = new Map<string, number>();

  /**
   * @param minGapMs Minimum milliseconds between two executions of the same task.
   *                 Defaults to 10 minutes.
   */
  constructor(private readonly minGapMs: number = 10 * 60 * 1000) {}

  /**
   * Returns true if enough time has elapsed since the task last ran (or if it
   * has never run). Does NOT record the run — call markRan() after success.
   */
  shouldRun(taskName: string): boolean {
    const last = this.lastRun.get(taskName);
    if (last === undefined) return true;
    return Date.now() - last >= this.minGapMs;
  }

  /** Records that the task ran right now. */
  markRan(taskName: string): void {
    this.lastRun.set(taskName, Date.now());
  }

  /**
   * Atomic check-and-mark. Returns true and records the run if the guard
   * permits it; returns false without recording if the minimum gap has not
   * elapsed yet.
   */
  checkAndMark(taskName: string): boolean {
    if (!this.shouldRun(taskName)) return false;
    this.markRan(taskName);
    return true;
  }

  /** Clears the recorded run time for a task (useful in tests). */
  reset(taskName: string): void {
    this.lastRun.delete(taskName);
  }
}
