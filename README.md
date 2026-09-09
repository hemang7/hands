# hands

A computer-use automation system for back-office apps that have no API.

An LLM figures out a task on a live UI once. What it did is recorded as a **typed, versioned
capability** (inputs, outputs, business outcomes, risk class, steps with robust targeting). A
**deterministic engine** replays that capability in production with no model in the loop, handles
the runtime conditions legacy apps throw at you (record not found, session expiry, interstitials,
slow hosts, app errors), stays inside an allowlist, and **hands the live session to a human** when
it cannot safely continue.

Design write-up: [REPORT.md](REPORT.md). Evidence of every path: [evidence/](evidence/).

```
goal ──▶ discovery (LLM) ──▶ capability.json ──▶ replay (no LLM) ──▶ {success | outcome | failed | escalated}
                                    ▲                    │
                                    └── learn-overrides ◀┘ (drift + what the operator did on another tenant)
```

## What is in the box

| Path | What |
|---|---|
| `target-app/` | **LegacyCore Teller Console**: the stand-in bank system. Framesets, table layouts, `<font>` tags, no ids or test ids, generic input names (`txt1`, `sel1`), native `confirm()` on posting. Mounted twice as two "institutions" (`/t/alpha`, `/t/beta`) with different labels, frame names and an extra post-login notice. Chaos hooks inject session expiry, interstitials, slow loads and 500s. |
| `src/surface/` | The **Surface** seam: cross-frame observation (role / accessible name / table anchors / grid context), a pure locator library with a fallback ladder, and the one concrete surface (Playwright). |
| `src/artifact/` | The **capability schema** (zod), condition evaluator, file store, tenant-override learning. |
| `src/discovery/` | The **LLM agent loop** (observe, decide, act) with OpenAI tool calling, plus a scripted decider so the whole pipeline runs offline. The recorder turns a run into an artifact. |
| `src/replay/` | The **deterministic engine** and the result contract. |
| `src/policy/` | Allowlist + risk classification + redaction. |
| `src/handoff/` | The **control-transfer model** (session lease, intervention requests), a bare HTTP operator console, and scripted operators for headless evidence. |
| `src/catalog/` | Stretch: capabilities as an agent-facing tool catalog, and a demo of an LLM invoking one. |
| `apps/` | App profile for the vendor product: shared conditions vocabulary, secret refs, tenants. |
| `capabilities/` | Recorded artifacts (`<id>.v<version>.json`). |
| `evidence/` | Logs, screenshots, snapshots and artifacts from the runs described in the report. |
| `tests/` | Unit tests for the locator ladder, policy, schema, control model; an end-to-end suite against the real target app. |

## Setup

Requirements: Node 20+, and Chromium for Playwright.

```bash
npm install
npx playwright install chromium      # or point HANDS_CHROMIUM_PATH at a system Chromium
cp .env.example .env                 # edit: OPENAI_API_KEY for discovery; app credentials as shown
```

Configuration is all environment variables (see `.env.example`):

| Variable | Needed for | Notes |
|---|---|---|
| `OPENAI_API_KEY` | discovery, `agent` demo | Replay never needs it. Without it the CLI defaults to `--llm scripted`. |
| `HANDS_MODEL` | discovery | default `gpt-4.1` |
| `LEGACYCORE_USER`, `LEGACYCORE_PASSWORD` | any run that signs on | `teller1` / `teller1-pass` for the mock app. Referenced from artifacts by env var *name* only. |
| `HANDS_CHROMIUM_PATH` | optional | use a system Chromium instead of the Playwright download |

Load `.env` however you like (`set -a; source .env; set +a`, or `direnv`). The CLI also
auto-loads a `.env` file from the project root at start-up, so a bare `npm run hands` works once
the file exists.

## Quick start (Docker)

No local Node, Playwright, or Chromium installation needed:

```bash
docker compose up
```

This runs the full offline demo — scripted decider, all 17 replay scenarios, catalog — and prints
`evidence written to runs/evidence-offline/` when done. To run with a real OpenAI model instead:

```bash
OPENAI_API_KEY=sk-... docker compose run hands npm run evidence
```

## Demo path

Terminal 1, the target app:

```bash
npm run target          # http://localhost:4010  (alpha: Hoosier FCU, beta: Riverbend)
```

Terminal 2, the whole thread end to end:

```bash
# 1. discovery: the model drives the UI, the run is recorded as a capability
npm run hands -- discover --id lookup_member_balance --pii memberId \
  --goal "Look up member {memberId} and read their current share savings balance." \
  --input memberId=10001

# 2. replay: same artifact, different member, no model
npm run hands -- replay lookup_member_balance --input memberId=10003
#    -> REPLAY SUCCESS  outputs: {"savings_balance":15987.12}

# 3. a legitimate business outcome is an answer, not a failure
npm run hands -- replay lookup_member_balance --input memberId=99999
#    -> REPLAY OUTCOME  RECORD_NOT_FOUND "No record found for member 99999."

# 4. runtime conditions: inject them and watch the engine recover or fail explicitly
npm run hands -- replay lookup_member_balance --input memberId=10001 --inject timeout       # re-auth + restart
npm run hands -- replay lookup_member_balance --input memberId=10001 --inject interstitial  # dismiss + retry
npm run hands -- replay lookup_member_balance --input memberId=10001 --inject crash         # hard failure + bundle

# 5. another institution running the same product: drift + a human takes the live session
npm run hands -- replay lookup_member_balance --input memberId=10001 --tenant beta \
  --operator scripted:tenant-beta-operator
npm run hands -- learn-overrides lookup_member_balance --from-run <run id printed above>
npm run hands -- replay lookup_member_balance --input memberId=10002 --tenant beta   # v2: clean

# 6. an irreversible flow: draft artifact refuses to commit and escalates; approved + confirmed runs it
npm run hands -- replay open_sub_account --input memberId=10003 --input "accountType=Money Market" \
  --input "nickname=TAX RESERVE" --input deposit=40 --operator scripted:confirm-commit
npm run hands -- approve open_sub_account
npm run hands -- replay open_sub_account --input memberId=10003 --input "accountType=Club Savings" \
  --input "nickname=RAINY DAY" --input deposit=15 --confirm

# 7. an AI agent invoking capabilities as tools (stretch)
npm run hands -- catalog
npm run hands -- agent "What is the share savings balance of member 10003?"
```

Every run writes `runs/<run id>/` with `run.jsonl` (structured events), `shots/` (a screenshot per
step), `result.json`, and on failure `snapshots/` (DOM of every frame). Discovery runs also keep the
exact text the model saw per step under `observations/` and the system prompt.

### Taking control yourself

Run any replay or discovery with a visible browser and the operator console:

```bash
npm run hands -- replay lookup_member_balance --input memberId=10001 --tenant beta --headed --operator http
```

When the engine cannot locate a control (or hits an irreversible step it is not authorized for) it
parks, prints the intervention request, and `http://localhost:4020` lets you take control of the
live session, do the step in the automation's own browser window, and hand back with
*retry step*, *I did this step*, or *abort*. Your actions are recorded into the run's evidence.

### Running without live services

`npm run demo:offline` reproduces the entire evidence suite (`evidence/README.md` maps every run) with a scripted decider in place of the
model (same prompts, same tools, same recorder, same engine). It needs no API key. The real
model-driven runs shipped in `evidence/` were produced by `npm run evidence` with `OPENAI_API_KEY` set.

## Tests

```bash
npm test            # unit tests + end-to-end against the in-process target app (~1 min)
npm run typecheck
```

## CLI reference

```
hands discover  --id <capability> --goal "<text>" --input k=v [--input k=v ...] [--pii k]
                [--tenant alpha|beta] [--llm openai|scripted] [--model gpt-4.1] [--headed]
                [--allow-irreversible] [--max-steps 25] [--operator console|http|scripted:<scenario>]
hands replay    <capability> --input k=v ... [--version N] [--tenant beta] [--confirm]
                [--inject timeout|interstitial|slow|crash] [--settle-ms N] [--headed]
                [--operator console|http|scripted:<scenario>] [--intervention-timeout-ms N]
hands approve   <capability> [--version N]
hands learn-overrides <capability> --from-run <runId>
hands catalog   [--json]
hands invoke    <capability> --input k=v ...
hands agent     "<question>"
```

Exit codes for `replay`: 0 success or business outcome, 2 failed, 3 escalated.
