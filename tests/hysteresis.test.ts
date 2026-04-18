import { HumidityStateMachine } from '../src/humidity';

describe('HumidityStateMachine', () => {
  const HIGH = 70;
  const LOW = 60;

  let fsm: HumidityStateMachine;

  beforeEach(() => {
    fsm = new HumidityStateMachine();
  });

  // ── Initial state ────────────────────────────────────────────────────────────

  it('starts inactive', () => {
    expect(fsm.isActive()).toBe(false);
  });

  // ── Inactive → no-action ─────────────────────────────────────────────────────

  it('returns no-action when humidity is below high threshold (inactive)', () => {
    expect(fsm.evaluate(65, HIGH, LOW)).toBe('no-action');
    expect(fsm.isActive()).toBe(false);
  });

  it('returns no-action when humidity exactly equals low threshold (inactive)', () => {
    // LOW threshold only matters when active; inactive FSM only cares about HIGH.
    expect(fsm.evaluate(60, HIGH, LOW)).toBe('no-action');
    expect(fsm.isActive()).toBe(false);
  });

  // ── Inactive → start ─────────────────────────────────────────────────────────

  it('returns start when humidity reaches high threshold (inactive)', () => {
    expect(fsm.evaluate(70, HIGH, LOW)).toBe('start');
    expect(fsm.isActive()).toBe(false);
  });

  it('returns start when humidity exceeds high threshold (inactive)', () => {
    expect(fsm.evaluate(85, HIGH, LOW)).toBe('start');
    expect(fsm.isActive()).toBe(false);
  });

  // ── Active → no-action ───────────────────────────────────────────────────────

  it('returns no-action when humidity is above low threshold (active)', () => {
    fsm.setActive(true);
    expect(fsm.evaluate(65, HIGH, LOW)).toBe('no-action');
    expect(fsm.isActive()).toBe(true);
  });

  it('returns no-action when humidity is above high threshold (active — no re-trigger)', () => {
    fsm.setActive(true);
    expect(fsm.evaluate(80, HIGH, LOW)).toBe('no-action');
    expect(fsm.isActive()).toBe(true);
  });

  // ── Active → stop ────────────────────────────────────────────────────────────

  it('returns stop when humidity drops to low threshold (active)', () => {
    fsm.setActive(true);
    expect(fsm.evaluate(60, HIGH, LOW)).toBe('stop');
    expect(fsm.isActive()).toBe(true);
    fsm.setActive(false);
    expect(fsm.isActive()).toBe(false);
  });

  it('returns stop when humidity drops below low threshold (active)', () => {
    fsm.setActive(true);
    expect(fsm.evaluate(50, HIGH, LOW)).toBe('stop');
    expect(fsm.isActive()).toBe(true);
    fsm.setActive(false);
    expect(fsm.isActive()).toBe(false);
  });

  // ── Full cycle ───────────────────────────────────────────────────────────────

  it('correctly transitions through a full dry cycle', () => {
    // Below threshold — idle.
    expect(fsm.evaluate(62, HIGH, LOW)).toBe('no-action');

    // Rises above HIGH — start dry (routes set active only after Onecta succeeds).
    expect(fsm.evaluate(72, HIGH, LOW)).toBe('start');
    fsm.setActive(true);

    // Still high — stay in dry.
    expect(fsm.evaluate(68, HIGH, LOW)).toBe('no-action');

    // Drops just above LOW — stay in dry (hysteresis).
    expect(fsm.evaluate(61, HIGH, LOW)).toBe('no-action');

    // Drops to LOW — stop dry.
    expect(fsm.evaluate(60, HIGH, LOW)).toBe('stop');
    fsm.setActive(false);

    // Back to idle below HIGH.
    expect(fsm.evaluate(62, HIGH, LOW)).toBe('no-action');
  });

  // ── setActive ────────────────────────────────────────────────────────────────

  it('setActive(true) makes isActive() return true', () => {
    fsm.setActive(true);
    expect(fsm.isActive()).toBe(true);
  });

  it('setActive(false) makes isActive() return false', () => {
    fsm.setActive(true);
    fsm.setActive(false);
    expect(fsm.isActive()).toBe(false);
  });
});
