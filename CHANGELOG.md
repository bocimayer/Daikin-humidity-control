# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Dependency **`firebase-admin`** for Firebase ID token verification (`package.json`).

- **`GET /ops/scheduler`** HTML shell + **`GET /ops/scheduler/state`** / **`POST /ops/scheduler`** JSON APIs: **Firebase Auth** (Google) + **`firebase-admin`** ID token verification, optional **`ALLOWED_OPS_EMAILS`**, Cloud Scheduler via **`@google-cloud/scheduler`** (`src/firebase-ops-auth.ts`, `src/ops-routes.ts`, `src/ops-scheduler-html.ts`, `src/scheduler-ops.ts`, `setup/grant-runtime-scheduler-ops-iam.sh`, `README.md`).

- **`setup/disable-auto-dry.sh`** and **`setup/enable-auto-dry.sh`**: pause / resume Cloud Scheduler job **`daikin-check-humidity`** (humidity FSM) without Cloud Run deploy; npm **`daikin:auto-dry:disable`** / **`daikin:auto-dry:enable`** (`README.md`, `docs/PRODUCTION_SETUP.md`, `DEPLOYMENT_READINESS.md`).

- **`POST /tasks/notify-test`**: OIDC-only probe that sends one Gmail message when notify env is configured (`README.md`).

- **`AUTOMATION_ENABLED`** env: master switch to skip `dry-start`, `dry-stop`, and `check-humidity` without removing OIDC (`README.md`).
- **`DAIKIN_WRITE_CONCURRENCY`** and **`DAIKIN_HTTP_PACE_MS`**: serialize and pace Onecta gateway HTTP to reduce **`429`** during heavy `dry-stop` restores (`README.md`).
- **`src/dry-cycle-guards.ts`**: multi-head policy (homogeneous modes, **`dry-stop` only when every head reports `dry`**, humidity cluster gate; dry entry rules see **Changed** below).
- **`GET /tasks/device-status`**: documented in architecture overview (`README.md`).

### Changed

- **Browser /ops:** Replaced IAP JWT verification with **Firebase Authentication** (Google); Cloud Run deploy uses **`--allow-unauthenticated`** at the edge — **`/tasks/*`** remains OIDC-only in the app (`README.md`, `.github/workflows/deploy.yml`; removed `src/iap-ops-auth.ts`).
- **Dry-start policy:** refuse **only** homogeneous **`cooling`** (`cooling-already-dehumidifies`); allow **`heating` / `fanOnly` / `auto` / …** when every head matches (`src/dry-cycle-guards.ts`, docs).
- **`npm run daikin:humidity-snapshot`** — `daikin-live-smoke.ts --read-only`: Onecta snapshot of mode + humidity **without** setpoint PATCH; **`dotenv.config`** honors **`DOTENV_CONFIG_PATH`** before importing app config (`package.json`, `README.md`, `scripts/daikin-live-smoke.ts`).
- **`HumidityStateMachine.evaluate`** is **pure**; `setActive(true|false)` runs only after **full** dry-start / dry-stop success so the FSM cannot desync from the plant (`README.md`, `tests/hysteresis.test.ts`).
- **Dry-start / dry-stop / check-humidity**: preflight runs **before** idempotency for dry-start/stop where applicable; sequential gateway reads for cluster checks (`README.md`).
- **Notifications:** optional **`subjectOverride`** on task notify payloads; **mail on every** `check-humidity`, **dry-start**, and **dry-stop** outcome (including skips); **`create-scheduler-jobs.sh`** removes legacy timer **`daikin-dry-start`** / **`daikin-dry-stop`** jobs if present (`src/task-notify.ts`, `src/routes.ts`, `setup/`).
- **Configuration:** removed **`MODE_STRATEGY`** — automation is always humidity-driven via **`check-humidity`** (`src/config.ts`, `README.md`, `.github/workflows/deploy.yml`).
- **Dry-start / dry-stop:** every gateway head must succeed (per-device transient retries, no swallowed restore PATCH errors); HTTP **500** if any head still fails after retries — no partial **`devicesControlled`** success (`src/routes.ts`, `src/onecta-transient-retry.ts`, `tests/onecta-transient-retry.test.ts`).
- **Onecta retry pacing:** outer device retries enforce **`MIN_MS_BETWEEN_DEVICE_ATTEMPTS` (2.5s)** minimum wait between attempts (floors small **`Retry-After`**); sequential devices + existing HTTP gate/pacing (`src/onecta-transient-retry.ts`).
- **Notifications:** `await notifyTaskOutcome` on dry success/failure and check-humidity outcomes; **warn** when mail/webhook is not configured (`src/routes.ts`, `src/task-notify.ts`).

### Fixed

- Mitigation for **split indoor modes after `dry-start` succeeded but `dry-stop` hit `429`**: pacing, stricter cluster policy, and FSM sync (`README.md` — operations / quota sections).
- **Indoor RH parsing:** read humidity from the **`sensoryData` characteristic on `climateControl` / `climateControlMainZone`** (`value` map keys `indoorHumidity`, `roomHumidity`), matching the field layout used by Home Assistant **daikin_onecta** — not only a standalone `sensoryData` management point (`src/daikin.ts`, `README.md`, `tests/daikin-humidity-paths.test.ts`).
