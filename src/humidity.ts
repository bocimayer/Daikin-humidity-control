/**
 * Hysteresis-based humidity state machine.
 *
 * Prevents rapid mode switching by requiring humidity to exceed a HIGH threshold
 * before starting a dry cycle, and to drop below a LOW threshold before stopping.
 */

export type HumidityDecision = 'start' | 'stop' | 'no-action';

export class HumidityStateMachine {
  private isDryCycleActive = false;

  /**
   * Evaluate the current humidity reading and decide what action (if any) to take.
   *
   * Transitions:
   *   inactive + humidity >= high  → 'start'   (marks cycle active)
   *   active   + humidity <= low   → 'stop'    (marks cycle inactive)
   *   otherwise                    → 'no-action'
   */
  evaluate(humidity: number, highThreshold: number, lowThreshold: number): HumidityDecision {
    if (!this.isDryCycleActive && humidity >= highThreshold) {
      this.isDryCycleActive = true;
      return 'start';
    }

    if (this.isDryCycleActive && humidity <= lowThreshold) {
      this.isDryCycleActive = false;
      return 'stop';
    }

    return 'no-action';
  }

  /**
   * Explicitly set the active state. Called by task handlers when dry-start or
   * dry-stop executes via the timer path, so the humidity FSM stays in sync.
   */
  setActive(active: boolean): void {
    this.isDryCycleActive = active;
  }

  isActive(): boolean {
    return this.isDryCycleActive;
  }
}
