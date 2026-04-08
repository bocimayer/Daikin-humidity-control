# Daikin Humidity Control

A production-ready TypeScript/Node.js 20 service that controls Daikin AC units
via the [Daikin Onecta cloud API](https://developer.onecta.daikineurope.com/)
with **no local hardware**. Deployed on Google Cloud Run, triggered by Cloud
Scheduler, secrets stored in Secret Manager.

---

## Architecture

```
Cloud Scheduler
  │  (OIDC-authenticated HTTP POST)
  ▼
Cloud Run  (private — no public access)
  └─ Express app
       ├─ POST /tasks/dry-start       ← switch all units to DRY
       ├─ POST /tasks/dry-stop        ← switch all units back to HEAT + setpoint
       ├─ POST /tasks/check-humidity  ← read humidity, decide via hysteresis FSM
       └─ GET  /healthz               ← liveness probe

  Internal modules
  ├─ DaikinClient   — Onecta OAuth2 + device ops (token refresh, retry, backoff)
  ├─ HumidityFSM    — hysteresis state machine (high/low threshold logic)
  ├─ IdempotencyGuard — in-memory dedup (10-min window per task)
  └─ requireSchedulerAuth — OIDC JWT middleware (google-auth-library)

Secrets:  Secret Manager → env vars injected at Cloud Run deploy time
```

### Quota budget (Daikin private dev app — 200 calls/day)

| Scenario | Calls/day |
|---|---|
| Option A, 4 devices, 1 cycle | ~10 |
| Option B, 1 leader, 2 devices, 8 polls | ~18 |
| Option B, 3 leaders, 4 devices, 8 polls | ~32 |

Poll no more than every 3 hours with humidity strategy to stay safe.

---

## Operating modes

### Option A — Timer-only

Cloud Scheduler calls `/tasks/dry-start` at a fixed time and
`/tasks/dry-stop` N minutes later. No humidity reading occurs.
Set `MODE_STRATEGY=timer`.

```
[09:00] Scheduler → POST /tasks/dry-start  → all units → DRY
[11:00] Scheduler → POST /tasks/dry-stop   → all units → HEAT @ 16 °C
```

### Option B — Humidity-aware

Cloud Scheduler polls `/tasks/check-humidity` every few hours.
The hysteresis FSM decides whether to start or stop a dry cycle.
Set `MODE_STRATEGY=humidity`.

```
[every 3 h] Scheduler → POST /tasks/check-humidity
               if humidity ≥ 70 % → trigger dry-start
               if humidity ≤ 60 % → trigger dry-stop
               else               → no-op
[00:00] Scheduler → POST /tasks/dry-stop  (safety stop — runs regardless)
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `8080` | HTTP listen port |
| `NODE_ENV` | no | `development` | Set to `production` in Cloud Run |
| `DAIKIN_CLIENT_ID` | **yes** | — | Onecta OAuth client ID |
| `DAIKIN_CLIENT_SECRET` | **yes** | — | Onecta OAuth client secret |
| `DAIKIN_REFRESH_TOKEN` | **yes** | — | Long-lived OAuth refresh token |
| `DAIKIN_BASE_URL` | no | `https://api.onecta.daikineurope.com` | API base URL |
| `DAIKIN_AUTH_URL` | no | `https://idp.onecta.daikineurope.com/v1/oidc/token` | Token endpoint |
| `DAIKIN_DEVICE_IDS_JSON` | **yes** | — | JSON array of device UUIDs to control |
| `DAIKIN_HUMIDITY_LEADER_IDS_JSON` | **yes** | — | JSON array of device UUIDs to read humidity from |
| `DRY_DURATION_MINUTES` | no | `120` | Informational — used to space Scheduler jobs |
| `HEAT_TARGET_TEMP_C` | no | `16` | Frost-protection setpoint after dry cycle |
| `HUMIDITY_HIGH_THRESHOLD` | no | `70` | % RH at which dry cycle starts |
| `HUMIDITY_LOW_THRESHOLD` | no | `60` | % RH at which dry cycle stops |
| `MODE_STRATEGY` | no | `timer` | `timer` or `humidity` |
| `LOG_LEVEL` | no | `info` | `trace` `debug` `info` `warn` `error` `fatal` |
| `EXPECTED_AUDIENCE` | **yes** | — | Cloud Run service URL (OIDC audience check) |

---

## Local development

```bash
# 1. Copy env file and fill in values
cp .env.example .env
# Edit .env — set DAIKIN_* credentials and device IDs

# 2. Install dependencies
npm install

# 3. Run with hot-reload (auth check is skipped in development)
npm run dev

# 4. Test endpoints
curl http://localhost:8080/healthz
curl -X POST http://localhost:8080/tasks/dry-stop
curl -X POST http://localhost:8080/tasks/check-humidity
```

---

## Tests

```bash
npm test              # run all tests
npm run test:coverage # with coverage report
```

Three test suites:
- `tests/hysteresis.test.ts` — HumidityStateMachine transitions
- `tests/idempotency.test.ts` — IdempotencyGuard allow/block/reset
- `tests/config.test.ts` — Zod schema validation and defaults

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

curl http://localhost:8080/healthz
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
5. Prompts for Daikin secret values and stores them in Secret Manager
6. Sets up Workload Identity Federation (GitHub → GCP, no JSON key)
7. Prints the exact GitHub secrets you need to add

### GitHub secrets to configure

After running bootstrap.sh, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Example value |
|---|---|
| `GCP_PROJECT_ID` | `my-gcp-project-123` |
| `GCP_REGION` | `europe-central2` |
| `GCP_DEPLOY_SA` | `daikin-deploy-sa@my-gcp-project-123.iam.gserviceaccount.com` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/123456/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `DAIKIN_DEVICE_IDS_JSON` | `["uuid-1","uuid-2"]` |
| `DAIKIN_HUMIDITY_LEADER_IDS_JSON` | `["uuid-1"]` |
| `HEAT_TARGET_TEMP_C` *(optional)* | `16` |
| `HUMIDITY_HIGH_THRESHOLD` *(optional)* | `70` |
| `HUMIDITY_LOW_THRESHOLD` *(optional)* | `60` |
| `MODE_STRATEGY` *(optional)* | `timer` |
| `DRY_DURATION_MINUTES` *(optional)* | `120` |
| `LOG_LEVEL` *(optional)* | `info` |

> The Daikin credentials (`DAIKIN_CLIENT_ID`, `DAIKIN_CLIENT_SECRET`, `DAIKIN_REFRESH_TOKEN`) live
> only in Secret Manager. Cloud Run reads them at runtime — they are never in GitHub.

### Deploy

Once secrets are set, push to `main`:

```bash
git push origin main
```

The pipeline runs tests first; if they pass it builds the image, pushes to Artifact Registry, deploys to Cloud Run, and runs a `/healthz` smoke test. The job summary shows the deployed URL.

For a manual trigger: **Actions → Deploy to Cloud Run → Run workflow**.

### Create Cloud Scheduler jobs (run once after first deploy)

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=europe-central2
export MODE_STRATEGY=timer           # or: humidity
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
  secretmanager.googleapis.com \
  iam.googleapis.com \
  cloudbuild.googleapis.com \
  --project=$PROJECT_ID
```

### 2 — Create the Scheduler service account

```bash
gcloud iam service-accounts create $SCHEDULER_SA \
  --display-name="Daikin Scheduler Invoker" \
  --project=$PROJECT_ID
```

### 3 — Store secrets in Secret Manager

```bash
# Store each secret interactively (paste value, then Ctrl-D)
printf '%s' 'YOUR_CLIENT_ID'      | gcloud secrets create DAIKIN_CLIENT_ID      --data-file=- --project=$PROJECT_ID
printf '%s' 'YOUR_CLIENT_SECRET'  | gcloud secrets create DAIKIN_CLIENT_SECRET  --data-file=- --project=$PROJECT_ID
printf '%s' 'YOUR_REFRESH_TOKEN'  | gcloud secrets create DAIKIN_REFRESH_TOKEN  --data-file=- --project=$PROJECT_ID
```

Grant the Cloud Run runtime service account access to read them
(replace `PROJECT_NUMBER` with your actual project number):

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in DAIKIN_CLIENT_ID DAIKIN_CLIENT_SECRET DAIKIN_REFRESH_TOKEN; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${RUN_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=$PROJECT_ID
done
```

### 4 — Deploy to Cloud Run

```bash
gcloud run deploy $SERVICE_NAME \
  --source=. \
  --region=$REGION \
  --platform=managed \
  --no-allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,\
DAIKIN_DEVICE_IDS_JSON=[\"device-uuid-1\",\"device-uuid-2\"],\
DAIKIN_HUMIDITY_LEADER_IDS_JSON=[\"device-uuid-1\"],\
HEAT_TARGET_TEMP_C=16,\
HUMIDITY_HIGH_THRESHOLD=70,\
HUMIDITY_LOW_THRESHOLD=60,\
MODE_STRATEGY=timer,\
LOG_LEVEL=info" \
  --set-secrets="DAIKIN_CLIENT_ID=DAIKIN_CLIENT_ID:latest,\
DAIKIN_CLIENT_SECRET=DAIKIN_CLIENT_SECRET:latest,\
DAIKIN_REFRESH_TOKEN=DAIKIN_REFRESH_TOKEN:latest" \
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

### 5 — Grant Scheduler the Cloud Run Invoker role

```bash
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --project=$PROJECT_ID
```

### 6 — Create Cloud Scheduler jobs

#### Option A — Timer-only

```bash
# Dry start at 09:00 every day
gcloud scheduler jobs create http daikin-dry-start \
  --location=$REGION \
  --schedule="0 9 * * *" \
  --time-zone="Europe/Budapest" \
  --uri="${SERVICE_URL}/tasks/dry-start" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience="${SERVICE_URL}" \
  --project=$PROJECT_ID

# Dry stop at 11:00 every day (2 hours later)
gcloud scheduler jobs create http daikin-dry-stop \
  --location=$REGION \
  --schedule="0 11 * * *" \
  --time-zone="Europe/Budapest" \
  --uri="${SERVICE_URL}/tasks/dry-stop" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience="${SERVICE_URL}" \
  --project=$PROJECT_ID
```

#### Option B — Humidity-aware

Switch the deployed service to `MODE_STRATEGY=humidity` first:

```bash
gcloud run services update $SERVICE_NAME \
  --region=$REGION \
  --update-env-vars="MODE_STRATEGY=humidity" \
  --project=$PROJECT_ID

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
gcloud scheduler jobs run daikin-dry-stop --location=$REGION --project=$PROJECT_ID

# Tail logs
gcloud run services logs tail $SERVICE_NAME --region=$REGION --project=$PROJECT_ID
```

---

## Quota-safe scheduling guidance

The Daikin Onecta private developer app allows **≈200 API calls/day**.

Each call type costs:
- Token refresh: 1 call (cached for ~1 h, only refreshed when needed)
- `getDeviceState` per leader: 1 call
- `setOperationMode` per device: 1 call
- `setTemperature` per device: 1 call

**Conservative rules:**
- In **humidity mode**: poll no more than every 2–3 hours (8 polls/day).
  - With 2 leader devices and 4 controlled devices: 8×2 + 2×6 = 28 calls/day
- In **timer mode**: 2 PATCH calls × number of devices per cycle.
  - With 4 devices: 2×4×2 = 16 calls/day
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
   The code uses `climateControl`. Some device models may use `climateControlInfo`.
   Inspect the raw response from `/v1/gateway-devices` to confirm.

4. **operationMode PATCH path**
   `/v1/gateway-devices/{id}/management-points/climateControl/characteristics/operationMode`
   Body: `{ "value": "dry" }` — confirm exact string casing (`"dry"` vs `"Dry"`).

5. **temperatureControl PATCH payload**
   The code sends a nested `operationModes.heating.setpoints.roomTemperature.value` body.
   Some device models accept a flat `{ "value": <number> }`. Confirm against live docs.

6. **Humidity sensor path**
   The code tries two paths in order:
   - `sensoryData` MP → `sensoryData` characteristic → `indoorHumidity.value`
   - `sensoryData` MP → `indoorHumidity` characteristic → `.value`
   Add a third path if neither matches your device.

7. **Device name field**
   The code reads the name from the `gateway` management point `name` characteristic.
   Adjust `extractDeviceName()` in `src/daikin.ts` if your devices expose it elsewhere.

---

## Obtaining a Daikin refresh token

The Onecta API uses an Authorization Code OAuth2 flow for initial setup. Since
this service runs unattended, the one-time flow must be completed locally:

1. Register a developer app at <https://developer.onecta.daikineurope.com/>.
2. Put `DAIKIN_CLIENT_ID`, `DAIKIN_CLIENT_SECRET`, and `DAIKIN_REDIRECT_URI` in `.env`
   (`DAIKIN_REDIRECT_URI` must match the redirect URI registered in the portal exactly).
3. Print the authorize URL, open it in a browser, then exchange the returned `code`:
   ```bash
   npm run daikin:oauth-url
   npm run daikin:oauth-exchange -- '<paste-code-from-browser>'
   ```
   (Script: `setup/oauth-onboarding/onecta-oauth-setup.js` — loads `.env` from the repo root.)
4. Copy the printed `refresh_token` into `DAIKIN_REFRESH_TOKEN` in `.env` and in Secret Manager for Cloud Run.

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

4. Store the returned `refresh_token` in `.env` / Secret Manager as `DAIKIN_REFRESH_TOKEN`
   (same as step 4 above). The service uses it to obtain short-lived access tokens automatically.

> **Note**: Refresh tokens may have a long expiry or be perpetual for private
> developer apps. Check the Daikin developer portal terms for your app type.
