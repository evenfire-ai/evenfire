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

### Inventory & navigation (read-only, plus the create-agent wizard)

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
| Marketplace browse | `qa-recorder-marketplace-browse.spec.ts` | 1 — search, filter, plugins tab, entry detail (skips if empty) | — | ✳️ |
| Create agent | `qa-recorder-agent-create.spec.ts` | 1 — full create wizard | `QA_RECORDER_CONFIRM_MUTATIONS` (required) | ✅ |

### Workflow & combo journeys (create / edit / delete / grant)

Full mutating user journeys. Each is self-contained — it creates its own
resources with `uniqueE2EName(...)` and tears them down via the Control API in a
`finally`, so none depend on pre-seeded data or real external credentials
(dummy `qa-recorder-*` values are used where a form wants a value but no real
credential). Run with `npm run qa:recorder:<journey>`.

| Journey | Spec | Tests | Confirm flag | Status |
| --- | --- | --- | --- | --- |
| Context create + detail tour | `qa-recorder-context-create.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Context + stdio discovery connector + attach | `qa-recorder-context-connector.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Connector edit egress | `qa-recorder-connector-edit.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| LLM model add → disable → remove | `qa-recorder-llm-model-lifecycle.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Recipe secret (shared, dummy) | `qa-recorder-secret-recipe.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Connector secret (dummy) | `qa-recorder-secret-connector.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| SharedFileSystem provision + upload + delete | `qa-recorder-shared-fs-upload.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| SharedFileSystem folder create + rename | `qa-recorder-shared-fs-folders.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Global file system folder + upload + rename | `qa-recorder-global-fs.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Team create + detail tour | `qa-recorder-team-create.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Create member + cancel invite (sends email) | `qa-recorder-member-invite.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Admin invite (no Desktop) + cancel (sends email) | `qa-recorder-admin-invite.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Marketplace API key create + reveal + revoke | `qa-recorder-marketplace-api-keys.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Token budget (global) create + edit | `qa-recorder-token-budget.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Token budget scoped to a team | `qa-recorder-token-budget-team.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| LLM price add → edit → delete | `qa-recorder-llm-price.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Create-form availability smoke (15 forms, no submit) | `qa-recorder-create-form-smoke.spec.ts` | 15 | — | ✳️ |
| Settings — username + theme + reset alerts | `qa-recorder-settings-account.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Settings — change password + revert | `qa-recorder-settings-password.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Settings — email change + resend + revert (sends email) | `qa-recorder-settings-email.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |

### Persona combos (multi-resource, end-to-end)

| Journey | Spec | Tests | Confirm flag | Status |
| --- | --- | --- | --- | --- |
| New-team onboarding (team → member → context grant) | `qa-recorder-onboarding-combo.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Cost governance (model → price → model-scoped budget) | `qa-recorder-cost-governance.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |
| Context + connector + global budget | `qa-recorder-context-connector-budget.spec.ts` | 1 | `CONFIRM_MUTATIONS` | ✳️ |

**Totals: 37 specs, 55 tests.** Read-only journeys need no confirmation flag; every
journey still calls the loopback reachability guard on both URLs. Every mutating
journey requires `QA_RECORDER_CONFIRM_MUTATIONS=1`, creates only temporary
`qa-recorder-*` resources, and cleans them up via the Control API in a `finally`
(reverse order, each deletion best-effort). Invite and email/password journeys
have external side effects (an email is sent / the admin password is changed) and
revert to the original state on completion.

**Legend:** ✅ verified against a live `example-dev` environment;
✳️ implemented and compile-verified (`npx playwright test --config=playwright.qa-recorder.config.ts --list`)
but not yet exercised against a live environment — re-run to refresh.

## Run

```bash
cd control-ui
npm run qa:recorder:install   # one-time: recorder Chromium into .local-notes/qa-recorder/browsers
# control-ui dev server on :3000 + control-api forward on :8090 must be up
npm run qa:recorder:login     # one journey
npm run qa:recorder:all       # all 37 specs / 55 tests
```

## Proof artifacts (local only, git-ignored)

```bash
find .local-notes/qa-recorder/runs/control-ui -name '*.webm'   # WebM recordings
find .local-notes/qa-recorder/runs/control-ui -name '*.png'    # full-page screenshots
```

## Last verified

- **Inventory & create-agent (✅):** 2026-07-17 against `example-dev` (GKE) — the
  original 13 specs / 17 tests passed, exit 0, with WebM + PNG proof for every
  test. Point-in-time snapshot; re-run to refresh.
- **Workflow, combo & smoke journeys (✳️):** implemented and compile-verified via
  `npx playwright test --config=playwright.qa-recorder.config.ts --list` (55/55
  tests discovered, zero compile errors). Not yet exercised against a live
  environment — run `npm run qa:recorder:all` (with `QA_RECORDER_CONFIRM_MUTATIONS=1`)
  to produce WebM + PNG proof and flip these to ✅.
