#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — One-time GCP setup for the Daikin humidity-control service.
#
# Run this ONCE from your local machine before the first GitHub Actions deploy.
# It creates every GCP resource the pipeline depends on.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated  (gcloud auth login)
#   - jq installed
#   - The GitHub repo already exists (needed for Workload Identity binding)
#
# Usage:
#   export PROJECT_ID=your-gcp-project-id
#   export REGION=europe-central2
#   export GITHUB_ORG=bocimayer
#   export GITHUB_REPO=Daikin-humidity-control
#   bash setup/bootstrap.sh
# =============================================================================

set -euo pipefail

# ── Required env vars ─────────────────────────────────────────────────────────
: "${PROJECT_ID:=tihany-daikin-humidity}"
: "${REGION:=europe-central2}"
: "${GITHUB_ORG:=bocimayer}"
: "${GITHUB_REPO:=Daikin-humidity-control}"

# ── Derived names (change only if you need different names) ───────────────────
SERVICE_NAME="daikin-humidity-control"
DEPLOY_SA_NAME="daikin-deploy-sa"
SCHEDULER_SA_NAME="daikin-scheduler-sa"
RUNTIME_SA_NAME="daikin-runtime-sa"
AR_REPO="daikin"
WIF_POOL="github-pool"
WIF_PROVIDER="github-provider"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="${SCHEDULER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=== Daikin Humidity Control — GCP Bootstrap ==="
echo "Project:   $PROJECT_ID  ($PROJECT_NUMBER)"
echo "Region:    $REGION"
echo "GitHub:    ${GITHUB_ORG}/${GITHUB_REPO}"
echo ""

# ── 1. Enable required APIs ───────────────────────────────────────────────────
echo "--- [1/9] Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID"
echo "    APIs enabled."

# ── 2. Artifact Registry repository ──────────────────────────────────────────
echo "--- [2/9] Creating Artifact Registry repository..."
if gcloud artifacts repositories describe "$AR_REPO" \
     --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  echo "    Repository '${AR_REPO}' already exists — skipping."
else
  gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Daikin humidity-control Docker images" \
    --project="$PROJECT_ID"
  echo "    Repository '${AR_REPO}' created."
fi

# ── 3. Deploy service account ─────────────────────────────────────────────────
echo "--- [3/9] Creating deploy service account..."
if gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID" &>/dev/null; then
  echo "    Service account '${DEPLOY_SA}' already exists — skipping."
else
  gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
    --display-name="Daikin CD Deploy" \
    --project="$PROJECT_ID"
  echo "    Service account '${DEPLOY_SA}' created."
fi

# ── 4. Scheduler service account ──────────────────────────────────────────────
echo "--- [4/9] Creating scheduler service account..."
if gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT_ID" &>/dev/null; then
  echo "    Service account '${SCHEDULER_SA}' already exists — skipping."
else
  gcloud iam service-accounts create "$SCHEDULER_SA_NAME" \
    --display-name="Daikin Scheduler Invoker" \
    --project="$PROJECT_ID"
  echo "    Service account '${SCHEDULER_SA}' created."
fi

# Dedicated runtime identity for Cloud Run (must match .github/workflows/deploy*.yml).
echo "--- [4b/9] Creating Cloud Run runtime service account..."
if gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" &>/dev/null; then
  echo "    Service account '${RUNTIME_SA}' already exists — skipping."
else
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --display-name="Daikin Cloud Run Runtime" \
    --project="$PROJECT_ID"
  echo "    Service account '${RUNTIME_SA}' created."
fi

# ── 5. IAM roles for deploy SA ────────────────────────────────────────────────
echo "--- [5/9] Granting IAM roles to deploy SA..."
for ROLE in \
  "roles/run.admin" \
  "roles/artifactregistry.writer" \
  "roles/iam.serviceAccountUser" \
  "roles/secretmanager.viewer"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="$ROLE" \
    --condition=None \
    --quiet
  echo "    Granted ${ROLE}"
done

# ── 6. IAM: runtime SA reads secrets and writes Firestore ────────────────────
echo "--- [6/9] Granting runtime access to Secret Manager and Firestore..."
# Secrets must already exist before this step. If they don't yet, run this
# section manually after creating them (see Step 7).
for SECRET in DAIKIN_CLIENT_ID DAIKIN_CLIENT_SECRET; do
  if gcloud secrets describe "$SECRET" --project="$PROJECT_ID" &>/dev/null; then
    gcloud secrets add-iam-policy-binding "$SECRET" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --project="$PROJECT_ID" \
      --quiet
    echo "    Granted secretAccessor on ${SECRET}"
  else
    echo "    WARNING: Secret '${SECRET}' not found — create it and re-run step 6,"
    echo "             or run: gcloud secrets add-iam-policy-binding ${SECRET} \\"
    echo "               --member=serviceAccount:${RUNTIME_SA} \\"
    echo "               --role=roles/secretmanager.secretAccessor --project=${PROJECT_ID}"
  fi
done

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/datastore.user" \
  --condition=None \
  --quiet
echo "    Granted roles/datastore.user to ${RUNTIME_SA}"

# ── 7. Create Secret Manager secrets (values entered interactively) ───────────
echo "--- [7/9] Creating Secret Manager secrets..."
echo "    Enter each secret value when prompted (input is hidden)."
echo "    Press ENTER to skip a secret that already exists."
echo ""

for SECRET in DAIKIN_CLIENT_ID DAIKIN_CLIENT_SECRET; do
  if gcloud secrets describe "$SECRET" --project="$PROJECT_ID" &>/dev/null; then
    echo "    Secret '${SECRET}' already exists — skipping."
  else
    read -rsp "    Value for ${SECRET}: " SECRET_VALUE
    echo ""
    if [ -n "$SECRET_VALUE" ]; then
      printf '%s' "$SECRET_VALUE" | gcloud secrets create "$SECRET" \
        --data-file=- --project="$PROJECT_ID"
      echo "    Secret '${SECRET}' created."
    else
      echo "    Skipped '${SECRET}' (empty input)."
    fi
  fi
done

# ── 8. Workload Identity Federation for GitHub Actions ────────────────────────
echo "--- [8/9] Setting up Workload Identity Federation..."

# Create pool if it doesn't exist.
if gcloud iam workload-identity-pools describe "$WIF_POOL" \
     --location=global --project="$PROJECT_ID" &>/dev/null; then
  echo "    WIF pool '${WIF_POOL}' already exists — skipping."
else
  gcloud iam workload-identity-pools create "$WIF_POOL" \
    --location=global \
    --display-name="GitHub Actions Pool" \
    --project="$PROJECT_ID"
  echo "    WIF pool '${WIF_POOL}' created."
fi

# Create OIDC provider if it doesn't exist.
if gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
     --workload-identity-pool="$WIF_POOL" \
     --location=global --project="$PROJECT_ID" &>/dev/null; then
  echo "    WIF provider '${WIF_PROVIDER}' already exists — skipping."
else
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --workload-identity-pool="$WIF_POOL" \
    --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '${GITHUB_ORG}/${GITHUB_REPO}'" \
    --project="$PROJECT_ID"
  echo "    WIF provider '${WIF_PROVIDER}' created."
fi

# Allow the GitHub Actions workflow to impersonate the deploy SA.
WIF_POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_RESOURCE}/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}" \
  --project="$PROJECT_ID" \
  --quiet
echo "    Workload Identity binding set."

# ── 9. Output GitHub secrets to configure ────────────────────────────────────
echo ""
echo "--- [9/9] GitHub Actions secrets to add"
echo ""
echo "Add the following as secrets on the GitHub Environment named \"gcp\""
echo "(repo: https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/settings/environments):"
echo ""

WIF_PROVIDER_RESOURCE="${WIF_POOL_RESOURCE}/providers/${WIF_PROVIDER}"
echo "  GCP_PROJECT_ID                  = ${PROJECT_ID}"
echo "  GCP_REGION                      = ${REGION}"
echo "  GCP_DEPLOY_SA                   = ${DEPLOY_SA}"
echo "  GCP_WORKLOAD_IDENTITY_PROVIDER  = ${WIF_PROVIDER_RESOURCE}"
echo ""
echo "  # Optional (defaults shown):"
echo "  HEAT_TARGET_TEMP_C              = 16"
echo "  HUMIDITY_HIGH_THRESHOLD         = 70"
echo "  HUMIDITY_LOW_THRESHOLD          = 60"
echo "  DRY_DURATION_MINUTES            = 120"
echo "  LOG_LEVEL                       = info"
echo ""
echo "=== Bootstrap complete. ==="
echo ""
echo "Production runtime uses Firestore for the rotating refresh token."
echo "After your first deploy, bootstrap Firestore once by running oauth-exchange"
echo "with DAIKIN_TOKEN_STORE=firestore and the production Firestore document settings."
echo ""
echo "Next: add the GitHub secrets above, then push to main to trigger the first deploy."
echo "After the first deploy, run setup/create-scheduler-jobs.sh to create Scheduler jobs."
