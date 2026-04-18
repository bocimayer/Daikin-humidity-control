#!/usr/bin/env bash
# =============================================================================
# apply-humidity-strategy-to-cloud.sh
#
# Sets Cloud Run MODE_STRATEGY=humidity and (re)creates Scheduler jobs for
# humidity-driven automation (check-humidity + nightly dry-stop safety).
#
# Prerequisites: gcloud authenticated; same env vars as create-scheduler-jobs.sh
#
# Usage:
#   export PROJECT_ID=tihany-daikin-humidity
#   export REGION=europe-central2
#   export TIME_ZONE="Europe/Budapest"
#   bash setup/apply-humidity-strategy-to-cloud.sh
# =============================================================================

set -euo pipefail

: "${PROJECT_ID:=tihany-daikin-humidity}"
: "${REGION:=europe-central2}"
: "${TIME_ZONE:=Europe/Budapest}"

SERVICE_NAME="daikin-humidity-control"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Updating Cloud Run ${SERVICE_NAME} MODE_STRATEGY=humidity ..."
gcloud run services update "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --update-env-vars="MODE_STRATEGY=humidity"

echo ""
export PROJECT_ID
export REGION
export TIME_ZONE
MODE_STRATEGY=humidity bash "${REPO_ROOT}/setup/create-scheduler-jobs.sh"

echo ""
echo "=== Done. Verify MODE_STRATEGY on Cloud Run (see README). Test mail: POST /tasks/notify-test with scheduler OIDC."
