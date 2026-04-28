# Enable IAP + HTTPS load balancer for browser `/ops/scheduler` (one-time, GCP)

This is **infrastructure** for the in-app “auto dry” switch (`GET/POST /ops/scheduler`) behind **Identity-Aware Proxy (IAP)** with **Google** sign-in and an allowlist. The main Cloud Run service can stay **without** public (`allUsers`) `run.invoker`; users reach the app via the **load balancer** URL after signing in with an allowed account.

> Canonical product docs: [docs/PRODUCTION_SETUP.md](../docs/PRODUCTION_SETUP.md) (browser ops + IAP), [README.md](../README.md).

## 1. What you are building

- **Client** (phone/laptop) → **External HTTPS load balancer** → **IAP** (Google OAuth) → **Serverless NEG** → **Cloud Run** `daikin-humidity-control`
- **IAP** enforces: sign-in and **“IAP-secured Web App User”** (or group) on the **backend** resource.
- The app still verifies the **signed IAP assertion** in `X-Goog-IAP-JWT-Assertion` using env **`IAP_EXPECTED_AUDIENCE`** (defense in depth; see `src/iap-ops-auth.ts`).

## 2. Follow Google’s procedure

1. **Backend service + NEG to Cloud Run** — create an **External HTTPS** load balancer and a **serverless network endpoint group (NEG)** pointing to the **regional** Cloud Run service in the same project/region.  
2. **Enable IAP** on the backend service, **OAuth brand / consent** if the project has not been used for OAuth before.  
3. **Add principals** to IAP access: individual Google accounts (e.g. `user:you@gmail.com`) or a **Google Group**.  
4. **Copy the OAuth 2.0 client ID / audience** used for IAP (often the **backend** resource path such as `projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID` — the Cloud Console *Identity-Aware Proxy* page shows the value to use for JWT `aud` verification). Set it in Cloud Run as **`IAP_EXPECTED_AUDIENCE`** (Secret Manager is fine).

Reference: [Setting up IAP for Cloud Run](https://cloud.google.com/iap/docs/enabling-cloud-run) and [Validate IAP JWTs](https://cloud.google.com/iap/docs/identity-howto) (use the same audience the console documents for your backend).

## 3. IAM: load balancer to Cloud Run

The path from the LB to Cloud Run must be allowed. Typically the **load balancer** uses a service identity that needs **`roles/run.invoker`** (or the documented variant for serverless NEG) on the Cloud Run service. Apply exactly what the Google guide for *your* LB type lists.

## 4. Operator URL

Record the **HTTPS front-end URL** (or custom domain) of the load balancer. Operators use:

- `https://<LB-HOST>/ops/scheduler` — **not** the raw `*.run.app` URL (direct Run remains private; `/ops` without an IAP token returns **401**).

## 5. After IAP works

- Set Cloud Run env **`IAP_EXPECTED_AUDIENCE`** to the value from the console (and optional **`ALLOWED_OPS_EMAILS`** for an app-level list).  
- Grant the **Cloud Run runtime** service account Scheduler **pause/resume** on `daikin-check-humidity` (see [grant-runtime-scheduler-ops-iam.sh](grant-runtime-scheduler-ops-iam.sh) or `docs/PRODUCTION_SETUP.md`).

---

**Break-glass:** if the UI is unreachable, operators can still use `bash setup/disable-auto-dry.sh` / `enable-auto-dry.sh` with `gcloud` (no redeploy).
