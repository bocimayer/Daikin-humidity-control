# Production setup checklist

**Product:** Daikin Humidity Control (`daikin-humidity-control` on Cloud Run).  
**Goal:** Private app + Onecta auth + Firestore token store + optional Scheduler.  
**Order:** Finish **auth + live API** before **Scheduler** (your preference matches this doc).

---

## What the OAuth stub is

Daikin’s developer portal requires an HTTPS **redirect URI** that is **not** `localhost`. The repo includes a **separate** public Cloud Run service **`daikin-oauth-stub`** (`oauth-stub/`, workflow `deploy-oauth-stub.yml`). It only serves a small callback page so the browser OAuth flow can return to something like:

`https://<stub-host>/oauth/callback`

The **main** app (`daikin-humidity-control`) stays **private** (OIDC from Scheduler only, plus CI smoke tests). Do not confuse the stub URL with the main service URL.

---

## Why “drift” happened

Two things evolved at different speeds:

1. **Cloud Run runtime identity** moved from the default compute service account to a dedicated **`daikin-runtime-sa`** in GitHub Actions workflows.
2. **`setup/bootstrap.sh` and manual README snippets** still described the older default for a while.

`setup/bootstrap.sh` now creates **`daikin-runtime-sa`** and grants it Secret Manager + Firestore access, matching the workflows. If you bootstrapped earlier, verify IAM on **`daikin-runtime-sa`** in the GCP console (Secret Accessor on both Daikin secrets, `roles/datastore.user` on the project).

---

## Phase A — GitHub Environment `gcp`

Must exist with secrets used by workflows (names only; values in GitHub UI):

- `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SA`
- Optional tuning: `HEAT_TARGET_TEMP_C`, `HUMIDITY_HIGH_THRESHOLD`, `HUMIDITY_LOW_THRESHOLD`, `MODE_STRATEGY`, `DRY_DURATION_MINUTES`, `LOG_LEVEL`

**Remove after next successful deploy** (no longer read by the app):

- `DAIKIN_DEVICE_IDS_JSON`
- `DAIKIN_HUMIDITY_LEADER_IDS_JSON`

Device UUIDs are loaded at runtime from Onecta `GET /v1/gateway-devices` (`src/device-ids.ts`).

---

## Phase B — GCP one-time bootstrap

From a machine with `gcloud` and owner permissions on the project:

1. Run `bash setup/bootstrap.sh` (see `README.md` for exports).  
2. Confirm Secret Manager has **`DAIKIN_CLIENT_ID`** and **`DAIKIN_CLIENT_SECRET`**.  
3. Confirm **`daikin-runtime-sa`**, **`daikin-deploy-sa`**, and **`daikin-scheduler-sa`** exist.  
4. Add deploy-SA smoke IAM if not already present (see `DEPLOYMENT_READINESS.md` — TokenCreator on self + Run Invoker on the main service).

---

## Phase C — Deploy services

1. Push to `main` (or run Actions manually): **Deploy to Cloud Run** → `daikin-humidity-control`.  
2. Deploy **Deploy OAuth stub (Cloud Run)** so the redirect URI exists.  
3. In the Daikin developer portal, register **`https://<oauth-stub-url>/oauth/callback`** as redirect URI (exact string).

---

## Phase D — Seed Firestore refresh token (**required**)

Production uses **`DAIKIN_TOKEN_STORE=firestore`** and document **`oauth_tokens/daikin_onecta`** (defaults). **Cloud Run cannot call Onecta until this document contains a non-empty `refreshToken`.** This phase **must** complete; there is no “if already” branch for a new project.

### D1 — Fast path when local dev already works (same Daikin app)

If `npm run daikin:live-smoke` or `npm run test:onnecta` already works locally, your machine has a valid refresh token in the **local file** store (default: `%APPDATA%\daikin-humidity-control\refresh-token.json` on Windows, or `DAIKIN_TOKEN_FILE_PATH` if you set it).

1. Authenticate ADC to the **production** GCP project (same project as Cloud Run):

   `gcloud auth application-default login`

   If `npm run daikin:seed-firestore-from-local` fails with **`invalid_grant`** / “Getting metadata from plugin failed”, ADC is expired or wrong — run **`gcloud auth application-default login`** again (or use a service account key file via `GOOGLE_APPLICATION_CREDENTIALS` only if your org allows it).

2. From repo root, with **`GOOGLE_CLOUD_PROJECT`** set to that project id:

   `npm run daikin:seed-firestore-from-local`

   Optional: `SOURCE_TOKEN_FILE=…` if the token file is not at the default path. Optional: `DAIKIN_FIRESTORE_COLLECTION` / `DAIKIN_FIRESTORE_DOCUMENT` if you changed them from defaults.

3. **Verify:** Firestore console → `oauth_tokens` → `daikin_onecta` → field **`refreshToken`** present (do not copy the value into chat).

### D2 — Browser path when you do not yet have a local file token

1. Set `DAIKIN_TOKEN_STORE=firestore` and the same `DAIKIN_FIRESTORE_*` as production.  
2. Set `DAIKIN_REDIRECT_URI` to the **stub** HTTPS callback from Phase C (or any URI registered in the Daikin portal for this app).  
3. `npm run daikin:oauth-url` → browser login → `npm run daikin:oauth-exchange -- '<code>'`.

Do **not** paste refresh tokens or client secrets into chat or commit them.

---

## Phase E — Prove Onecta from prod-shaped config

On a trusted machine (or Cloud Shell with ADC):

1. `npm run test:onnecta` with env pointing at the same Onecta app + token store as production **or**  
2. `npm run daikin:live-smoke` — lists devices via `GET /v1/gateway-devices` (same source the service uses).

---

## Phase F — Prove Cloud Run task endpoints (manual)

With a valid **OIDC** token (Scheduler SA or `gcloud auth print-identity-token` with audience = main service URL), `POST` the task routes (`/tasks/dry-start`, etc.) against the **private** service URL. Confirm logs and device behaviour.

**Only after** Phase D–F pass: proceed to Scheduler.

---

## Phase G — Cloud Scheduler (last)

Run `bash setup/create-scheduler-jobs.sh` after the main service URL is stable (`README.md`).  
Confirm **`daikin-scheduler-sa`** has **`roles/run.invoker`** on `daikin-humidity-control` (the script grants it).

---

## Phase H — Ongoing operations

- Monitor Cloud Run logs and Daikin daily quota (`README.md` — humidity mode uses more calls per poll because every gateway device is read).  
- Re-auth only if Daikin revokes the app or the refresh token is lost (`DEPLOYMENT_READINESS.md`).

---

## “Done” quick check

1. GitHub `gcp` env has required secrets; legacy device JSON secrets removed.  
2. Secret Manager + Firestore + three service accounts exist.  
3. Both Cloud Run services deployed; stub redirect registered in Daikin portal.  
4. Firestore token document has `refreshToken`.  
5. Live-smoke or integration test lists real devices.  
6. Manual authenticated `POST` to `/tasks/*` succeeds.  
7. Scheduler jobs created and a manual `gcloud scheduler jobs run …` succeeds.
