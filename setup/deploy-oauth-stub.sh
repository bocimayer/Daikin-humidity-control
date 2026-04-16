#!/usr/bin/env bash
# =============================================================================
# deploy-oauth-stub.sh — Build & deploy the public OAuth redirect stub to Cloud Run.
#
# The Cloud Run URL for this service stays the same as long as you do not delete
# the service (same project, region, and service name).
#
# Prerequisites: gcloud authenticated; Artifact Registry repo "daikin" exists
# (see bootstrap.sh). Uses the same PROJECT_ID / REGION as other setup scripts.
#
# Usage:
#   export PROJECT_ID=tihany-daikin-humidity
#   export REGION=europe-central2
#   bash setup/deploy-oauth-stub.sh
# =============================================================================

set -euo pipefail

: "${PROJECT_ID:=tihany-daikin-humidity}"
: "${REGION:=europe-central2}"

SERVICE_NAME="daikin-oauth-stub"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/daikin/${SERVICE_NAME}:latest"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STUB_DIR="${REPO_ROOT}/oauth-stub"

echo "=== Deploy ${SERVICE_NAME} ==="
echo "Project: ${PROJECT_ID}  Region: ${REGION}"
echo ""

gcloud config set project "${PROJECT_ID}" >/dev/null

echo "--- Docker build & push ---"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

docker build -t "${IMAGE}" -f "${STUB_DIR}/Dockerfile" "${STUB_DIR}"
docker push "${IMAGE}"

echo "--- Cloud Run deploy (public: browser OAuth redirect) ---"
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --project="${PROJECT_ID}"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format='value(status.url)')

echo ""
echo "Stable service URL: ${SERVICE_URL}"
echo "Register this redirect URI in the Daikin developer portal:"
echo "  ${SERVICE_URL}/oauth/callback"
echo ""
echo "Health: ${SERVICE_URL}/health"
