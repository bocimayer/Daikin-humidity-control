# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`POST /tasks/notify-test`**: OIDC-only probe that sends one Gmail message when notify env is configured (`README.md`).
- **`setup/apply-humidity-strategy-to-cloud.sh`**: sets Cloud Run `MODE_STRATEGY=humidity` and runs scheduler setup (`README.md`).

- **`AUTOMATION_ENABLED`** env: master switch to skip `dry-start`, `dry-stop`, and `check-humidity` without removing OIDC (`README.md`).
- **`DAIKIN_WRITE_CONCURRENCY`** and **`DAIKIN_HTTP_PACE_MS`**: serialize and pace Onecta gateway HTTP to reduce **`429`** during heavy `dry-stop` restores (`README.md`).
- **`src/dry-cycle-guards.ts`**: multi-head policy (homogeneous modes, **`dry-stop` only when every head reports `dry`**, humidity cluster gate; dry entry rules see **Changed** below).
- **`GET /tasks/device-status`**: documented in architecture overview (`README.md`).

### Changed

- **Dry-start policy:** refuse **only** homogeneous **`cooling`** (`cooling-already-dehumidifies`); allow **`heating` / `fanOnly` / `auto` / …** when every head matches (`src/dry-cycle-guards.ts`, docs).
- **`npm run daikin:humidity-snapshot`** — `daikin-live-smoke.ts --read-only`: Onecta snapshot of mode + humidity **without** setpoint PATCH; **`dotenv.config`** honors **`DOTENV_CONFIG_PATH`** before importing app config (`package.json`, `README.md`, `scripts/daikin-live-smoke.ts`).
- **`HumidityStateMachine.evaluate`** is **pure**; `setActive(true|false)` runs only after **full** dry-start / dry-stop success so the FSM cannot desync from the plant (`README.md`, `tests/hysteresis.test.ts`).
- **Dry-start / dry-stop / check-humidity**: preflight runs **before** idempotency for timer dry-start/stop where applicable; sequential gateway reads for cluster checks (`README.md`).
- **Notifications:** optional **`subjectOverride`** on task notify payloads; **mail on every** `check-humidity`, **dry-start**, and **dry-stop** outcome (including skips); **`create-scheduler-jobs.sh`** deletes timer **`daikin-dry-start`** / **`daikin-dry-stop`** when switching to **humidity** mode (`src/task-notify.ts`, `src/routes.ts`, `setup/`).
- **GitHub Actions deploy:** default **`MODE_STRATEGY`** is **`humidity`** when the **`MODE_STRATEGY`** repository/environment secret is unset (set the secret to **`timer`** explicitly for fixed-clock dry cycles only) (`.github/workflows/deploy.yml`).

### Fixed

- Mitigation for **split indoor modes after `dry-start` succeeded but `dry-stop` hit `429`**: pacing, stricter cluster policy, and FSM sync (`README.md` — operations / quota sections).
- **Indoor RH parsing:** read humidity from the **`sensoryData` characteristic on `climateControl` / `climateControlMainZone`** (`value` map keys `indoorHumidity`, `roomHumidity`), matching the field layout used by Home Assistant **daikin_onecta** — not only a standalone `sensoryData` management point (`src/daikin.ts`, `README.md`, `tests/daikin-humidity-paths.test.ts`).
