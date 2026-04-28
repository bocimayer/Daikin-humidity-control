#!/usr/bin/env bash
# =============================================================================
# disable-auto-dry.sh — Pause the Cloud Scheduler job that runs humidity FSM
#   (POST /tasks/check-humidity). Stops automatic DRY based on indoor RH
#   without changing Cloud Run env or redeploying.
#
# Does NOT pause daikin-dry-stop-safety (nightly POST /tasks/dry-stop). For an
# app-wide kill switch (dry-start, dry-stop, check-humidity), set
# AUTOMATION_ENABLED=false on the service — see README.md.
#
# Refs: setup/create-scheduler-jobs.sh (job names/defaults), README.md,
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

echo "Pausing Cloud Scheduler job: ${JOB}"
echo "  project=${PROJECT_ID}  location=${REGION}"
gcloud scheduler jobs pause "${JOB}" --location="${REGION}" --project="${PROJECT_ID}"
echo ""
echo "Current state:"
gcloud scheduler jobs describe "${JOB}" --location="${REGION}" --project="${PROJECT_ID}" \
  --format="table(name,state,schedule,timeZone)"
echo ""
echo "Auto dry (check-humidity schedule) is OFF. Job daikin-dry-stop-safety is unchanged."

