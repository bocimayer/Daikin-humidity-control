# Deployment Readiness

## Purpose

This document describes everything required to turn `daikin-humidity-control`
into a real deployed product.

It covers:

- Daikin developer setup
- GCP infrastructure
- CI/CD pipeline requirements
- production token handling
- Cloud Scheduler setup
- operational readiness
- current blockers in this repo

---

## System Overview

There are two deployed services:

1. `daikin-oauth-stub`
   - public Cloud Run service
   - provides a stable HTTPS OAuth redirect URI for Daikin
2. `daikin-humidity-control`
   - private Cloud Run service
   - called by Cloud Scheduler with OIDC
   - reads humidity and controls Daikin devices

There are also two different kinds of auth state:

1. Static credentials
   - `DAIKIN_CLIENT_ID`
   - `DAIKIN_CLIENT_SECRET`
2. Mutable token state
   - latest rotating `refreshToken`

These must not be stored the same way.

---

## Production Auth Model

The intended production auth flow is:

1. A human completes the browser OAuth consent flow once.
2. That produces the first valid `refresh_token`.
3. The first refresh token is stored in Firestore.
4. Cloud Run reads the latest refresh token from Firestore.
5. Cloud Run exchanges it for short-lived access tokens as needed.
6. If Daikin rotates the refresh token, Cloud Run writes the new one back to Firestore.

This means:

- Secret Manager stores static app credentials.
- Firestore stores the latest rotating refresh token.
- GitHub Actions should not manage the rotating refresh token.

---

## Required GCP Services

These APIs must be enabled:

- `run.googleapis.com`
- `cloudscheduler.googleapis.com`
- `secretmanager.googleapis.com`
- `iam.googleapis.com`
- `iamcredentials.googleapis.com`
- `artifactregistry.googleapis.com`
- `cloudbuild.googleapis.com`
- `firestore.googleapis.com`

---

## Required GCP Resources

### Cloud Run

You need:

- one private service: `daikin-humidity-control`
- one public service: `daikin-oauth-stub`

### Artifact Registry

You need:

- one Docker repo, currently assumed to be `daikin`

### Secret Manager

You need these static secrets:

- `DAIKIN_CLIENT_ID`
- `DAIKIN_CLIENT_SECRET`

Do not use Secret Manager as the long-term storage for the rotating refresh token.

### Firestore

You need a document for the latest refresh token.

Recommended shape:

- collection: `oauth_tokens`
- document: `daikin_onecta`

Recommended fields:

- `refreshToken`
- `updatedAt`
- `source`

### Cloud Scheduler

You need jobs that call the main Cloud Run service over HTTPS with OIDC.

**Pause / resume scheduled humidity (auto dry) without a redeploy:** from **`Daikin-humidity-control/`**, `bash setup/disable-auto-dry.sh` pauses job **`daikin-check-humidity`** only; `bash setup/enable-auto-dry.sh` resumes it. Npm: **`daikin:auto-dry:disable`** / **`daikin:auto-dry:enable`**. Nightly **`daikin-dry-stop-safety`** is unchanged. For an app-wide kill switch, use **`AUTOMATION_ENABLED=false`** (see `README.md`).

**Browser UI (`/ops/scheduler`):** **Firebase Authentication** (Google) + **`FIREBASE_WEB_API_KEY`** on Cloud Run (see **`.github/workflows/deploy.yml`**). Operators use the Cloud Run **`https://…run.app/ops/scheduler`** URL (ingress is **allow-unauthenticated**; **`/tasks/*`** remains OIDC-only in the app). The **runtime** service account must verify Firebase tokens (**Firebase Authentication Admin** / Admin SDK) and call Cloud Scheduler on **`daikin-check-humidity`** (see **`setup/grant-runtime-scheduler-ops-iam.sh`**). Optional **`ALLOWED_OPS_EMAILS`**.

---

## Required IAM

### Deploy service account

Used by GitHub Actions to deploy.

Current repo expects:

- `daikin-deploy-sa`

Required roles:

- `roles/run.admin`
- `roles/artifactregistry.writer`
- `roles/iam.serviceAccountUser`
- `roles/secretmanager.viewer`

### Scheduler service account

Used by Cloud Scheduler to call the private app.

Current repo expects:

- `daikin-scheduler-sa`

Required role:

- `roles/run.invoker` on `daikin-humidity-control`

### Cloud Run runtime service account

Used by the running app itself.

GitHub Actions deploy workflows run both services as **`daikin-runtime-sa@PROJECT_ID.iam.gserviceaccount.com`**
(`setup/bootstrap.sh` creates this account and grants the access below).

Required access:

- Secret Manager read access for:
  - `DAIKIN_CLIENT_ID`
  - `DAIKIN_CLIENT_SECRET`
- Firestore read/write access for the token document

Suggested role:

- `roles/datastore.user`

---

## CI smoke test IAM (deploy service account)

The deploy workflow calls `generateIdToken` and `curl`s private Cloud Run. That needs:

- `roles/iam.serviceAccountTokenCreator` on **itself** for `daikin-deploy-sa`
- `roles/run.invoker` on `daikin-humidity-control` for `daikin-deploy-sa`

These are **not** created by the original bootstrap loop; add them if smoke tests fail with IAM errors.

---

## Required GitHub Actions Secrets

Configure these on the GitHub **Environment** `gcp` (see `.github/workflows/deploy.yml`).

At minimum:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SA`

Optional runtime tuning:

- `HEAT_TARGET_TEMP_C`
- `HUMIDITY_HIGH_THRESHOLD`
- `HUMIDITY_LOW_THRESHOLD`
- `DRY_DURATION_MINUTES`
- `LOG_LEVEL`
- `DAIKIN_RESTORE_COLLECTION` (Firestore collection for pre-dry Onecta snapshots; default `device_restore_state`)
- `AUTOMATION_ENABLED` (`true` by default; `false` / `0` / `off` / `disabled` skips `dry-start`, `dry-stop`, `check-humidity`)
- `DAIKIN_WRITE_CONCURRENCY` (default `1`, max `3` — cap concurrent Onecta gateway GET+PATCH)
- `DAIKIN_HTTP_PACE_MS` (default `75`; `0` disables pacing between gated Onecta calls — mitigates Daikin `429` on large restores)

Optional notifications (set on GitHub Environment `gcp` if you use them; **do not paste refresh tokens into chat** — use **`/guide`** in Cursor for one-step-at-a-time setup):

- `NOTIFY_EMAIL`
- `GMAIL_SENDER`
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `NOTIFY_WEBHOOK_URL`

---

## Required Cloud Run Runtime Configuration

The main app should run with environment like:

```text
NODE_ENV=production
DAIKIN_TOKEN_STORE=firestore
DAIKIN_FIRESTORE_COLLECTION=oauth_tokens
DAIKIN_FIRESTORE_DOCUMENT=daikin_onecta
DAIKIN_RESTORE_COLLECTION=device_restore_state
HEAT_TARGET_TEMP_C=16
HUMIDITY_HIGH_THRESHOLD=70
HUMIDITY_LOW_THRESHOLD=60
DRY_DURATION_MINUTES=120
LOG_LEVEL=info
AUTOMATION_ENABLED=true
DAIKIN_WRITE_CONCURRENCY=1
DAIKIN_HTTP_PACE_MS=75
EXPECTED_AUDIENCE=<Cloud Run service URL>
NOTIFY_EMAIL=<optional>
GMAIL_SENDER=<optional>
GMAIL_OAUTH_CLIENT_ID=<optional>
GMAIL_OAUTH_CLIENT_SECRET=<optional>
GMAIL_REFRESH_TOKEN=<optional>
NOTIFY_WEBHOOK_URL=<optional>
```

Static secrets should be mounted from Secret Manager:

- `DAIKIN_CLIENT_ID`
- `DAIKIN_CLIENT_SECRET`

The rotating refresh token should come from Firestore, not a static mounted env var.

**Restore snapshots:** the Cloud Run runtime service account must be able to **read and write** documents in `DAIKIN_RESTORE_COLLECTION` (same GCP project as the token store). This is typically already allowed if the SA has project-wide Firestore access; confirm if you use tighter IAM.

---

## Daikin Developer Portal Setup

You need an application in the Daikin developer portal with:

- auth strategy: `Onecta OIDC`
- a registered HTTPS redirect URI
- a client ID
- a client secret

The redirect URI should point to the public OAuth stub:

```text
https://<oauth-stub-url>/oauth/callback
```

---

## One-Time Production Bootstrap

This is the one manual step that cannot be avoided.

1. Deploy `daikin-oauth-stub`.
2. Register its callback URL in the Daikin developer portal.
3. Run the OAuth flow once.
4. Exchange the authorization code.
5. Store the first valid refresh token in Firestore.

After that, production should keep itself alive automatically by rotating the token in Firestore.

---

## Scheduler Design

### Timer mode

Jobs:

- `POST /tasks/dry-start`
- `POST /tasks/dry-stop`

### Humidity mode

Jobs:

- `POST /tasks/check-humidity`
- `POST /tasks/dry-stop` as a safety stop

All scheduler jobs must:

- use OIDC
- use the scheduler service account
- set OIDC audience to the Cloud Run service URL

### Multi indoor units / one outdoor (behaviour)

The app assumes **one shared outdoor heat pump** feeding several wall units. It **refuses** to start or stop a dry cycle unless **all** reported gateway heads share compatible states (see `src/dry-cycle-guards.ts`):

- **Dry-start** (timer or humidity-driven): every head must report the **same** `operationMode`; dry is **refused only when that mode is `cooling`** (compressor already dehumidifies). **`fanOnly`**, **`heating`**, **`auto`**, etc. are allowed when homogeneous. Never a **mixed** cluster.
- **Dry-stop**: every head must still report **`dry`** before restore runs (avoids restoring while one head already left DRY — e.g. after a partial `429` failure).
- Successful **`dry-start` / `dry-stop`** update the humidity FSM `active` flag; **skipped** or **failed** runs do not pretend the plant changed.

If operators see **`skipped`** with `heterogeneous-operation-modes`, `mixed-dry-state`, or `429` errors in logs, **manually align** all indoor heads to the same mode, then let the next scheduler run retry.

---

## Production Validation Checklist

After deployment, verify all of these:

### OAuth and token flow

- OAuth stub is public and reachable
- Daikin redirect URI is correctly registered
- first refresh token is stored in Firestore
- Cloud Run can read Firestore
- Cloud Run can write rotated refresh tokens back to Firestore

### Main app

- `daikin-humidity-control` is deployed successfully
- `EXPECTED_AUDIENCE` matches the real Cloud Run URL
- `GET /health` returns `200` (avoid `/healthz` on Cloud Run — Google's edge returns HTML 404 for that path)
- private `/tasks/*` endpoints reject unauthenticated traffic
- scheduler OIDC calls are accepted

### Daikin integration

- `GET /v1/gateway-devices` works from Cloud Run (device set is dynamic — no env JSON list)
- read device state / raw gateway payloads work
- write one reversible control action works
- a fresh Cloud Run instance still works after a token refresh
- optional: `POST /tasks/dry-start` returns `skipped` with `modesByDeviceId` when heads disagree (expected until aligned)

### Scheduler

- jobs exist
- jobs run on schedule
- manual job execution works
- logs show successful execution
- optional: you can **pause** `daikin-check-humidity` via **`setup/disable-auto-dry.sh`** when you want to stop auto dry without changing Cloud Run config (`README.md`)

### Operations

- logs are visible in Cloud Logging
- token refresh failures are visible in logs
- Firestore token document updates after rotation
- quota usage stays within Onecta limits
- optional: after a controlled task run, task notification (Gmail or webhook) appears as configured — verify without pasting secrets into tickets
- optional: from a trusted environment with valid `.env`, `npm run test:onnecta` passes including dry → snapshot restore on real hardware

---

## Operational Runbooks You Need

You should have procedures for:

- initial production bootstrap
- re-auth after token expiry or revocation
- Firestore token document missing or corrupted
- scheduler stopped or misconfigured
- Cloud Run runtime IAM broken
- Daikin `invalid_grant` recovery

---

## Remaining Gaps

These are the main blockers before this becomes production-ready.

### 1. Firestore bootstrap still needs an explicit operator step

The app supports Firestore token persistence, but production still needs:

- Firestore database initialized in the target project
- a documented operator step to write the first refresh token into Firestore

### 2. Production bootstrap helper is still manual

The documented bootstrap path works, but it is still driven by the OAuth helper
scripts plus operator-supplied Firestore settings. There is no dedicated
production bootstrap helper yet.

### 3. Docs vs bootstrap drift (historical)

GitHub Actions deploys Cloud Run with runtime identity **`daikin-runtime-sa`**
(see workflows). Older copies of `setup/bootstrap.sh` granted Secret Manager /
Firestore roles to the **default compute** service account. If you used an old
bootstrap, re-check IAM on **`daikin-runtime-sa`** matches `README.md` / GCP
console. Canonical operator checklist: `docs/PRODUCTION_SETUP.md`.

---

## What "Done" Looks Like

This is production-ready when all of the following are true:

1. OAuth stub is deployed and registered with Daikin.
2. Main app is deployed privately on Cloud Run.
3. Static credentials are in Secret Manager.
4. Latest refresh token is in Firestore.
5. Cloud Run can read and update that Firestore token.
6. Scheduler calls the app successfully with OIDC.
7. A cold start after token rotation still succeeds without human action.
8. Re-auth is only needed when Daikin auth is revoked or expires.

---

## Recommended Next Work Items

1. Add a production bootstrap helper that writes the first refresh token into Firestore.
2. Add a post-deploy verification step that confirms Firestore token read/write works.
3. Write a short runbook for production re-auth and token recovery.

Operator checklist: **`docs/PRODUCTION_SETUP.md`**.
