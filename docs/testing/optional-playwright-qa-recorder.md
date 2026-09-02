# Optional Playwright QA recorder

The QA recorder is an opt-in local workflow for recording complete Control UI
and Desktop App journeys as WebM videos. It is deliberately separate from the
normal unit, build, Playwright, and CI paths.

Using the recorder is not required to build, test, or develop Clerum. No
existing command invokes it, and no CI workflow installs its browser or runs
its journeys.

The recorder consumes an environment that is already running. It never starts
Docker or minikube, builds backend images, deploys services, or invokes another
test suite. Pointing it at an existing `example-dev` port-forward is therefore a
Playwright/Chromium operation, not a local-stack bootstrap.

## Included journeys

### Control UI: create an agent

The Control UI journey:

1. Signs in through the real UI.
2. Opens the canonical `/hosts` Agents route.
3. Opens `/hosts/new` through the Create agent button.
4. Creates a uniquely named context and agent.
5. Selects the exact LLM secret supplied by the operator.
6. Optionally grants the agent to an explicitly named member.
7. Skips channel setup.
8. Verifies the resulting resource through Control API.
9. Deletes the temporary agent and context in a `finally` cleanup.

This journey mutates the target environment temporarily. It will not run
unless `QA_RECORDER_CONFIRM_MUTATIONS=1` is enabled in `.env.qa-recorder`.

### Control UI: full headful journey suite

The recorder also ships one headful spec per common Control UI operator journey
(login, navigation, agents, contexts, connectors, external channels, LLM models
& secrets, users & teams, cost & usage, traces, settings, marketplace). Each
shares launch/login/proof plumbing in `e2e/qa-recorder-helpers.ts`, signs in with
the exact admin identity from `.env.qa-recorder`, and records a WebM + PNG under
`.local-notes/qa-recorder/runs/control-ui/`. They are read-only (no confirm flag
needed); only the `agent-create` journey above mutates. See
[control-ui-headful-journeys.md](./control-ui-headful-journeys.md) for the full
status table. Run one with `npm run qa:recorder:<journey>` or all with
`npm run qa:recorder:all`.

### Desktop App: Settings and chat

The Desktop journey:

1. Builds and launches the actual Electron app.
2. Signs in with an explicitly supplied test identity.
3. Visits Appearance, Notifications, and Information in Settings.
4. Opens the exact agent supplied through `E2E_HOST_REF`.
5. Sends a short real chat message.
6. Waits for a non-empty assistant response.
7. Closes Electron so its WebM recording is finalized.

This journey can create chat history and incur model-provider cost. It will not
run unless `QA_RECORDER_CONFIRM_CHAT=1` is enabled in `.env.qa-recorder`.

### Desktop App: full headful journey suite

The recorder also ships one headful spec per Desktop App user journey. Each
journey lives in its own `qa-recorder-<journey>.spec.ts`, shares the same
launch/login/proof plumbing in `qa-recorder-helpers.ts`, uses the exact QA
identity from `.env.qa-recorder` (no first-available fallback), and records a
WebM + PNG under `.local-notes/qa-recorder/runs/desktop-app/`.

| Journey        | Spec                               | Notes                                                                                               |
| -------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| Auth & session | `qa-recorder-auth.spec.ts`         | Sign-in, authenticated shell, logout. Read-only.                                                    |
| Navigation     | `qa-recorder-navigation.spec.ts`   | Sidebar, footer Settings/Resources menus, page shells. Read-only.                                   |
| Agents         | `qa-recorder-agents.spec.ts`       | Fleet, exact `chatllm` row, workspace routes. Read-only.                                            |
| Connectors     | `qa-recorder-connectors.spec.ts`   | MCP/connector health inventory. Read-only.                                                          |
| Contexts       | `qa-recorder-contexts.spec.ts`     | List + detail tabs (`development`/`moneymaking`). Read-only.                                        |
| Shared files   | `qa-recorder-shared-files.spec.ts` | Filesystem + directory browser. Read-only.                                                          |
| Teams          | `qa-recorder-teams.spec.ts`        | Teams directory + detail tabs. Read-only.                                                           |
| Plugins        | `qa-recorder-plugins.spec.ts`      | Inventory, detail, runs/artifacts. Trigger gated by `QA_RECORDER_CONFIRM_MUTATIONS`.                |
| Apps           | `qa-recorder-apps.spec.ts`         | Catalog + embedded session. Read-only.                                                              |
| Settings       | `qa-recorder-settings.spec.ts`     | Appearance, notifications, configuration. Endpoint switch gated by `QA_RECORDER_CONFIRM_MUTATIONS`. |
| Inbox & search | `qa-recorder-inbox-search.spec.ts` | Inbox, notifications, global search. Read-only.                                                     |
| Chat           | `qa-recorder-chat.spec.ts`         | Composer, thread, task progress. Requires `QA_RECORDER_CONFIRM_CHAT=1`.                             |

The combined `qa-recorder-settings-chat.spec.ts` smoke (Settings tabs + one chat
message) is unchanged. Read-only journeys need no confirmation flag; every
journey still calls the loopback health guard on both API URLs. Run one journey
with its namespaced command (below) or all of them with `npm run qa:recorder:all`.

### Plugin Workload SDK Desktop gate

`plugin-workload-sdk-sandbox-ui.spec.ts` is an explicit, manual-only gate. The
normal Desktop Playwright suite intentionally skips it unless
`E2E_PLUGIN_SDK_DESKTOP=1`; a skipped optional recorder is not a green SDK
validation result. Run the dedicated Make target only after the branch-owned
profile port map is exported and the operator has approved the one real
prompt/notification journey:

```bash
E2E_PLUGIN_SDK_WRITE_CONFIRM=1 \
E2E_PLUGIN_SDK_EXPECT_PROVIDER=codex-subscription \
CONTROL_UI_BASE_URL=http://127.0.0.1:<random-control-ui-port> \
CONTROL_API_BASE_URL=http://127.0.0.1:<random-control-api-port> \
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<random-external-rest-port> \
RPC_PROXY_BASE_URL=http://127.0.0.1:<random-rpc-port> \
KUBECONTEXT=<branch-profile-context> \
make test-e2e-plugin-workload-sdk-desktop
```

`E2E_PLUGIN_SDK_EXPECT_PROVIDER` is **mandatory and has no default**. It
declares which provider the run is meant to exercise, and the precondition
asserts the live recipe declares exactly that one. Without it the spec used to
accept `openai`, `claude` or `codex-subscription` and skip its Codex assertions
when the recipe was not Codex — so a run against the OpenAI recipe that
`seed-e2e-data.sh` provisions by default went green while proving nothing about
Codex. Declare the provider you intend to evidence; a mismatch now fails the
precondition instead of quietly narrowing the run.

The target sets the opt-in flag only for this spec, requires non-default
branch-owned URLs, and compares them with the exact `ports.env` generated for
the selected branch profile. It runs the actual Electron/WebContentsView
journey and fails before building if the profile map is missing or belongs to a
different context. It does not start Minikube or create grants; those
prerequisites must already be provided by the T2/T3 profile lane.

### No-grant guard lane

`plugin-workload-sdk-no-grant-guard.spec.ts` is the regression test for the
symptom of issue #533: a Codex recipe whose execution binding is missing must
report `awaiting_policy`, never `validated`. It lives in its own spec and its
own Make target because it is mutually exclusive with the happy path — that one
requires the recipe to reach `validated`, this one requires it not to.

```bash
E2E_PLUGIN_SDK_WRITE_CONFIRM=1 \
E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME=<codex-recipe-without-binding> \
E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE=<its-app-title> \
CONTROL_UI_BASE_URL=http://127.0.0.1:<random-control-ui-port> \
CONTROL_API_BASE_URL=http://127.0.0.1:<random-control-api-port> \
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<random-external-rest-port> \
RPC_PROXY_BASE_URL=http://127.0.0.1:<random-rpc-port> \
KUBECONTEXT=<branch-profile-context> \
make test-e2e-plugin-workload-sdk-desktop-no-grant
```

Both variables above are **mandatory**: the spec has no default recipe and fails
loudly when either is missing, and it refuses to run against the happy path's
recipe even if pointed at it. `E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAMESPACE` is the
one optional knob and defaults to `sandbox-recipes` — set it explicitly when the
ungranted fixture lives elsewhere, or the lane will look for the right recipe
name in the wrong namespace. This target takes no
`E2E_PLUGIN_SDK_EXPECT_PROVIDER`: no provider is supposed to be reached, so
there is none to declare. **Provisioning a Codex recipe with no execution
binding is operator work** — the lane will not create one, and a lane that
cannot find its fixture fails rather than skipping.

### Codex fallback lane

`plugin-workload-sdk-codex-fallback.spec.ts` closes acceptance criterion 8 of
issue #533: a real journey where an eligible Codex failure reaches the
authorized non-Codex fallback. It runs against the **granted** happy-path
recipe, because the fallback needs a working ordered target list.

```bash
E2E_PLUGIN_SDK_WRITE_CONFIRM=1 \
E2E_PLUGIN_SDK_EXPECT_PROVIDER=codex-subscription \
CONTROL_UI_BASE_URL=http://127.0.0.1:<random-control-ui-port> \
CONTROL_API_BASE_URL=http://127.0.0.1:<random-control-api-port> \
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<random-external-rest-port> \
RPC_PROXY_BASE_URL=http://127.0.0.1:<random-rpc-port> \
KUBECONTEXT=<branch-profile-context> \
make test-e2e-plugin-workload-sdk-desktop-codex-fallback
```

**This lane mutates cluster state.** It scales `control-plane/codex-llm-proxy`
to zero replicas so the primary target fails with a class the failover engine
accepts, then restores it to one. The restore runs twice — in the spec's
`finally` and again in a Make-level `EXIT` trap — and both report loudly on
failure. If you ever see `[E2E-GUARD] FAILED to restore
control-plane/codex-llm-proxy`, restore it before running any other lane on
that profile: every Codex journey after it would fail for the wrong reason.

`E2E_PLUGIN_SDK_EXPECT_PROVIDER` must be exactly `codex-subscription`; the
target rejects any other value, because a non-Codex primary would make the
journey vacuous. The recipe knobs are shared with the happy path and carry
**silent defaults** — `E2E_PLUGIN_SDK_RECIPE_NAME` defaults to
`evenfire-prompt-notify-app`, `E2E_PLUGIN_SDK_RECIPE_NAMESPACE` to
`sandbox-recipes`, and `E2E_PLUGIN_SDK_APP_TITLE` to `Prompt & Notify`. Set
them explicitly whenever your fixture differs, or the lane looks for the wrong
app in the Desktop catalog and fails at the card locator rather than at a
precondition.

The grant must expose **at least two ordered prompt targets**, Codex first and
a non-Codex provider second. The spec asserts that before injecting the fault:
a single-target grant would let the journey pass while proving nothing, so it
fails as a precondition instead.

## Repository isolation

The recorder adds new commands; it does not alter any existing command:

| Package       | Optional command                    | Purpose                                                                                                                                                                                     |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control-ui`  | `npm run qa:recorder:install`       | Download recorder-only Chromium                                                                                                                                                             |
| `control-ui`  | `npm run qa:recorder:agent-create`  | Record the agent creation journey                                                                                                                                                           |
| `control-ui`  | `npm run qa:recorder:<journey>`     | Record one headful journey (`login`, `navigation`, `agents`, `contexts`, `connectors`, `external-channels`, `llm-models`, `users-teams`, `cost-usage`, `traces`, `settings`, `marketplace`) |
| `control-ui`  | `npm run qa:recorder:all`           | Record every Control UI recorder journey                                                                                                                                                    |
| `desktop-app` | `npm run qa:recorder:settings-chat` | Build and record the Settings+Chat Electron journey                                                                                                                                         |
| `desktop-app` | `npm run qa:recorder:<journey>`     | Build and record one headful journey (`auth`, `navigation`, `agents`, `connectors`, `contexts`, `shared-files`, `teams`, `plugins`, `apps`, `settings`, `inbox-search`, `chat`)             |
| `desktop-app` | `npm run qa:recorder:all`           | Build and record every Desktop recorder journey                                                                                                                                             |

The normal `test`, `build`, `test:e2e:playwright`, and `test:e2e:all` commands
retain their existing behavior. The dedicated configs match only their
dedicated recorder specs, so they cannot accidentally expand into a full E2E
suite.

The implementation files that belong in Git are:

```text
.env.qa-recorder.example
scripts/qa-recorder/loadEnv.ts
control-ui/
  e2e/qa-recorder-agent-create.spec.ts
  playwright.qa-recorder.config.ts
desktop-app/test/e2e-playwright/
  qa-recorder-helpers.ts
  qa-recorder-settings-chat.spec.ts
  qa-recorder-<journey>.spec.ts   # one per Desktop journey (see table above)
  playwright.qa-recorder.config.ts
docs/testing/optional-playwright-qa-recorder.md
```

The developer's private settings file is:

```text
.env.qa-recorder
```

It is ignored by Git. All other machine-specific state goes under:

```text
.local-notes/qa-recorder/
  browsers/              # Control UI Chromium download
  runs/
    control-ui/          # Control screenshots, traces, and WebM
    desktop-app/         # Electron profile, diagnostics, and WebM
```

`.local-notes/qa-recorder/` is explicitly ignored, and `.local-notes/` remains
ignored as a second boundary. The repository's existing `**/test-results/`,
`**/playwright-report/`, and browser-cache rules provide defense in depth for
any Playwright output produced outside the configured recorder root.

The root `.env.*` ignore rule excludes `.env.qa-recorder`; only
`.env.qa-recorder.example` is explicitly tracked.

Do not add an exception that force-adds recorder output. Videos may contain
email addresses, agent names, endpoint URLs, secret names, prompts, or model
responses and must remain local unless reviewed and shared intentionally.

## Configure once

From the repository root:

```bash
cp .env.qa-recorder.example .env.qa-recorder
```

Open `.env.qa-recorder` and fill in the blank credentials and fixture names.
For the Desktop journey, the minimum settings to review are:

```dotenv
QA_RECORDER_CONFIRM_CHAT=1
E2E_DEV_LOGIN_EMAIL=test@clerum.io
E2E_DESKTOP_PASSWORD=your-local-test-password
E2E_HOST_REF=chatllm
```

For the Control UI journey:

```dotenv
QA_RECORDER_CONFIRM_MUTATIONS=1
E2E_ADMIN_USER=admin
E2E_ADMIN_PASSWORD=your-local-admin-password
E2E_AGENT_SECRET_NAME=your-existing-secret-name
```

The example includes every supported recorder setting, including URLs,
recording controls, browser selection, the optional member label, and the chat
prompt. Configure both journeys in the same file or only the journey being
used.

Both dedicated Playwright configs load `.env.qa-recorder` automatically before
loading their specs. Regular application, build, test, and CI commands do not
load it. Existing shell environment variables take precedence over the file,
which permits one-off overrides without making exports the normal workflow.

Values may be unquoted, single-quoted, or double-quoted. Use one `KEY=value`
entry per line; interpolation is intentionally unsupported so passwords
containing `$` are treated literally.

## Install

The packages already declare `@playwright/test`; the recorder adds no new npm
dependency and does not change either lockfile.

Install normal Control UI dependencies when needed:

```bash
cd control-ui
npm ci
```

Install Chromium into the ignored shared recorder cache:

```bash
npm run qa:recorder:install
```

The download is optional and can be large. It happens only when someone runs
that command. It does not use Playwright's global browser cache.

Install normal Desktop App dependencies when needed:

```bash
cd ../desktop-app
npm ci
```

Do **not** run the Control UI browser-install command for Desktop. The Desktop
recorder launches the Electron dependency already used by the application and
records Electron's embedded Chromium.

### Use an installed Chrome instead

Control UI can use a locally installed Playwright-supported Chrome channel
without downloading recorder Chromium. Set this once in `.env.qa-recorder`:

```dotenv
QA_RECORDER_BROWSER_CHANNEL=chrome
```

Then run `npm run qa:recorder:agent-create` normally from `control-ui/`. Leave
`QA_RECORDER_BROWSER_CHANNEL` empty to use the pinned Chromium installed by
`qa:recorder:install`.

## Runtime prerequisites

These are real end-to-end journeys, not mocked component tests. Before running
them:

- Start or connect to the required Clerum services using the repository's
  normal development workflow.
- Confirm the UI and API URLs used below are healthy.
- Seed the intended local test user and password.
- For Control UI, seed the exact LLM secret named by
  `E2E_AGENT_SECRET_NAME`.
- For Desktop, grant the test user access to the exact agent named by
  `E2E_HOST_REF`.
- Keep required port-forwards alive for the entire run.

The recorder deliberately does not manage those prerequisites. If the target
is a local branch-scoped profile, follow the repository E2E/minikube
instructions in `AGENTS.md`; a browser opening does not prove that a local
cluster is synced to the current worktree.

### Straightforward `example-dev` setup

When the existing GKE dev environment is the intended target, no Docker or
local minikube profile is needed.

Keep the three API port-forwards open in one terminal:

```bash
make gcp-dev-pf-desktop
```

Run the current branch's Control UI against the forwarded dev API in another:

```bash
cd control-ui
CONTROL_API_INTERNAL_URL=http://localhost:8090 npm run dev
```

Then run either recorder command from a third terminal. This tests the current
branch UI/Electron code against the existing dev backend. Use `localhost` for
`CONTROL_UI_URL` when running Next locally; mixing `127.0.0.1` with a
`localhost` dev server can trigger Next's development-origin protection.

Do not also launch `make local-app` or the Desktop portion of `make local-ui`
while recording Desktop. Evenfire enforces a single running Electron instance,
and the recorder needs to own that instance long enough to finalize its video.

## Record Control UI

After configuring `.env.qa-recorder`, run from `control-ui/`:

```bash
npm run qa:recorder:agent-create
```

Local defaults:

```text
CONTROL_UI_URL=http://localhost:3000
CONTROL_API_URL=http://localhost:8090
```

Supported credential names, in priority order:

```text
Username:
  E2E_ADMIN_USER
  ADMIN_USER
  ADMIN_USERNAME

Password:
  E2E_ADMIN_PASSWORD
  ADMIN_PASSWORD
  ADMIN_PASS
  TEST_ADMIN_PASSWORD
```

No password is embedded in the recorder spec.

To record selecting a specific member during agent creation, set:

```dotenv
E2E_AGENT_ACCESS_LABEL=exact-visible-member-label
```

If omitted, the agent is created without a member/team grant and is still
cleaned up after verification.

## Record Desktop App

After configuring `.env.qa-recorder`, run from `desktop-app/`:

```bash
npm run qa:recorder:settings-chat
```

Local defaults:

```text
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:8091
RPC_PROXY_BASE_URL=http://127.0.0.1:8094
```

The email can also be supplied as `TEST_USER_EMAIL`. Password priority is:

```text
E2E_DESKTOP_PASSWORD
E2E_TEST_PASSWORD
ADMIN_PASSWORD
```

There is no personal email, default password, or “first available agent”
fallback in the recorder.

Override the short default prompt when a journey needs specific visible copy:

```dotenv
QA_RECORDER_CHAT_PROMPT="Reply with exactly: optional-recorder-ok"
```

The recorder keeps its runtime-config file and Playwright output under the
ignored run directory. The current Electron application still enforces its
normal process-wide single-instance lock, so close any running Evenfire window
before starting this journey. The real chat backend may retain the sent
conversation according to its normal behavior.

## Locate recordings

From the repository root:

```bash
find .local-notes/qa-recorder/runs -type f -name '*.webm' -print
```

Control UI places its video below:

```text
.local-notes/qa-recorder/runs/control-ui/
```

Desktop prints the final video path as `[qa-recorder] Desktop video: ...` and
stores it below:

```text
.local-notes/qa-recorder/runs/desktop-app/
```

Successful runs also retain PNG screenshots in the corresponding Control UI or
Desktop App run directory.

Videos are not attached a second time to the Playwright result, avoiding the
duplicate WebM produced by the original prototype.

Playwright prepares the configured output directory for each new run. Copy a
recording to another ignored/private location before rerunning if it must be
retained.

## Optional controls

Set these in `.env.qa-recorder`:

| Variable                      | Default                           | Effect                                                      |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `QA_RECORDER_ROOT`            | `<repo>/.local-notes/qa-recorder` | Absolute or working-directory-relative runtime root         |
| `QA_RECORDER_VIDEO`           | `1`                               | Set to `0` to exercise the journey without recording        |
| `QA_RECORDER_SLOW_MO_MS`      | `75`                              | Control UI action delay; use `0` for normal speed           |
| `QA_RECORDER_HEADLESS`        | `0`                               | Control UI only; set to `1` for an invisible diagnostic run |
| `QA_RECORDER_BROWSER_CHANNEL` | unset                             | Control UI browser channel, such as `chrome`                |
| `QA_RECORDER_ALLOW_REMOTE`    | `0`                               | Permit non-loopback targets after explicit review           |

Headful mode and video are defaults for the recorder only. They do not affect
the repository's normal Playwright configs.

## Remote-target guard

Both journeys accept only `localhost`, `127.0.0.1`, or `::1` endpoints by
default. A non-loopback URL fails before launching the journey.

`QA_RECORDER_ALLOW_REMOTE=1` overrides that protection, but it does not bypass
the mutation/chat confirmation flag. Use it only for an explicitly approved
disposable QA environment. Never point these journeys at production.

## Extending the recorder

Keep future recorder work under the same contract:

1. Commit specs, configs, and documentation.
2. Add new private settings to `.env.qa-recorder.example`; never commit the
   populated `.env.qa-recorder`.
3. Put browser binaries, profiles, traces, screenshots, reports, and videos
   under `.local-notes/qa-recorder/`.
4. Add namespaced `qa:recorder:*` commands; do not change existing test
   commands or make recorder installation a lifecycle hook.
5. Match each config narrowly to its recorder spec.
6. Require exact fixture identities instead of choosing the first resource.
7. Require an explicit confirmation variable for writes, messages, or paid
   provider calls.
8. Guard non-local targets.
9. Clean temporary resources with unique names and `finally`.
10. Never add recorder execution to CI by default.

This keeps the recorder useful to QA-focused developers without imposing its
browser download, disk usage, runtime, credentials, or video handling on the
rest of the project.
