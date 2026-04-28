import { stateToLabel } from '../src/scheduler-ops';

/** google.cloud.scheduler.v1.Job.State — avoid importing the full gRPC client in tests. */
const JobState = { ENABLED: 1, PAUSED: 2 } as const;

describe('stateToLabel', () => {
  it('maps ENABLED and PAUSED', () => {
    expect(stateToLabel(JobState.ENABLED)).toContain('ENABLED');
    expect(stateToLabel(JobState.PAUSED)).toContain('PAUSED');
  });
});