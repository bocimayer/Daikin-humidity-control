# Daikin Humidity Control

A production-ready TypeScript/Node.js 20 service that controls Daikin AC units
via the [Daikin Onecta cloud API](https://developer.cloud.daikineurope.com/)
with **no local hardware**. Deployed on Google Cloud Run, triggered by Cloud
Scheduler, with static credentials in Secret Manager and the rotating production
refresh token in Firestore.

**OAuth stub (`daikin-oauth-stub`):** Daikin’s portal requires a **non-localhost** HTTPS redirect URI for the browser login. The small public Cloud Run app under `oauth-stub/` hosts `/oauth/callback` so `DAIKIN_REDIRECT_URI` can point there during onboarding. It is **not** the humidity-control service; see `docs/PRODUCTION_SETUP.md`.

**Changelog:** [`CHANGELOG.md`](CHANGELOG.md)

---

## Architecture

**Production checklist:** `docs/PRODUCTION_SETUP.md` (ordered gates: GitHub env → GCP → deploy → Firestore token → live tests → Scheduler).

```
Cloud Scheduler
  │  (OIDC-authenticated HTTP POST)
  ▼
Cloud Run  (private — no public access)
  └─ Express app
       ├─ POST /tasks/dry-start       ← preflight cluster modes, then DRY (blocked from **cooling** only; shared outdoor unit)
       ├─ POST /tasks/dry-stop        ← preflight all-in-dry, then restore Firestore snapshot (fallback: HEAT + setpoint)
       ├─ POST /tasks/check-humidity  ← sequential reads, cluster gate, max-RH hysteresis (pure FSM; setActive after Onecta success)
       ├─ POST /tasks/notify-test     ← sends one Gmail test message (OIDC); does not call Onecta
       ├─ GET  /tasks/device-status   ← read-only snapshot (still OIDC on /tasks)
       └─ GET  /health                ← liveness probe (not /healthz on Cloud Run — see routes.ts)

  Internal modules
  ├─ DaikinClient   — Onecta OAuth2 + device ops (token refresh, retry, shared HTTP gate + optional pace between calls)
  ├─ dry-cycle-guards — multi-head policy (homogeneous modes, dry entry blocked **only** in `cooling`, dry-stop only when all dry)
  ├─ HumidityFSM    — hysteresis decisions (high/low); active flag updated only after successful dry-start/stop
  ├─ IdempotencyGuard — in-memory dedup (10-min window per task; runs after successful preflight for dry-start/stop)
  └─ requireSchedulerAuth — OIDC JWT middleware (google-auth-library)

Secrets/state:
├─ Secret Manager → static app credentials (`DAIKIN_CLIENT_ID`, `DAIKIN_CLIENT_SECRET`)
└─ Firestore     → latest rotating refresh token in production; per-device pre-dry snapshots in `DAIKIN_RESTORE_COLLECTION` (restore after dry-stop)
```

### Quota budget (Daikin private dev app — 200 calls/day)

| Scenario | Calls/day |
|---|---|
| 4 devices, 1 manual dry cycle (dry-start + dry-stop) | ~10 |
| 2 devices, 8 check-humidity polls/day | ~18 |
| 4 devices, 8 polls/day | ~24 |

Poll no more than every 3 hours on `/tasks/check-humidity` to stay within quota.

---

## Humidity automation (only model)

Cloud Scheduler calls **`POST /tasks/check-humidity`** on a fixed cadence (for example every 3 hours). The hysteresis FSM compares **max(RH)** across heads to **`HUMIDITY_HIGH_THRESHOLD`** / **`HUMIDITY_LOW_THRESHOLD`** and decides whether to invoke the same dry-start / dry-stop logic the service uses everywhere else.

**`POST /tasks/dry-start`** and **`POST /tasks/dry-stop`** remain OIDC endpoints for **manual runs**, safety jobs, and internal use after `check-humidity` decides — not a separate “timer product mode.”

**Multi indoor / one outdoor:** before any Onecta writes, the service reads every gateway device and requires **one shared `operationMode`** across heads. **Dry-start** is allowed from **any** homogeneous mode **except `cooling`** — in cooling the compressor already dehumidifies, so we do not stack an explicit DRY. **`fanOnly`**, **`heating`**, **`auto`**, etc. are all valid baselines when every head matches. If heads disagree, the task returns **`200`** with `{ "skipped": true, "reason": "…", "modesByDeviceId": {…} }` and does **not** call idempotency for that attempt.

**Cluster gate:** the same **homogeneous mode** rules apply before RH is used (no mixed dry, no unknown `operationMode`). **Humidity** for the decision is the **maximum** of non-null % RH readings **only from heads that actually returned a value** in the Onecta payload (`sensoryData` in `daikin.ts`). In real rooms, **whether a powered-down or idle wall unit still publishes indoor RH** depends on that model and what Onecta returns — if RH is `null`, that head does not contribute to max(RH). Use **`npm run daikin:humidity-snapshot`** (read-only live script; set `DOTENV_CONFIG_PATH` to your real `.env` if it is not in the repo) to see `operationMode` and `humidity` per device. If **no** head returns humidity, the handler returns `no-humidity-data`. A **start** still requires **dry-start preflight** (homogeneous, not all `cooling`). A **stop** requires **every** head to report **`dry`** before `dry-stop` runs.

```
[every 3 h] Scheduler → POST /tasks/check-humidity
               if cluster invalid                                                      → no-action + reason
               if max(RH) ≥ HIGH (inactive FSM) and dry-start preflight OK              → dry-start
               if max(RH) ≤ LOW (active FSM) and all heads still dry                  → dry-stop
               else                                                                   → no-action
[00:00] Scheduler → POST /tasks/dry-stop  (safety stop — still runs preflight; may skip if cluster not all-dry)
```

**Scheduler setup:** from repo root, with `gcloud` authenticated and `PROJECT_ID` / `REGION` set, run **`bash setup/create-scheduler-jobs.sh`**. It removes legacy **`daikin-dry-start`** / **`daikin-dry-stop`** timer jobs if they exist and **upserts** **`daikin-check-humidity`** plus **`daikin-dry-stop-safety`**.

**Mail test:** `POST /tasks/notify-test` with the same OIDC token as other `/tasks/*` routes (see `docs/PRODUCTION_SETUP.md`). Successful dry-start, dry-stop, and every check-humidity outcome also trigger mail when Gmail notify env vars are set.

---

## Runtime environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `8080` | HTTP listen port |
| `NODE_ENV` | no | `development` | Set to `production` in Cloud Run |
| `DAIKIN_CLIENT_ID` | **yes** | — | Onecta OAuth client ID |
| `DAIKIN_CLIENT_SECRET` | **yes** | — | Onecta OAuth client secret |
| `DAIKIN_REFRESH_TOKEN` | no | — | Optional bootstrap refresh token used only when the token store is empty |
| `DAIKIN_BASE_URL` | no | `https://api.onecta.daikineurope.com` | API base URL |
| `DAIKIN_AUTH_URL` | no | `https://idp.onecta.daikineurope.com/v1/oidc/token` | Token endpoint |
| `DAIKIN_TOKEN_STORE` | no | `local-file` in development, `firestore` in production | Where the latest rotating refresh token is stored |
| `DAIKIN_TOKEN_FILE_PATH` | no | OS-specific app-data path | Local development token file path |
| `DAIKIN_FIRESTORE_COLLECTION` | no | `oauth_tokens` | Firestore collection for the latest rotating refresh token |
| `DAIKIN_FIRESTORE_DOCUMENT` | no | `daikin_onecta` | Firestore document id for the latest rotating refresh token |
| `DAIKIN_RESTORE_COLLECTION` | no | `device_restore_state` | Firestore collection for per-device snapshots of settable Onecta characteristics (capture before DRY, replay on dry-stop) |
| `DRY_DURATION_MINUTES` | no | `120` | Informational — used to space Scheduler jobs |
| `HEAT_TARGET_TEMP_C` | no | `16` | Frost-protection setpoint when dry-stop **cannot** restore from snapshot (fallback if snapshot missing or unit still in DRY after replay) |
| `HUMIDITY_HIGH_THRESHOLD` | no | `70` | % RH — **max** reading across devices at/above this starts dry (when not already in dry cycle) |
| `HUMIDITY_LOW_THRESHOLD` | no | `60` | % RH — **max** reading at/below this stops dry (when in dry cycle) |
| `LOG_LEVEL` | no | `info` | `trace` `debug` `info` `warn` `error` `fatal` |
| `AUTOMATION_ENABLED` | no | `true` | Master switch: `false` / `0` / `off` / `disabled` skips `dry-start`, `dry-stop`, and `check-humidity` (still logs). Change via Cloud Run env / Secret Manager — not a public URL. |
| `DAIKIN_WRITE_CONCURRENCY` | no | `1` | Max concurrent Onecta **gateway** HTTP calls (GET+PATCH) per process (`1`–`3`). Default `1` serializes all Onecta traffic. |
| `DAIKIN_HTTP_PACE_MS` | no | `75` | Minimum ms between gated Onecta HTTP completions (sleep while holding the slot). Reduces `429` bursts on heavy `dry-stop` restores; set `0` to disable. |
| `EXPECTED_AUDIENCE` | **yes** | — | Cloud Run service URL (OIDC audience check) |
| `NOTIFY_EMAIL` | no | — | Optional — recipient for task notifications (requires all `GMAIL_*` below to send mail) |
| `GMAIL_SENDER` | no | — | Optional — From address for Gmail API (must match an authorized send-as identity) |
| `GMAIL_OAUTH_CLIENT_ID` | no | — | Optional — Gmail OAuth 2.0 client id |
| `GMAIL_OAUTH_CLIENT_SECRET` | no | — | Optional — Gmail OAuth 2.0 client secret |
| `GMAIL_REFRESH_TOKEN` | no | — | Optional — OAuth refresh token for the sending identity (store in Secret Manager / GitHub env in production; never commit) |
| `NOTIFY_WEBHOOK_URL` | no | — | Optional — HTTPS URL for JSON POST when tasks complete (Zapier/Make/custom) |

**Gateway devices:** the service does **not** take device UUIDs from env. On each task it calls Onecta `GET /v1/gateway-devices` and uses **every** returned device for dry-start/stop and for humidity reads (null humidity on a unit is skipped for **max RH**, but the head is still included in **mode** preflight). See `src/device-ids.ts`, `src/dry-cycle-guards.ts`, and `docs/PRODUCTION_SETUP.md`.

### OAuth helper variables

These are used by the local onboarding scripts, not by the main runtime server:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DAIKIN_REDIRECT_URI` | **yes** for OAuth bootstrap | — | Redirect URI registered in the developer portal |
| `DAIKIN_AUTHORIZE_URL` | no | `https://idp.onecta.daikineurope.com/v1/oidc/authorize` | Optional authorize endpoint override for the helper |
| `DAIKIN_AUTH_CODE` | no | — | Optional environment alternative to passing the one-time code as a CLI argument |

### Test-only variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DAIKIN_INTEGRATION_TEST` | no | — | Enables live Onecta integration tests when set to `1` |

---

## Local development

```bash
# 1. Copy env file and fill in values
cp .env.example .env
# Edit .env — set static DAIKIN_* credentials and token-store settings

# 2. Install dependencies
npm install

# 3. Bootstrap the local token store once (browser login + one-time code exchange)
npm run daikin:oauth-url
npm run daikin:oauth-exchange -- '<code>'

# 4. Run with hot-reload (auth check is skipped in development)
npm run dev

# 5. Test endpoints
curl http://localhost:8080/health
curl -X POST http://localhost:8080/tasks/dry-stop
curl -X POST http://localhost:8080/tasks/check-humidity
```

---

## Tests

```bash
npm test              # run all tests (offline unit tests only)
npm run test:coverage # with coverage report
npm run test:onnecta  # live Onecta: list/read, reversible setpoint PATCH, dry → snapshot restore on first device (needs valid .env)
npm run daikin:live-smoke   # same flow as a CLI script (optional: device id, --raw, --read-only)
npm run daikin:humidity-snapshot  # read-only: list devices + operationMode + humidity (no PATCH). Set `DOTENV_CONFIG_PATH` to an absolute path if your credentials live outside the repo. If Onecta returns **`invalid_grant`**, re-run browser OAuth and `npm run daikin:oauth-exchange` (local refresh token expired or revoked).
npm run daikin:seed-firestore-from-local  # copy local refresh-token.json → Firestore (needs GOOGLE_CLOUD_PROJECT + ADC); see docs/PRODUCTION_SETUP.md
```

`test:onnecta` sets `DAIKIN_INTEGRATION_TEST=1` via `cross-env`. If the token store is empty or expired, run the browser OAuth flow and `npm run daikin:oauth-exchange` once to bootstrap it again.

Local development uses the configured local token file as the source of truth for the rotating refresh token. The repo `.env` file is bootstrap/static config only.

Unit test suites (default `npm test`):
- `tests/hysteresis.test.ts` — HumidityStateMachine transitions (pure `evaluate`; `setActive` mirrors successful tasks)
- `tests/dry-cycle-guards.test.ts` — cluster preflight (homogeneous modes, dry entry blocked in `cooling` only, dry-stop all-dry)
- `tests/humidity-max-aggregation.test.ts` — max-RH vs average contract for FSM input
- `tests/idempotency.test.ts` — IdempotencyGuard allow/block/reset
- `tests/config.test.ts` — Zod schema validation and defaults
- `tests/device-ids.test.ts` — gateway device list helper
- `tests/onecta-snapshot.test.ts` — settable-characteristic snapshot + restore sort order
- `tests/task-notify.test.ts` — optional Gmail + webhook notifications

Live API (separate Jest config, `npm run test:onnecta`):
- `tests/daikin-onecta.integration.test.ts` — real Onecta list / read / reversible setpoint nudge / dry cycle with full settable-characteristic restore

Settable-characteristic inventory (reviewer / operator): run `npx ts-node scripts/dump-onecta-settable.ts` against live units; see `data/onecta-settable-inventory.sample.json` for JSON shape.

---

## Build

```bash
npm run build    # compiles src/ → dist/
npm run lint     # type-check only (no emit)
```

---

## Docker

```bash
# Build
docker build -t daikin-humidity-control .

# Run locally (NODE_ENV=development skips OIDC)
docker run --rm -p 8080:8080 \
  --env-file .env \
  daikin-humidity-control

curl http://localhost:8080/health
```

---

## CI/CD Pipeline

Two GitHub Actions workflows handle testing and deployment automatically.

### Workflows

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | Every push / PR | Type-check, test, build — fast feedback |
| `.github/workflows/deploy.yml` | Push to `main` / manual | Build Docker image → push to Artifact Registry → deploy Cloud Run → smoke test |

Authentication uses **Workload Identity Federation** (keyless — no long-lived SA JSON key stored in GitHub).

### First-time setup (run once locally)

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=europe-central2
export GITHUB_ORG=bocimayer
export GITHUB_REPO=Daikin-humidity-control

bash setup/bootstrap.sh
```

The script:
1. Enables required GCP APIs
2. Creates an Artifact Registry Docker repository (`daikin`)
3. Creates a deploy service account (`daikin-deploy-sa`) with the minimum roles
4. Creates a scheduler service account (`daikin-scheduler-sa`)
5. Prompts for static Daikin app credentials and stores them in Secret Manager
6. Grants the Cloud Run runtime service account Secret Manager read access and Firestore write access
7. Sets up Workload Identity Federation (GitHub → GCP, no JSON key)
8. Prints the exact GitHub secrets you need to add

### GitHub secrets to configure

After running bootstrap.sh, add the printed secrets to the GitHub **Environment** named **`gcp`** (the deploy workflows use `environment: gcp`), or mirror the same names as repository Actions secrets if you choose not to use environments.

| Secret | Example value |
|---|---|
| `GCP_PROJECT_ID` | `my-gcp-project-123` |
| `GCP_REGION` | `europe-central2` |
| `GCP_DEPLOY_SA` | `daikin-deploy-sa@my-gcp-project-123.iam.gserviceaccount.com` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/123456/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `HEAT_TARGET_TEMP_C` *(optional)* | `16` |
| `HUMIDITY_HIGH_THRESHOLD` *(optional)* | `70` |
| `HUMIDITY_LOW_THRESHOLD` *(optional)* | `60` |
| `DRY_DURATION_MINUTES` *(optional)* | `120` |
| `LOG_LEVEL` *(optional)* | `info` |
| `AUTOMATION_ENABLED` *(optional)* | `true` — set `false` to no-op Onecta tasks without redeploying code |
| `DAIKIN_HTTP_PACE_MS` / `DAIKIN_WRITE_CONCURRENCY` *(optional)* | tune if you hit Onecta `429` (see env table) |

> The static Daikin app credentials (`DAIKIN_CLIENT_ID`, `DAIKIN_CLIENT_SECRET`)
> live in Secret Manager. The latest rotating refresh token lives in Firestore
> so Cloud Run can update it after each refresh. The GitHub Actions pipeline does
> not own or rotate the refresh token.

### Deploy

Once secrets are set, push to `main`:

```bash
git push origin main
```

The pipeline runs tests first; if they pass it builds the image, pushes to Artifact Registry, deploys to Cloud Run, and runs a `/health` smoke test. The job summary shows the deployed URL.

For a manual trigger: **Actions → Deploy to Cloud Run → Run workflow**.

### Create Cloud Scheduler jobs (run once after first deploy)

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=europe-central2
export TIME_ZONE="Europe/Budapest"

bash setup/create-scheduler-jobs.sh
```

---

## GCP Deployment

### Prerequisites

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=europe-central2          # adjust to your preferred region
export SERVICE_NAME=daikin-humidity-control
export SCHEDULER_SA=daikin-scheduler-sa
```

### 1 — Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project=$PROJECT_ID
```

### 2 — Create the Scheduler service account

```bash
gcloud iam service-accounts create $SCHEDULER_SA \
  --display-name="Daikin Scheduler Invoker" \
  --project=$PROJECT_ID
```

### 3 — Store static app credentials in Secret Manager

```bash
# Store each secret interactively (paste value, then Ctrl-D)
printf '%s' 'YOUR_CLIENT_ID'      | gcloud secrets create DAIKIN_CLIENT_ID      --data-file=- --project=$PROJECT_ID
printf '%s' 'YOUR_CLIENT_SECRET'  | gcloud secrets create DAIKIN_CLIENT_SECRET  --data-file=- --project=$PROJECT_ID
```

Grant the Cloud Run runtime service account access to read them
(replace `PROJECT_NUMBER` with your actual project number):

```bash
# Must match the service account used by Cloud Run (see deploy workflows): daikin-runtime-sa
export RUN_SA="daikin-runtime-sa@${PROJECT_ID}.iam.gserviceaccount.com"

for SECRET in DAIKIN_CLIENT_ID DAIKIN_CLIENT_SECRET; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${RUN_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=$PROJECT_ID
done
```

Grant the Cloud Run runtime service account Firestore access:

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/datastore.user"
```

If Firestore has not been initialized in the project yet, create a Firestore
database once in the Google Cloud console before bootstrapping the first token.

### 4 — Deploy to Cloud Run

```bash
gcloud run deploy $SERVICE_NAME \
  --source=. \
  --region=$REGION \
  --platform=managed \
  --no-allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,\
HEAT_TARGET_TEMP_C=16,\
HUMIDITY_HIGH_THRESHOLD=70,\
HUMIDITY_LOW_THRESHOLD=60,\
LOG_LEVEL=info,\
DAIKIN_TOKEN_STORE=firestore,\
DAIKIN_FIRESTORE_COLLECTION=oauth_tokens,\
DAIKIN_FIRESTORE_DOCUMENT=daikin_onecta" \
  --set-secrets="DAIKIN_CLIENT_ID=DAIKIN_CLIENT_ID:latest,\
DAIKIN_CLIENT_SECRET=DAIKIN_CLIENT_SECRET:latest" \
  --project=$PROJECT_ID
```

After deploy, capture the service URL and set `EXPECTED_AUDIENCE`:

```bash
export SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --region=$REGION --format='value(status.url)' --project=$PROJECT_ID)

gcloud run services update $SERVICE_NAME \
  --region=$REGION \
  --update-env-vars="EXPECTED_AUDIENCE=${SERVICE_URL}" \
  --project=$PROJECT_ID
```

### 5 — Bootstrap the Firestore token store once

Run the OAuth exchange one time with the same Firestore settings the service will use:

```bash
export DAIKIN_TOKEN_STORE=firestore
export DAIKIN_FIRESTORE_COLLECTION=oauth_tokens
export DAIKIN_FIRESTORE_DOCUMENT=daikin_onecta

npm run daikin:oauth-url
npm run daikin:oauth-exchange -- '<code>'
```

This stores the first refresh token in Firestore. After that, Cloud Run keeps it up to date automatically.

### 6 — Grant Scheduler the Cloud Run Invoker role

```bash
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --project=$PROJECT_ID
```

### 7 — Create Cloud Scheduler jobs

Prefer **`bash setup/create-scheduler-jobs.sh`** (same OIDC wiring as below, deletes legacy timer jobs). Manual equivalent:

```bash
# Poll humidity every 3 hours
gcloud scheduler jobs create http daikin-check-humidity \
  --location=$REGION \
  --schedule="0 */3 * * *" \
  --time-zone="Europe/Budapest" \
  --uri="${SERVICE_URL}/tasks/check-humidity" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience="${SERVICE_URL}" \
  --project=$PROJECT_ID

# Safety stop at midnight (ensures units always revert by end of day)
gcloud scheduler jobs create http daikin-dry-stop-safety \
  --location=$REGION \
  --schedule="0 0 * * *" \
  --time-zone="Europe/Budapest" \
  --uri="${SERVICE_URL}/tasks/dry-stop" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience="${SERVICE_URL}" \
  --project=$PROJECT_ID
```

### 7 — Verify deployment

```bash
# Manual trigger (uses your own identity, not the scheduler SA)
gcloud scheduler jobs run daikin-check-humidity --location=$REGION --project=$PROJECT_ID

# Tail logs
gcloud run services logs tail $SERVICE_NAME --region=$REGION --project=$PROJECT_ID
```

---

## Quota-safe scheduling guidance

The Daikin Onecta private developer app allows **≈200 API calls/day**.

Each call type costs:
- Token refresh: 1 call (cached for ~1 h, only refreshed when needed)
- `getDevices` list: 1 call per task that resolves device IDs (`resolveGatewayDeviceIds`)
- `getGatewayDeviceRaw` per device: used **sequentially** for preflight and humidity checks (one HTTP at a time when `DAIKIN_WRITE_CONCURRENCY=1`, plus optional `DAIKIN_HTTP_PACE_MS` gap)
- `dry-stop` restore: **one PATCH per settable characteristic** replayed from the snapshot (can be many calls), then a verify GET and optional heat fallback PATCHes
- `setOperationMode` / `setTemperature` per device as needed

**Conservative rules:**
- Poll **`check-humidity`** no more than every 2–3 hours (8 polls/day).
  - With N devices: list (1) + N sequential raw reads per poll, plus pace delay between each; dry actions add PATCH volume. Re-tune schedule if tight on quota or you see `429` in logs.
- Manual **`dry-start` / `dry-stop`**: preflight adds N GETs before dry-start; PATCH counts depend on snapshot size. If `dry-stop` fails with `429`, heads can drift out of sync — deploy pacing and widen scheduler spacing; align all heads manually if needed.
- Always set `DRY_DURATION_MINUTES` generously so one long cycle beats several short ones.
- The access token is cached in memory; it costs only 1 refresh call per container cold start or token expiry (~1 h).

---

## Endpoint mapping notes

All Daikin Onecta API details that require live-API verification are isolated
in clearly-marked `// ADAPTER NOTE` comments in `src/daikin.ts`. Search for
`ADAPTER NOTE` to find them. The points below summarise what to verify:

1. **Token endpoint**
   `POST https://idp.onecta.daikineurope.com/v1/oidc/token`
   Form body fields: `grant_type`, `client_id`, `client_secret`, `refresh_token`.
   Confirm field names and whether the endpoint requires `scope`.

2. **Device list**
   `GET /v1/gateway-devices`
   Confirm whether the response is a plain array or wrapped (`{ data: [...] }`).
   Confirm whether pagination is used (cursor, offset, or Link header).

3. **Management point type for AC units**
   Parsed state prefers `climateControl`, then `climateControlInfo`, then `climateControlMainZone` for `operationMode`, setpoint, and embedded `sensoryData` humidity (`src/daikin.ts`).
   Inspect the raw response from `/v1/gateway-devices` to confirm.

4. **operationMode PATCH path**
   `/v1/gateway-devices/{id}/management-points/climateControl/characteristics/operationMode`
   Body: `{ "value": "dry" }` — confirm exact string casing (`"dry"` vs `"Dry"`).

5. **temperatureControl PATCH payload**
   The code sends a nested `operationModes.heating.setpoints.roomTemperature.value` body.
   Some device models accept a flat `{ "value": <number> }`. Confirm against live docs.

6. **Humidity sensor path**
   Daikin Onecta exposes RH in more than one place; `src/daikin.ts` aligns with the same shapes Home Assistant’s [jwillemsen/daikin_onecta](https://github.com/jwillemsen/daikin_onecta) reads (`sensor.py` — `sensoryData` on climate MPs). In order:
   - Standalone `sensoryData` management point → `sensoryData` characteristic → `value` map → `indoorHumidity` / `roomHumidity` → `.value`
   - Same map on that MP with a direct `indoorHumidity` characteristic
   - **`climateControl` / `climateControlInfo` / `climateControlMainZone`** → characteristic **`sensoryData`** → **`value`** object → **`indoorHumidity`** or **`roomHumidity`** → numeric `.value`
   If your model still returns `null`, capture one `GET /v1/gateway-devices/{id}` JSON and extend `daikin.ts` (ADAPTER NOTEs).

7. **Device name field**
   The code reads the name from the `gateway` management point `name` characteristic.
   Adjust `extractDeviceName()` in `src/daikin.ts` if your devices expose it elsewhere.

---

## Obtaining a Daikin refresh token

The Onecta API uses an Authorization Code + OIDC flow for initial setup. The
user completes the browser login once, then the service stores the live refresh
token in a writable token store so future access-token refreshes are automatic.

1. Register a developer app at <https://developer.cloud.daikineurope.com/>.
2. Put `DAIKIN_CLIENT_ID`, `DAIKIN_CLIENT_SECRET`, and `DAIKIN_REDIRECT_URI` in `.env`
   (`DAIKIN_REDIRECT_URI` must match the redirect URI registered in the portal exactly).
3. Choose your token store:
   - Local development: `DAIKIN_TOKEN_STORE=local-file` and optionally `DAIKIN_TOKEN_FILE_PATH`
   - Cloud Run production: `DAIKIN_TOKEN_STORE=firestore`
4. Print the authorize URL, open it in a browser, then exchange the returned `code`:
   ```bash
   npm run daikin:oauth-url
   npm run daikin:oauth-exchange -- '<paste-code-from-browser>'
   ```
   (Script: `setup/oauth-onboarding/onecta-oauth-setup.js` — loads `.env` from the repo root.)
5. The exchange script stores the returned `refresh_token` into the configured token store.
   The service then refreshes access tokens automatically and persists any rotated
   refresh token back into that same store.

**Manual alternative** (same result as the script):

1. Open an authorize URL built like:
   ```
   https://idp.onecta.daikineurope.com/v1/oidc/authorize
     ?response_type=code
     &client_id=YOUR_CLIENT_ID
     &redirect_uri=YOUR_REDIRECT_URI
     &scope=openid%20onecta:basic.integration
   ```
2. After login and consent, capture the `code` from the redirect URL.
3. Exchange it for tokens:
   ```bash
   curl -X POST https://idp.onecta.daikineurope.com/v1/oidc/token \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d 'grant_type=authorization_code' \
     -d 'client_id=YOUR_CLIENT_ID' \
     -d 'client_secret=YOUR_CLIENT_SECRET' \
     -d 'code=YOUR_AUTH_CODE' \
     -d 'redirect_uri=YOUR_REDIRECT_URI'
   ```

4. Persist the returned `refresh_token` into the configured token store
   (local file in development, Firestore in production). Do not treat the repo
   `.env` file as the long-term source of truth for a rotating refresh token.

> **Note**: The Onecta docs describe one-hour access tokens, opaque refresh
> tokens, a maximum authorization-session lifetime of one year, and possible
> refresh-token rotation. The latest refresh token must therefore be stored in a
> writable durable store, not only in `.env`.
