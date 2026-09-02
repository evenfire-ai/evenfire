# Desktop App — headful journey tests

Status snapshot of the optional Playwright **QA recorder** journeys for the
Evenfire Desktop App. These drive the real Electron window headfully (visible UI,
recorded WebM + PNG) against a live `example-dev` port-forward. They are separate
from the CI Playwright suite and never run in CI by default.

Recorder runs are local and opt-in. Configure the exact QA identity in
`.env.qa-recorder`, use only approved development endpoints, and enable a
`QA_RECORDER_CONFIRM_*` flag only for the side effect you intend to exercise.
Recordings stay under the git-ignored `.local-notes/qa-recorder/` directory and
must be reviewed before sharing.

## Coverage

Every Desktop App user journey has at least one headful spec. Each uses the exact
QA identity from `.env.qa-recorder` (no first-available fallback), shares launch /
login / proof plumbing in `qa-recorder-helpers.ts`, and records a WebM + PNG per
test under `.local-notes/qa-recorder/runs/desktop-app/` (git-ignored).

| Journey | Spec | Tests | Confirm flag | Status |
| --- | --- | --- | --- | --- |
| Auth & session | `qa-recorder-auth.spec.ts` | 3 — sign-in screen, authenticated shell, logout | — | ✅ |
| Navigation | `qa-recorder-navigation.spec.ts` | 3 — primary sidebar, footer settings menu, resources pages | — | ✅ |
| Agents | `qa-recorder-agents.spec.ts` | 3 — fleet, chat workspace, workspace routes | — | ✅ |
| Connectors | `qa-recorder-connectors.spec.ts` | 1 — MCP/connector health inventory | — | ✅ |
| Shared files | `qa-recorder-shared-files.spec.ts` | 1 — filesystem + directory browser | — | ✅ |
| Teams & members | `qa-recorder-teams.spec.ts` | 1 — directory + detail tabs | — | ✅ |
| Plugins & workflows | `qa-recorder-plugins.spec.ts` | 1 — inventory, detail, runs/artifacts (+optional trigger) | `QA_RECORDER_CONFIRM_MUTATIONS` (trigger only) | ✅ |
| Apps | `qa-recorder-apps.spec.ts` | 1 — catalog + embedded session | — | ✅ |
| Settings | `qa-recorder-settings.spec.ts` | 2 — appearance/notifications, information/configuration (+optional endpoint switch) | `QA_RECORDER_CONFIRM_MUTATIONS` (switch only) | ✅ |
| Inbox & search | `qa-recorder-inbox-search.spec.ts` | 2 — inbox, global search | — | ✅ |
| Chat | `qa-recorder-chat.spec.ts` | 1 — composer, thread, task progress | `QA_RECORDER_CONFIRM_CHAT` (required) | ✅ |
| Settings + chat smoke | `qa-recorder-settings-chat.spec.ts` | 1 — Settings tabs + one chat message | `QA_RECORDER_CONFIRM_CHAT` (required) | ✅ |

**Totals: 12 specs, 20 tests.** Read-only journeys need no confirmation flag; every
journey still calls the loopback health guard on both API URLs. Mutating / paid
steps (chat message, workflow trigger, endpoint switch) run only under their
`QA_RECORDER_CONFIRM_*` flag and are otherwise skipped — the read-only part of the
journey always runs.

## Run

```bash
cd desktop-app
# dev Evenfire must be closed (process-wide single-instance lock)
make gcp-dev-pf-desktop          # keep control-api/external-rest/rpc-proxy forwarded

npm run qa:recorder:navigation   # one journey
npm run qa:recorder:all          # all 12 specs / 20 tests
```

## Proof artifacts (local only, git-ignored)

```bash
find .local-notes/qa-recorder/runs/desktop-app -name '*.webm'   # WebM recordings
find .local-notes/qa-recorder/runs/desktop-app -name '*.png'    # full-page screenshots
```

Videos may contain emails, agent names, endpoint URLs, prompts, or model responses
and must stay local unless reviewed and shared intentionally.

## Last verified

2026-07-17 against `example-dev` (GKE) port-forwards — the then-current suite
passed with WebM + PNG proof for every test. This is a point-in-time snapshot; re-run
`npm run qa:recorder:all` to refresh.
