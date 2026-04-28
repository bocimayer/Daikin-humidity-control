import { CheckHumiditySchedulerOps, jobResourceName } from '../src/scheduler-ops';

/** Job.State.ENABLED / PAUSED — see google.cloud.scheduler.v1.Job. */
const PAUSED = 2;
const ENABLED = 1;

describe('CheckHumiditySchedulerOps (mock client)', () => {
  const name = jobResourceName('my-proj', 'europe-central2', 'daikin-check-humidity');

  it('pauseJob and resumeJob forward to Cloud Scheduler client', async () => {
    const pauseJob = jest.fn().mockResolvedValue([{}]);
    const resumeJob = jest.fn().mockResolvedValue([{}]);
    const getJob = jest.fn().mockResolvedValue([{ state: PAUSED }]);
    const mockClient = { pauseJob, resumeJob, getJob } as any;
    const ops = new CheckHumiditySchedulerOps(
      mockClient,
      'my-proj',
      'europe-central2',
      'daikin-check-humidity',
    );

    await ops.pause();
    expect(pauseJob).toHaveBeenCalledWith({ name });

    await ops.resume();
    expect(resumeJob).toHaveBeenCalledWith({ name });
  });

  it('getStateLabel uses getJob state', async () => {
    const getJob = jest.fn().mockResolvedValue([{ state: ENABLED }]);
    const mockClient = {
      getJob,
      pauseJob: jest.fn(),
      resumeJob: jest.fn(),
    } as any;
    const ops = new CheckHumiditySchedulerOps(
      mockClient,
      'my-proj',
      'europe-central2',
      'daikin-check-humidity',
    );

    const label = await ops.getStateLabel();
    expect(label).toContain('ENABLED');
    expect(getJob).toHaveBeenCalledWith({ name });
  });
});
