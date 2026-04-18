/**
 * Hysteresis-based humidity state machine.
 *
 * Prevents rapid mode switching by requiring humidity to exceed a HIGH threshold
 * before starting a dry cycle, and to drop below a LOW threshold before stopping.
 *
 * evaluate() is pure: it does not mutate isDryCycleActive. Routes call setActive(true)
 * only after a successful dry-start and setActive(false) only after a successful dry-stop,
 * so a blocked or failed Onecta call cannot desync the FSM from the equipment.
 */

export type HumidityDecision = 'start' | 'stop' | 'no-action';

export class HumidityStateMachine {
  private isDryCycleActive = false;

  /**
   * Evaluate the current humidity reading and decide what action (if any) to take.
   *
   * Decisions (caller updates isDryCycleActive via setActive after successful tasks):
   *   inactive + humidity >= high  → 'start'
   *   active   + humidity <= low   → 'stop'
   *   otherwise                    → 'no-action'
   */
  evaluate(humidity: number, highThreshold: number, lowThreshold: number): HumidityDecision {
    if (!this.isDryCycleActive && humidity >= highThreshold) {
      return 'start';
    }

    if (this.isDryCycleActive && humidity <= lowThreshold) {
      return 'stop';
    }

    return 'no-action';
  }

  /**
   * Explicitly set the active state. Set true after a successful dry-start and false
   * after a successful dry-stop (timer or humidity path).
   */
  setActive(active: boolean): void {
    this.isDryCycleActive = active;
  }

  isActive(): boolean {
    return this.isDryCycleActive;
  }
}
