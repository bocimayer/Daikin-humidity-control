# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`AUTOMATION_ENABLED`** env: master switch to skip `dry-start`, `dry-stop`, and `check-humidity` without removing OIDC (`README.md`).
- **`DAIKIN_WRITE_CONCURRENCY`** and **`DAIKIN_HTTP_PACE_MS`**: serialize and pace Onecta gateway HTTP to reduce **`429`** during heavy `dry-stop` restores (`README.md`).
- **`src/dry-cycle-guards.ts`**: multi-head policy (homogeneous modes, **`dry-stop` only when every head reports `dry`**, humidity cluster gate; dry entry rules see **Changed** below).
- **`GET /tasks/device-status`**: documented in architecture overview (`README.md`).

### Changed

- **Dry-start policy:** refuse **only** homogeneous **`cooling`** (`cooling-already-dehumidifies`); allow **`heating` / `fanOnly` / `auto` / …** when every head matches (`src/dry-cycle-guards.ts`, docs).
- **`npm run daikin:humidity-snapshot`** — `daikin-live-smoke.ts --read-only`: Onecta snapshot of mode + humidity **without** setpoint PATCH; **`dotenv.config`** honors **`DOTENV_CONFIG_PATH`** before importing app config (`package.json`, `README.md`, `scripts/daikin-live-smoke.ts`).
- **`HumidityStateMachine.evaluate`** is **pure**; `setActive(true|false)` runs only after **full** dry-start / dry-stop success so the FSM cannot desync from the plant (`README.md`, `tests/hysteresis.test.ts`).
- **Dry-start / dry-stop / check-humidity**: preflight runs **before** idempotency for timer dry-start/stop where applicable; sequential gateway reads for cluster checks (`README.md`).

### Fixed

- Mitigation for **split indoor modes after `dry-start` succeeded but `dry-stop` hit `429`**: pacing, stricter cluster policy, and FSM sync (`README.md` — operations / quota sections).
