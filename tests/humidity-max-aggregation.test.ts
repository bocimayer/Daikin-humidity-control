import { HumidityStateMachine } from '../src/humidity';

/**
 * Production passes max(RH_i) into the FSM, not average — any zone at/above HIGH must trigger start.
 */
describe('humidity decision uses max of readings (contract)', () => {
  const HIGH = 70;
  const LOW = 60;

  it('average below HIGH but max above HIGH must still start when inactive', () => {
    const readings = [65, 72];
    const maxRh = Math.max(...readings);
    const avgRh = readings.reduce((a, b) => a + b, 0) / readings.length;

    const fsmMax = new HumidityStateMachine();
    expect(maxRh).toBeGreaterThanOrEqual(HIGH);
    expect(avgRh).toBeLessThan(HIGH);
    expect(fsmMax.evaluate(maxRh, HIGH, LOW)).toBe('start');

    const fsmAvg = new HumidityStateMachine();
    expect(fsmAvg.evaluate(avgRh, HIGH, LOW)).toBe('no-action');
  });

  it('stop while active requires max RH at or below LOW', () => {
    const fsm = new HumidityStateMachine();
    fsm.setActive(true);
    expect(fsm.evaluate(61, HIGH, LOW)).toBe('no-action');
    expect(fsm.evaluate(60, HIGH, LOW)).toBe('stop');
  });
});
