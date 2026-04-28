#!/usr/bin/env bash
# =============================================================================
# enable-auto-dry.sh — Resume the Cloud Scheduler job that runs humidity FSM
#   (POST /tasks/check-humidity). Re-enables automatic DRY from indoor RH
#   after disable-auto-dry.sh — no Cloud Run deploy.
#
# Refs: setup/disable-auto-dry.sh, setup/create-scheduler-jobs.sh, README.md,
#   .cursor/skills/daikin-auto-dry/SKILL.md
# =============================================================================

set -euo pipefail

: "${PROJECT_ID:=tihany-daikin-humidity}"
: "${REGION:=europe-central2}"
JOB="daikin-check-humidity"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not in PATH."
  exit 1
fi

echo "Resuming Cloud Scheduler job: ${JOB}"
echo "  project=${PROJECT_ID}  location=${REGION}"
gcloud scheduler jobs resume "${JOB}" --location="${REGION}" --project="${PROJECT_ID}"
echo ""
echo "Current state:"
gcloud scheduler jobs describe "${JOB}" --location="${REGION}" --project="${PROJECT_ID}" \
  --format="table(name,state,schedule,timeZone)"
echo ""
echo "Auto dry (check-humidity schedule) is ON (when state shows ENABLED)."

