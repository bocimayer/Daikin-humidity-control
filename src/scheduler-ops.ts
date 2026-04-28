/**
 * Cloud Scheduler: pause / resume daikin-check-humidity (auto dry) via the
 * same API as setup/disable-auto-dry.sh. Uses the Cloud Run metadata identity.
 *
 * Cross-ref: setup/grant-runtime-scheduler-ops-iam.sh, src/ops-routes.ts
 */
import { v1 } from '@google-cloud/scheduler';
import { protos } from '@google-cloud/scheduler';
import logger from './logger';

const State = protos.google.cloud.scheduler.v1.Job.State;

function stateToLabel(
  s: protos.google.cloud.scheduler.v1.Job.State | null | string | number | undefined,
): string {
  if (s === null || s === undefined) return 'unknown';
  const n = typeof s === 'string' ? parseInt(s, 10) : (s as number);
  if (n === State.ENABLED) return 'ENABLED (running on schedule)';
  if (n === State.PAUSED) return 'PAUSED (auto dry off)';
  if (n === State.DISABLED) return 'DISABLED (system error — fix in console)';
  if (n === State.UPDATE_FAILED) return 'UPDATE_FAILED';
  if (n === State.STATE_UNSPECIFIED) return 'UNSPECIFIED';
  return `state_${String(s)}`;
}

export function jobResourceName(
  projectId: string,
  location: string,
  jobName: string,
): string {
  return `projects/${projectId}/locations/${location}/jobs/${jobName}`;
}

export class CheckHumiditySchedulerOps {
  private readonly client: v1.CloudSchedulerClient;
  private readonly name: string;

  constructor(
    client: v1.CloudSchedulerClient | undefined,
    projectId: string,
    location: string,
    jobName: string,
  ) {
    this.client = client ?? new v1.CloudSchedulerClient();
    this.name = jobResourceName(projectId, location, jobName);
  }

  async getJob() {
    const [job] = await this.client.getJob({ name: this.name });
    return job;
  }

  async getStateLabel(): Promise<string> {
    const job = await this.getJob();
    return stateToLabel(job.state);
  }

  async pause(): Promise<void> {
    await this.client.pauseJob({ name: this.name });
    logger.info({ name: this.name }, 'Scheduler job paused (check-humidity)');
  }

  async resume(): Promise<void> {
    await this.client.resumeJob({ name: this.name });
    logger.info({ name: this.name }, 'Scheduler job resumed (check-humidity)');
  }
}

export { stateToLabel };
