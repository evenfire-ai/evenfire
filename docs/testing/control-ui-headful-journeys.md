# Control UI — headful journey tests

Status snapshot of the optional Playwright **QA recorder** journeys for the
Clerum Control UI (Next.js operator/admin web app). These drive a real headful
Chromium window (recorded WebM + PNG) against a local control-ui dev server
pointed at a `example-dev` control-api port-forward. They are separate from the CI
Playwright suite and never run in CI by default.

For the recorder contract, safety flags, and credential configuration, see
[optional-playwright-qa-recorder.md](./optional-playwright-qa-recorder.md).

## Coverage

Every common Control UI operator journey has at least one headful spec. Each
signs in with the exact admin identity from `.env.qa-recorder`, shares
launch/login/proof plumbing in `e2e/qa-recorder-helpers.ts`, and records a WebM +
PNG per test under `.local-notes/qa-recorder/runs/control-ui/` (git-ignored).

| Journey | Spec | Tests | Confirm flag | Status |
| --- | --- | --- | --- | --- |
| Login & shell | `qa-recorder-login.spec.ts` | 2 — sign-in page, authenticated shell | — | ✅ |
| Navigation | `qa-recorder-navigation.spec.ts` | 1 — sidebar across main sections | — | ✅ |
| Agents (hosts) | `qa-recorder-agents.spec.ts` | 1 — list + detail | — | ✅ |
| Contexts | `qa-recorder-contexts.spec.ts` | 2 — list, detail + tabs | — | ✅ |
| Connectors | `qa-recorder-connectors.spec.ts` | 1 — inventory | — | ✅ |
| External channels | `qa-recorder-external-channels.spec.ts` | 1 — Telegram/Email/Slack | — | ✅ |
| LLM models & secrets | `qa-recorder-llm-models.spec.ts` | 1 — models catalog + secrets | — | ✅ |
| Users & teams | `qa-recorder-users-teams.spec.ts` | 1 — directory | — | ✅ |
| Cost & usage | `qa-recorder-cost-usage.spec.ts` | 1 — usage dashboard | — | ✅ |
| Traces | `qa-recorder-traces.spec.ts` | 2 — dashboard, state | — | ✅ |
| Settings | `qa-recorder-settings.spec.ts` | 1 — read-only settings | — | ✅ |
| Marketplace & plugins | `qa-recorder-marketplace.spec.ts` | 2 — connectors, plugins | — | ✅ |
| Create agent | `qa-recorder-agent-create.spec.ts` | 1 — full create wizard | `QA_RECORDER_CONFIRM_MUTATIONS` (required) | ✅ |

**Totals: 13 specs, 17 tests.** Read-only journeys need no confirmation flag; every
journey still calls the loopback reachability guard on both URLs. The only
mutating journey (create agent) requires `QA_RECORDER_CONFIRM_MUTATIONS=1` and
cleans up its temporary agent/context in a `finally`.

## Run

```bash
cd control-ui
npm run qa:recorder:install   # one-time: recorder Chromium into .local-notes/qa-recorder/browsers
# control-ui dev server on :3000 + control-api forward on :8090 must be up
npm run qa:recorder:login     # one journey
npm run qa:recorder:all       # all 13 specs / 17 tests
```

## Proof artifacts (local only, git-ignored)

```bash
find .local-notes/qa-recorder/runs/control-ui -name '*.webm'   # WebM recordings
find .local-notes/qa-recorder/runs/control-ui -name '*.png'    # full-page screenshots
```

## Last verified

2026-07-17 against `example-dev` (GKE) — 17/17 passed, exit 0, with WebM + PNG
proof for every test. Point-in-time snapshot; re-run `npm run qa:recorder:all`
to refresh.
