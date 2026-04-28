#!/usr/bin/env bash
# =============================================================================
# grant-runtime-scheduler-ops-iam.sh — Let the Cloud Run *runtime* service account
#   pause / resume the daikin-check-humidity job (for /ops/scheduler in the app).
#
# The app calls Cloud Scheduler via Application Default Credentials (metadata).
# Tightest predefined role in many orgs: roles/cloudscheduler.admin (broad for one
# job). For least privilege, create a custom role with:
#   cloudscheduler.jobs.get, cloudscheduler.jobs.pause, cloudscheduler.jobs.enable
# and bind on the project or job.
#
# Usage:
#   export PROJECT_ID=tihany-daikin-humidity
#   export RUNTIME_SA=daikin-runtime-sa   # no @...
#   bash setup/grant-runtime-scheduler-ops-iam.sh
# =============================================================================
set -euo pipefail

: "${PROJECT_ID:=tihany-daikin-humidity}"
: "${RUNTIME_SA:=daikin-runtime-sa}"

RUNTIME="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
ROLE="${SCHEDULER_OPS_ROLE:-roles/cloudscheduler.admin}"

echo "Project: ${PROJECT_ID}"
echo "Runtime SA: ${RUNTIME}"
echo "Role: ${ROLE}  (set SCHEDULER_OPS_ROLE to override)"
echo ""
echo "gcloud projects add-iam-policy-binding ${PROJECT_ID} --member=serviceAccount:${RUNTIME} --role=${ROLE} --condition=None"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME}" \
  --role="${ROLE}"

echo "Done. Runtime can call Scheduler pause/resume for /ops/scheduler."
