# Agent-guided human gates — one step, one verification

**Repo:** `tihany-daikin` / **Daikin Humidity Control** (Node.js service on Cloud Run).  
**Canonical family copy:** `c:\htdocs\gjea\drive\shared-docs\agent-guided-human-gates-workflow.md` — refresh from there when the workflow changes.

**Purpose:** When a task needs a **human** (browser, Google Cloud Console, GitHub Actions secrets UI, Daikin Onecta OAuth), the **agent** and **operator** follow this workflow so nothing is marked “done” from **vague intent** or **because a file exists**.

**Scope:** **One concrete next action**, then **verification** before the next step (**ask → human acts → agent verifies**). When an active program under **`docs/plans/`** defines numbered gate rules, align wording with that doc—but **this file is not owned by** any single plan.

**Cursor:** Use **`/guide`** (`.cursor/commands/guide.md`) and **`.cursor/rules/guide-me-human-gates.mdc`**.

---

## 1. Rules (non-negotiable)

| Rule | Meaning |
|------|---------|
| **One human task per turn** | The agent states **exactly one** concrete action (who, where, what to click or paste). **No** wall of steps in a single message. |
| **Wait for confirmation** | The agent **pauses** until the human reports that step finished (or pastes a **safe** artefact: client ID, project id — **never** refresh tokens or private keys in chat). |
| **Verify before the next task** | After each human step, the **agent** runs an agreed **check** (command, API call, file presence + format, or UI outcome). If the check fails, **do not** advance; fix or repeat the same step. |
| **“File exists” ≠ gate satisfied** | Creating a stub Markdown file, an empty secret name, or a placeholder path does **not** complete a gate. **Done** means the **verification** for that step passed. |
| **Who / when is explicit** | Every instruction names **who** acts (operator, engineer) and **when** (e.g. before first green pipeline, before production deploy). |

---

## 2. Agent loop (repeat until gate cleared)

1. **State the gate** in one sentence (what is blocked).
2. **Assign the single next action** — including **who** and **where** (product name + navigation path, e.g. GitHub → Settings → Secrets and variables → Actions).
3. **Human performs** the action (outside the repo or in a secrets UI).
4. **Agent verifies** using the **check** from §3 (or from the runbook step that links here).
5. If verify passes → either **exit** (gate cleared) or go to step 1 for the **next** gate. If verify fails → **stop**; diagnose; repeat steps 2–4 for the same gate.

---

## 3. Example gates (this service)

| Gate (human does) | Who | Verification (agent or scripted) |
|-------------------|-----|----------------------------------|
| GitHub Actions secret `GCP_PROJECT_ID` (etc.) set | Operator | Workflow doc lists required secrets; agent confirms names appear in runbook / user confirms UI — or workflow dry-run where applicable. |
| Onecta OAuth client / refresh token | Engineer | `npm run lint` / config loads; integration test or `daikin:live-smoke` per README when credentials available — **not** “user said it works.” |
| Cloud Run service deployed | Operator | `curl -sf` on **`/health`** (authenticated path per README) or GitHub Actions run **success** for deploy workflow. |
| Secret Manager / Firestore wiring in GCP | Operator | Documented env names match Cloud Run service config; agent reads `README.md` / `DEPLOYMENT_READINESS.md` vs actual requirement. |

For **Drive add-on / clasp / multi-SA fixture** examples (other family repos), see the **canonical** file under **`shared-docs`**.

---

## 4. Relation to automated tests

- **Unit tests** (`npm test` in `Daikin-humidity-control/`) do **not** use this document for execution.
- **Human-guided setup** (GCP console, GitHub secrets, first OAuth) **does** use this document until **agent/CI verification** passes.
- When a required scenario did **not** run, treat as **failure**, not skip — see family **`test-failure-not-success.md`** in **`shared-docs`** if you need the normative wording.

---

## 5. Related documents

| Document | Role |
|----------|------|
| **`README.md`**, **`DEPLOYMENT_READINESS.md`** | Architecture, env vars, deploy steps |
| **`.github/workflows/deploy.yml`** | Required secrets and deploy trigger |
| Family **`shared-docs/test-failure-not-success.md`** | Fail-not-skip language for orchestration |

---

## 6. Orchestrated Workflow API (“Branch B”)

This repo does **not** use the family HTTP orchestrator by default. If you add `workflow:post-event` / similar, adopt **hard stops** from the canonical **`shared-docs/agent-guided-human-gates-workflow.md`** §6.
