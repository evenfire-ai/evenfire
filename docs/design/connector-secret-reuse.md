# Connector Secret reuse: implementation plan and audit

Status: implemented and validated on `feat/ux-improvements-32`; see the
implementation and validation record below. The plan was reviewed twice
before and during implementation, with findings recorded in this document.

## Goal and scope

This explanation and implementation reference is for frontend maintainers and
reviewers. Users must be able to create and manage reusable connector Secrets,
select one when creating a connector, and change the Secret assigned to an
existing credential-bearing connector. All implementation changes are limited
to Control UI. Backend services, API contracts, CRDs, deployments, and Desktop
are outside this change.

## Current flow and findings

1. **Manage Secrets — source-reviewed, existing behavior retained.**
   `SecretsTable` combines provisioned Secret metadata with connector
   `spec.envSecret.name` references. The Secret editor supports keys and env
   files. Listing returns names, key names, and optional identity metadata,
   never credential values.
2. **Create connector — blocked for reuse.**
   `CreateMcpServerForm` only offers a new Kubernetes Secret or no credentials.
   Its validation requires a value for every mapping and always creates the
   Secret. An existing Secret cannot be selected.
3. **Attach to a connector without a reference — already supported.**
   `AttachConnectorCredentials` can create or select a Secret. This structural
   action explains the reported “No credentials required” workaround: the
   eligibility guard rejects every connector that already has `envSecret`.
4. **Edit a credential-bearing connector — blocked for reassignment.**
   The credentials tab only renders the set/rotate editor. That editor changes
   values in the currently referenced Secret; it cannot assign another one.

Screenshots `01-before-create.png` and `02-before-edit.png` were captured and
inspected in this run under the ignored
`.local-notes/infra/runs/connector-secrets-ui/` directory. They show the actual
creation and edit components with project CSS and synthetic API metadata in a
local frontend harness. They establish visible frontend behavior, not deployed
backend behavior or a complete live product audit. No authenticated live
product tab was available. Secret management is source-reviewed only.

Accessibility risks: existing creation mapping inputs rely on placeholders;
new controls need explicit labels. Loading, empty, error, retry, validation,
keyboard selection, and pending states must remain understandable. Screenshots
alone do not establish accessibility compliance.

## Existing integration contract

No backend change is needed for static Secret references:

- `listMcpSecrets()` lists the same provisioned connector Secrets used by
  Secrets → Connectors, including stored key names and optional UID.
- `createMcpServer()` accepts `spec.envSecret = { name, keys }`.
- `updateMcpServer()` accepts a changed reference and caller
  UID/resourceVersion. Preserve the complete latest spec and update only
  `envSecret`; reject concurrent changes instead of replaying stale settings.
- Existing HCC reconciliation resolves the Secret and its keys, injects them
  into the workload, and observes the new generation. Retain the bounded
  `useRolloutWait` verification; a saved reference alone is not readiness.

These conclusions come from read-only inspection of `lib/api.ts`,
`control-api/src/routes/admin/resources.ts`, and the previously reviewed
contract in [connector-credentials-attach.md](connector-credentials-attach.md).
The earlier plan covers keyless attachment; this document extends that scope
without removing its ownership, concurrency, cleanup, or readiness rules.

OAuth uses a separate credential contract. Marketplace OAuth installation
already supports an existing Secret reference. The remote OAuth wizard creates
broker-managed client credentials, not an `envSecret` mapping. Do not rewrite
OAuth through this static credential flow. Static remote connectors retain
their existing authentication header placeholders; assigning a Secret does
not invent authentication headers.

## Implementation sequence

1. **Creation and shared reference selection.** Add “Use an existing Secret”
   alongside the new-Secret and keyless choices. Load metadata with an explicit
   loading/error/retry/empty state. Select stored keys and map them to named
   environment variables. Reuse mapping validation for names, duplicates,
   runtime-reserved variables, and plain-env collisions. Never request values
   for existing keys. Before any creation-side mutation, refresh the Secret
   listing and verify its identity and selected keys. Skip Secret creation,
   updates, and rollback deletion in reference mode. Preserve the existing
   new-Secret transaction and cleanup behavior.
2. **Existing connector reassignment.** Add a distinct “Change assigned Secret”
   action beside the set/rotate surface for eligible managed, enabled, static
   connectors with a valid reference. Open an existing-Secret assignment form
   with explicit cancel. Keep value rotation separate. Preserve current
   environment-variable destinations when choosing replacement keys; do not
   silently drop required mappings. Recheck the displayed connector snapshot,
   selected Secret identity/keys, ownership, and resource version before save.
   Save only the reference and never mutate or delete either shared Secret.
   Show old and new names in restart confirmation. Preserve egress interlocks,
   spec-save recovery, and bounded readiness verification.
3. **Connect management to assignment.** Explain in Secrets → Connectors that
   reusable Secrets are assigned from a connector's Credentials tab or during
   creation. Use canonical route builders for any navigation. Preserve current
   key/env-file management and usage reporting.
4. **Verify and record.** Test creation reuse, multiple connector references,
   replacement including an old Secret that is no longer present, selected
   Secrets that were replaced or lost, missing keys, load failures, conflicts,
   unchanged assignments, spec preservation, no Secret writes or deletes on
   reuse, and rollout recovery.
   Run focused regressions, Control UI typechecking, applicable style checks,
   and the full UI suite/build when dependencies permit. Inspect regular and
   narrow viewport screenshots with synthetic metadata. Record live-runtime
   limits explicitly. Commit and push the reviewed plan, implementation
   milestones, and final evidence to the current branch.

## Plan audit before implementation

| Review question                                        | Finding and resolution                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Is the scope frontend-only?                            | Yes. Read backend contracts as evidence; change only Control UI and this document.                                 |
| Does the plan address both reported dead ends?         | Yes: existing-secret selection at creation and reassignment for an existing `envSecret`.                           |
| Could reuse overwrite or delete shared credentials?    | Reference-only paths must have no Secret create/update/delete calls, including error cleanup.                      |
| Could reassignment clobber a concurrent edit?          | Compare the displayed spec with a fresh snapshot and use live UID/resourceVersion for the final write.             |
| Could a key rename silently break authentication?      | Preserve each existing destination and require an explicit replacement key when it is absent in the new Secret.    |
| Is missing-secret repair preserved?                    | Keep the current set/rotate editor and offer change-assignment independently of stale Secret status.               |
| Can a new reference be mistaken for a ready connector? | Keep saved and ready states separate; use existing generation-correlated polling.                                  |
| Are all credential types interchangeable?              | No. Keep OAuth and recipe ownership boundaries and explain static remote placeholder limitations.                  |
| Can visual evidence prove live integration?            | No. Local synthetic screenshots plus frontend tests verify UI contracts; deployed runtime remains a separate lane. |

Audit verdict: proceed with the above constraints. No user decision or backend
work is needed for the planned static credential fixes.

## Implementation review of the inherited WIP

Second review, performed on the uncommitted selector/reassignment WIP found in
the working tree on top of `54a30f064`. The WIP was adopted, not restarted.
Findings and resolutions:

1. **Appended test cases were structurally broken (harness, not product).**
   The new `connectorCredentials.test.ts` cases passed bare arrays to
   `it.each`, so Vitest spread each case into positional arguments: `items`
   arrived as `undefined` or as a single Secret object instead of the items
   array. The cases need one extra array level; no implementation change.
2. **A stale or missing key could be answered with a value prompt.**
   `validateCredentialAttach('use-existing', …)` intentionally allows keys that
   are not yet stored in the selected Secret (the keyless-attach flow writes
   those values into the shared Secret). The reference-only selector inherited
   that behavior, so a key missing from the selected Secret produced "Enter a
   credential value" — exactly the value re-entry this plan forbids.
   Resolution: `validateCredentialAttach` gains an options object with
   `storedKeysOnly`; the reuse selector, creation validation, reassignment
   gating, and the pre-mutation verifier use it so a missing or stale key
   reports a key-selection error, and a supplied value is rejected. Keyless
   attach keeps its existing permissive behavior.
3. **Focus was dropped when the change flow closed.** The edit page swaps the
   whole credentials panel, so after cancel or finish the opener button
   remounts and keyboard focus fell to `<body>`. Resolution: the page returns
   focus to the "Change assigned Secret" trigger once the panel has reloaded.
4. **The rotation busy interlock had no coverage.**
   `UpdateConnectorCredentials` now reports busy while its confirm dialog is
   open, which drives the page's duplicate-submit guard and tab/back
   navigation lock. Tests pin the dialog-open busy report and the guard.
5. **Cosmetic.** The edit-page fragment around `UpdateConnectorCredentials`
   was misindented (formatter fixes it). The "Manage connector Secrets" link
   inside the selector stays clickable while the fieldset is disabled; that is
   acceptable read-only navigation, not a mutation path.
6. **Verified non-issues.** Reference-only paths never call
   `createMcpSecret`, `updateMcpSecret`, or `deleteMcpSecret`, including the
   create form's rollback (gated on `willCreateSecret`, which is false in
   reference mode). Reassignment rechecks the displayed snapshot and the live
   UID/resourceVersion before and after verification, writes only
   `spec.envSecret`, and never cleans up either shared Secret on error.
   Unchanged assignments are refused client- and helper-side. Keyless attach,
   OAuth, recipe ownership, and remote auth-header placeholders keep their
   existing boundaries.

## Implementation and validation record

All work is frontend-only: Control UI plus this document. Implementation
milestones:

1. **Reference-only selection contract.** `validateCredentialAttach` accepts
   an `AttachValidationOptions` argument; `storedKeysOnly` requires every key
   to exist in the selected Secret, answers a missing or stale key with a
   key-selection error (never a value request), and rejects any supplied
   value. It is used by the reuse selector, the creation form's validation,
   the reassignment gate, and `verifyExistingCredentialSelection`. Keyless
   attach keeps its existing behavior of writing new keys (with values) into
   a shared Secret.
2. **Creation reuse.** The creation Secrets step offers a third choice, "Use
   an existing Secret", backed by `ExistingConnectorSecretFields`: explicit
   loading, error/retry, and empty states, an on-demand refresh, and explicit
   key → environment-variable mappings with no value inputs. Submission
   verifies the Secret's live identity and keys before any access-scope
   creation or connector write; the rollback path can only delete a Secret
   the same submission created (`willCreateSecret` stays false in reference
   mode), so a failed creation never touches the shared Secret.
3. **Reassignment.** Eligible managed, enabled, static connectors with a
   valid `spec.envSecret` show an "Assigned Secret" section with "Change
   assigned Secret" beside the untouched rotation editor.
   `ChangeConnectorSecret` preserves each destination environment variable,
   requires an explicit replacement key when the new Secret lacks one,
   confirms with the old and new Secret names, and saves only
   `spec.envSecret` through `changeConnectorSecretReference` (fresh snapshot
   plus UID/resourceVersion checks before the write, unchanged-assignment
   refusal, and no Secret create/update/delete on any error path). Readiness
   reuses the bounded generation-correlated `useRolloutWait` observation;
   saved and ready remain separate states. Recipe-owned, OAuth, disabled, and
   keyless connectors keep their existing surfaces, and the eligible change
   trigger is hidden otherwise.
4. **Focus and interlocks.** The edit page returns keyboard focus to the
   "Change assigned Secret" trigger after cancel or finish, waiting out the
   post-save reload. `UpdateConnectorCredentials` reports busy while its
   confirm dialog is open, which drives the page's duplicate-submit guard and
   the tab/back navigation lock; the change flow feeds the same `attachBusy`
   signal.
5. **Management guidance.** The Secrets → Connectors header explains that
   reusable Secrets are assigned during connector creation or from the
   connector's Credentials tab via Change assigned Secret; other scopes keep
   the generic subtitle.
6. **Custom Secret picker.** After operator feedback on the inherited
   native `<select>` (unstyled popup and visible flicker on click in the
   credentials tab), the Existing Secret picker now reuses the repository's
   `SelectionDropdown` primitive in single-select mode: the popup renders
   roughly four rows with its own scroll (the shared list cap of
   `min(12rem, 30vh)`), keyboard and Escape still work, and the component
   carries `aria-expanded`/`aria-haspopup`/`role="option"` semantics with
   the same accessible name ("Existing Secret") as before. The "Manage
   connector Secrets" entry point changed from a new-tab link to a plain
   ghost button that navigates in the same tab and disables while the
   flow is locked, so a pending assignment cannot be lost to a stray
   click. The per-row Secret key selects remain native selects: their
   option lists are small and they did not flicker.

Validation evidence (Node 24 via
`PATH=/home/pal/.nvm/versions/node/v24.22.1/bin:$PATH`, `UV_USE_IO_URING=0`
on every npm command; exact command lines as run, from the `control-ui`
directory unless noted):

- Focused suites:

  ```text
  UV_USE_IO_URING=0 npm test -- --maxWorkers=1 \
    components/__tests__/CreateMcpServerForm.test.tsx \
    components/__tests__/EditMcpServerPageAttach.test.tsx \
    components/__tests__/EditMcpServerPageCredentials.test.tsx \
    components/__tests__/UpdateConnectorCredentials.test.tsx \
    components/__tests__/SecretsTable.test.tsx \
    lib/__tests__/connectorCredentials.test.ts \
    components/__tests__/ChangeConnectorSecret.test.tsx \
    components/__tests__/ExistingConnectorSecretFields.test.tsx
  ```

  Result: 8 files, 254 tests passed. (The inherited WIP's first run of the
  same selection was 221 tests with 3 failed; the failures were the
  `it.each` harness defect above and were fixed, not skipped.)

- New coverage includes: selector loading/error/retry/empty and refresh;
  auto-mapping with destination preservation when keys differ; stale/missing
  keys producing key-selection errors without value prompts; unchanged
  assignment no-op; blocked-reason display; confirmation naming both Secrets
  and "Other connectors keep their current assignments"; the spec-only PUT
  carrying UID and resourceVersion; concurrent-change refusal; 409 and
  uncertain-save handling with no shared-Secret cleanup; correlated
  readiness success and bounded timeout recovery; page-level eligibility
  gating (recipe-owned hides the trigger); the busy tab interlock; focus
  return after cancel and after finish; the rotation confirm-dialog busy
  report; and the Secrets guidance copy.
- Typecheck: `node_modules/.bin/tsc --noEmit --incremental false -p
tsconfig.json` — clean.
- Style rules (repository root): `UV_USE_IO_URING=0 npm run style-rules` —
  0 errors, 1 pre-existing desktop-app warning outside this change's scope.
- Formatting: `node_modules/.bin/prettier --write` over every changed file;
  `git diff --check` — clean.
- Full suite: `UV_USE_IO_URING=0 npm test -- --maxWorkers=1` — 251 files,
  2885 tests passed.
- Build: `UV_USE_IO_URING=0 npm run build` (the package script is
  `NEXT_IGNORE_INCORRECT_LOCKFILE=1 next build`) — completed successfully.
- Evidence capture: all of the above ran inline in the implementation
  session; command output was captured in that session's transcript only.
  No test or build log files were persisted to disk, and none of this
  evidence is committed.

## Repository version hook delta

An earlier report sentence claimed "no lockfile changes"; that was wrong and
is corrected here. The repository pre-commit hook
(`scripts/precommit/bump-staged-package-versions.mjs`) increments
`control-ui/package.json` and re-synchronizes the two version fields in
`control-ui/package-lock.json` whenever a commit stages any file inside the
package. Across `54a30f064..0e896d226` the hook produced exactly this
delta, and nothing else outside `control-ui` and this document:

- `control-ui/package.json`: `0.1.751` → `0.1.752` (commit `bb03b1e0a`) →
  `0.1.753` (commit `8c8168186`).
- `control-ui/package-lock.json`: the top-level `"version"` and
  `packages[""].version` fields follow the same two bumps (`0.1.751` →
  `0.1.753`; four changed lines in the range diff). The dependency graph is
  unchanged — no dependency entries, resolutions, or integrity values moved.

The hook keys off staged file paths, so documentation-only commits (such as
this correction) do not bump anything. The later Playwright test commit
(`c9f217623`) triggered the same mechanism once more: `0.1.753` → `0.1.754`
in `package.json` with the matching two lockfile version fields (4 lines).

## CI leak-guard fix

The "Leak guards (identifiers + secrets)" check failed on the PR's earlier
head (run `40029625442`, job `120674358474`): gitleaks 8.30.1 reported one
finding against `.gitleaks.toml` with the default ruleset. The report path
points into this document, and the offending content was prose, not a
credential: the verification checklist's phrase that followed the words
"old Secrets" with a comma and the slash-joined word pair (missing then
replaced) matched the `generic-api-key` rule, which reads a `secret`
keyword followed by a comma-separated token of `[a-z0-9-_=/+]` characters
as a leaked key. The sentence came from the reviewed plan itself.

Fix: the checklist was reworded to "an old Secret that is no longer present,
selected Secrets that were replaced or lost" — same meaning, no keyword-plus-
token sequence (commit `1f86edcce`). The fix was verified locally with the
exact CI recipe before pushing — gitleaks 8.30.1, the repository's
`.gitleaks.toml`, scanned over `git archive HEAD` — reporting "no leaks
found", and the same check then passed on GitHub (run `40040321077`, job
`120709615475`). No allowlist entry was added and no guard was weakened.

## Playwright coverage (mocked-API frontend E2E)

Durable browser coverage lives in
`control-ui/e2e/connector-secret-reuse.spec.ts`, using the repository's
existing Playwright setup (`@playwright/test` 1.58.2, `control-ui/playwright.config.ts`,
`testDir ./e2e`, chromium project) and the same pattern as the existing
mocked specs (`controlUiAdminToken` in localStorage plus
`page.route('**/api/v1/admin/**')`). The app under test is the REAL built
Control UI served by `next start -p <port> -H 127.0.0.1` from the production
`.next` build; `CONTROL_UI_BASE_URL` points the suite at it. The routes are
the real ones: `/connectors/new` (rewritten to `/mcp-servers/new`) and
`/connectors/linear/edit/credentials`.

Boundary, stated plainly: this is **mocked-API frontend E2E**. The Control
API is replaced at the browser network layer, so the specs prove what the
real browser sends and renders — they are not live-backend E2E and not T2
certification. Mocks carry metadata only (names, key names, UIDs, spec
references) and every Secret write endpoint is recorded so reference-only
journeys can prove zero Secret POST/PUT/DELETE. No credentials, `.env`, or
cluster state are involved.

The twelve scenarios, all passing in one Chromium run (about 19 seconds):

1. Creation from an existing Secret: no value inputs render, both stored
   keys are auto-mapped (API_KEY, WORKSPACE_ID), and the captured
   `POST /admin/mcp-servers` body persists
   `spec.envSecret = { name, keys }` with zero Secret writes.
2. The same Secret reused by two connectors created back to back: two
   connector POSTs reference it, the Secret list is read each time, and no
   Secret POST/PUT/DELETE occurs.
3. Listing outage at creation: error alert, disabled submit, retry
   recovers, and no value prompts appear.
4. A genuinely empty Secret catalog at creation: the picker enables on an
   empty list, the empty-state guidance shows, Create stays disabled, and
   no value prompts appear.
5. Change assigned Secret, happy path: destinations preserved
   (LINEAR_API_KEY, LINEAR_WORKSPACE), confirmation names both Secrets,
   the captured `PUT /admin/mcp-servers/linear` carries CAS
   `metadata.uid`/`resourceVersion` and changes only `envSecret` in an
   otherwise identical spec, and a fresh `DeploymentReady=True` (post-cutoff
   timestamp, matching observedGeneration) resolves the wait, reloads the
   page on the new reference, and returns focus to the trigger.
6. Saved but not ready: after the PUT, polls never observe a fresh Ready
   condition; the panel keeps "Assignment saved. Waiting for…", tabs stay
   disabled, and "Check credentials later" leaves cleanly onto the new
   reference with focus returned.
7. Concurrent change: the live connector diverges from the displayed
   snapshot between verification reads — the assignment is refused before
   any write, the panel locks until refresh, and no Secret is touched.
8. No-op refusal (re-selecting the current Secret), explicit replacement
   key demanded when a stored key is missing (empty key select plus a
   key-selection alert, never a value prompt), and cancel returning focus
   to the trigger with nothing written.
9. A genuinely empty Secret catalog in the change flow: reassignment stays
   disabled with no value prompts.
10. Control proof for the no-mutation capture: deliberately issued
    in-page `PUT` and `DELETE` against `mcp-secrets/<name>` (including a
    value-bearing body) are both recorded by the write capture — pinned by
    assertion, not by the fallback 404 — while every journey test asserts
    the same capture stays empty.
11. Listing outage inside the change flow: alert plus retry recovery.
12. Narrow viewport (390×844): the change flow stays usable with
    `document.scrollWidth <= window.innerWidth`, verified in the browser.

Two review-driven corrections hardened this suite after its first nine-test
version: the no-mutation capture now records every non-GET under both
`mcp-secrets` and the `mcp-secrets/` child prefix **before** any endpoint
dispatch (scenario 10 proves named PUT/DELETE are detected), the catalog
fixture became configurable so scenarios 4 and 9 exercise real empty
listings, and the route/init-script registrations are awaited before any
navigation, removing the setup races the first version had.

Runner (operational state stays under the ignored
`.local-notes/infra/runs/connector-secrets-ui/playwright/`; the runner
script `run.sh` there starts the server, runs the suite, and always stops
it; logs and six screenshots — confirm dialog, saved-not-ready, missing-key
choice, narrow viewport, and the creation and ready flows — are saved
beside it):

```text
cd control-ui
CONTROL_UI_BASE_URL=http://127.0.0.1:<port> \
  node_modules/.bin/playwright test e2e/connector-secret-reuse.spec.ts \
  --project=chromium --reporter=list
```

Result on the committed spec: **12 passed / 0 failed / 0 skipped**
(Chromium, headless), including the 390px pass. The full-unit, typecheck,
style, and build evidence above was unchanged by the spec (it adds no app
code); `tsc --noEmit` stays green — the app `tsconfig` excludes `e2e` by
repository convention, and Playwright transpiles the spec itself — and the
root style-rules check reports 0 errors. The gitleaks scan above was re-run
with the spec overlaid into the archive tree: no leaks found.

Limits: the rollout poll runs on real 3-second ticks, so the happy path
observes readiness within seconds; the 180-second timeout terminal state is
covered by component-level unit tests rather than a real 5-minute browser
wait, which would add no coverage the mocks cannot express. Everything in
this section remains mocked-API frontend evidence.

## GitHub checks

Tracked by PR #858; a commit's own conclusion is always read from that
commit's runs, never inherited from an earlier SHA:

- `1f86edcce` (leak-guard fix): all checks green, including Leak guards
  (identifiers + secrets) — run `40040321077`, job `120709615475` — and
  CodeQL.
- `c9f217623` (Playwright spec, hook bump to `0.1.754`): all 60 checks
  green — Build/test/typecheck and Leak guards under run `40044380395`,
  CodeQL under run `40044380264`.
- The documentation commit that carries this section is the final head of
  this change; its own check run is the acceptance run and is reported
  alongside this document rather than self-recorded here, since a commit
  cannot contain its own run URL.

Limits: all evidence is local and synthetic. No authenticated live product
session was available, so no live backend, E2E, or deployed-runtime behavior
is claimed. The planning screenshots under the ignored
`.local-notes/infra/runs/connector-secrets-ui/` show the pre-change UI only.
Backend reconciliation (HCC resolving a referenced Secret and restarting the
workload) is outside frontend evidence and stays governed by the existing
contract tests.
