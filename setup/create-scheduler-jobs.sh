#!/usr/bin/env bash
# =============================================================================
# create-scheduler-jobs.sh — Create Cloud Scheduler jobs after first deploy.
#
# Run AFTER bootstrap.sh and after the first successful GitHub Actions deploy
# (you need the Cloud Run service URL, which only exists post-deploy).
#
# Usage:
#   export PROJECT_ID=your-gcp-project-id
#   export REGION=europe-west1
#   export MODE_STRATEGY=timer        # or: humidity
#   export TIME_ZONE="Europe/Budapest"
#   bash setup/create-scheduler-jobs.sh
# =============================================================================

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:?Set REGION}"
: "${MODE_STRATEGY:=timer}"
: "${TIME_ZONE:=Europe/Budapest}"

SERVICE_NAME="daikin-humidity-control"
SCHEDULER_SA="daikin-scheduler-sa@${PROJECT_ID}.iam.gserviceaccount.com"

# ── Fetch Cloud Run service URL ───────────────────────────────────────────────
echo "Fetching Cloud Run service URL..."
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format="value(status.url)" \
  --project="$PROJECT_ID")

if [ -z "$SERVICE_URL" ]; then
  echo "ERROR: Could not determine service URL. Is the service deployed?"
  exit 1
fi
echo "Service URL: ${SERVICE_URL}"
echo ""

# ── Grant Scheduler SA the invoker role ───────────────────────────────────────
echo "Granting Cloud Run Invoker role to scheduler SA..."
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker" \
  --project="$PROJECT_ID" \
  --quiet
echo "Done."
echo ""

# ── Helper to create or update a scheduler job ───────────────────────────────
upsert_job() {
  local JOB_NAME="$1"
  local SCHEDULE="$2"
  local URI="$3"

  if gcloud scheduler jobs describe "$JOB_NAME" \
       --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
    echo "  Updating existing job: ${JOB_NAME}"
    gcloud scheduler jobs update http "$JOB_NAME" \
      --location="$REGION" \
      --schedule="$SCHEDULE" \
      --time-zone="$TIME_ZONE" \
      --uri="$URI" \
      --http-method=POST \
      --oidc-service-account-email="$SCHEDULER_SA" \
      --oidc-token-audience="$SERVICE_URL" \
      --project="$PROJECT_ID"
  else
    echo "  Creating job: ${JOB_NAME}"
    gcloud scheduler jobs create http "$JOB_NAME" \
      --location="$REGION" \
      --schedule="$SCHEDULE" \
      --time-zone="$TIME_ZONE" \
      --uri="$URI" \
      --http-method=POST \
      --oidc-service-account-email="$SCHEDULER_SA" \
      --oidc-token-audience="$SERVICE_URL" \
      --project="$PROJECT_ID"
  fi
}

# ── Create jobs based on selected strategy ────────────────────────────────────
if [ "$MODE_STRATEGY" = "timer" ]; then
  echo "Creating Option A (timer-only) jobs..."

  # Adjust cron times to suit your schedule.
  upsert_job "daikin-dry-start" "0 9 * * *"  "${SERVICE_URL}/tasks/dry-start"
  upsert_job "daikin-dry-stop"  "0 11 * * *" "${SERVICE_URL}/tasks/dry-stop"

  echo ""
  echo "Timer jobs created:"
  echo "  09:00 → /tasks/dry-start  (switches all units to DRY)"
  echo "  11:00 → /tasks/dry-stop   (reverts to HEAT @ frost-protection setpoint)"

elif [ "$MODE_STRATEGY" = "humidity" ]; then
  echo "Creating Option B (humidity-aware) jobs..."

  # Poll every 3 hours (8 calls/day per leader device — stays within quota).
  upsert_job "daikin-check-humidity"  "0 */3 * * *" "${SERVICE_URL}/tasks/check-humidity"
  upsert_job "daikin-dry-stop-safety" "0 0 * * *"   "${SERVICE_URL}/tasks/dry-stop"

  echo ""
  echo "Humidity-aware jobs created:"
  echo "  Every 3 h → /tasks/check-humidity  (hysteresis FSM decides start/stop)"
  echo "  00:00     → /tasks/dry-stop         (safety stop — ensures nightly revert)"

else
  echo "ERROR: Unknown MODE_STRATEGY '${MODE_STRATEGY}'. Use 'timer' or 'humidity'."
  exit 1
fi

echo ""
echo "=== Scheduler jobs ready. ==="
echo ""
echo "Test a job manually:"
echo "  gcloud scheduler jobs run daikin-dry-stop --location=${REGION} --project=${PROJECT_ID}"
echo ""
echo "Tail Cloud Run logs:"
echo "  gcloud run services logs tail ${SERVICE_NAME} --region=${REGION} --project=${PROJECT_ID}"
