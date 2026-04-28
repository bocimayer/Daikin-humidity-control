/**
 * Jest module stub for @google-cloud/scheduler (avoids loading the full gRPC
 * client in every test worker, which can cause OOM on constrained CI hosts).
 * Production uses the real package from node_modules.
 */
export const protos = {
  google: {
    cloud: {
      scheduler: {
        v1: {
          Job: {
            State: {
              STATE_UNSPECIFIED: 0,
              ENABLED: 1,
              PAUSED: 2,
              DISABLED: 3,
              UPDATE_FAILED: 4,
            },
          },
        },
      },
    },
  },
};

export const v1 = {
  CloudSchedulerClient: class CloudSchedulerClientStub {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts?: unknown) {
      /* stub */
    }
  },
};
