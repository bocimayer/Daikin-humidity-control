import { IdempotencyGuard } from '../src/idempotency';

describe('IdempotencyGuard', () => {
  const MIN_GAP_MS = 5_000; // 5 s for test speed
  const TASK = 'dry-start';

  let guard: IdempotencyGuard;
  let nowMs: number;

  beforeEach(() => {
    guard = new IdempotencyGuard(MIN_GAP_MS);
    nowMs = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── First run ────────────────────────────────────────────────────────────────

  it('allows a task that has never run', () => {
    expect(guard.shouldRun(TASK)).toBe(true);
  });

  it('checkAndMark returns true on first call', () => {
    expect(guard.checkAndMark(TASK)).toBe(true);
  });

  // ── Duplicate suppression ─────────────────────────────────────────────────────

  it('blocks a task called immediately after the first run', () => {
    guard.markRan(TASK);
    expect(guard.shouldRun(TASK)).toBe(false);
  });

  it('checkAndMark returns false on immediate second call', () => {
    guard.checkAndMark(TASK);
    expect(guard.checkAndMark(TASK)).toBe(false);
  });

  // ── Gap elapsed ──────────────────────────────────────────────────────────────

  it('allows the task again once the minimum gap has elapsed', () => {
    guard.markRan(TASK);
    // Advance mock clock by exactly the gap.
    nowMs += MIN_GAP_MS;
    expect(guard.shouldRun(TASK)).toBe(true);
  });

  it('still blocks just before the gap elapses', () => {
    guard.markRan(TASK);
    nowMs += MIN_GAP_MS - 1;
    expect(guard.shouldRun(TASK)).toBe(false);
  });

  // ── Task isolation ───────────────────────────────────────────────────────────

  it('tracks different task names independently', () => {
    guard.checkAndMark('dry-start');
    expect(guard.shouldRun('dry-stop')).toBe(true);
    expect(guard.shouldRun('check-humidity')).toBe(true);
  });

  // ── reset ────────────────────────────────────────────────────────────────────

  it('reset clears the record so the task can run again immediately', () => {
    guard.markRan(TASK);
    guard.reset(TASK);
    expect(guard.shouldRun(TASK)).toBe(true);
  });

  // ── checkAndMark atomicity ────────────────────────────────────────────────────

  it('checkAndMark records the run so a subsequent call is blocked', () => {
    const first = guard.checkAndMark(TASK);
    const second = guard.checkAndMark(TASK);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
