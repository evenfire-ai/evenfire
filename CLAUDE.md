# Evenfire repository guidance

## Shared capability naming

Name shared variables, functions, types, database fields, quota families,
metrics and configuration after the domain or capability they implement.
Do not name shared infrastructure after the AI agent, authoring tool, model
or provider that first introduced it. A shared subscription quota, for
example, uses an administrative subscription name.

Provider names remain appropriate for actual provider-specific adapters,
protocol identifiers and external contracts. Historical data and migration
compatibility identifiers may retain legacy names when the concrete
compatibility requirement is documented. Keep those references confined to
that boundary; do not copy them into new shared runtime names.

## Branch naming

Never create new branches with agent or vendor prefixes such as `codex/*`,
`claude/*`, `openai/*`, `anthropic/*`, `antrophic/*`, or any other Frontier
Labs reference. Use the repository's conventional prefixes instead: `feat/*`,
`fix/*`, `hotfix/*`, `chore/*`, `docs/*`, `test/*`, `refactor/*`, `ci/*`,
`build/*`, `perf/*`, or `revert/*`.

The local Minikube T0/T1/T2 contract is development-only. Follow the
canonical `make minikube-t2-preflight`, `make minikube-t2`, and
`make minikube-t2-runtime` entry points and the ownership, secret-safety, and
evidence rules in `AGENTS.md` and `docs/testing/minikube-t2-runbook.md`.
Hold Control UI / Desktop port-forwards on the host with
`make -f scripts/minikube-profiles/branch.mk branch-profile-pf`
(`AGENTS.md` § Branch-profile UI port-forwards). Do not use
`make minikube-pf-all-bg` as the hold.
`make minikube-t2-preflight` is a planner, not a lane verdict. A T2 verdict is
produced only by the final exact-head preflight inside `make minikube-t2` (or
`make minikube-t2-runtime` after T0 and T1 are already green on the same HEAD).
`make minikube-pre-gate-sync` alone is not T2. Playwright and product E2E
scripts are separate lanes. T1 requires both a complete green JSON reporter
(expected files, executed/passed, zero failures, zero pending) and a zero
Vitest process exit; a green reporter cannot hide teardown, worker, OOM, or
signal failure. The single run is
self-healing: the orchestrator planner selects `full-reconcile` for a
bootstrapped profile with an unready deployment (never `PROFILE_UNHEALTHY`
before a transition), T1 restores branch-profile GFS credentials on exit, and
`pre-gate-sync` provisions GFS serving with `GFS_RESTORE_ACTIVE_NOLOGIN=true`
and `GFS_RECOVER_ABANDONED_STATE=true` only in the `minikube-t2` transition;
other security gates refresh MCP auth without mutating GFS. Do not insert
manual repair scripts between runs. Harness GFS reconciles settle Ready-reader
leftovers first (`settle-gfs-reader-rollout.sh`) and judge reader rollout
completion by readiness via the `gfs-rollout-shim` PATH prefix, because
HCC's gfsReconciler now preserves the `restartedAt` annotation, and the
harness still judges reader readiness via the shim so leftover ReplicaSets
cannot turn a generation-based `kubectl rollout status` into a timeout.
Follow the rule
`.cursor/rules/minikube-t0-t1-t2.mdc` and the skill
`.cursor/skills/minikube-t0-t1-t2/SKILL.md` for the certification workflow.

## Logging standard

For production Node.js/runtime code, use structured logging. Pino is the
repository reference implementation because `control-api` uses a redacting
root logger and `workspace-files-controller` uses Pino/Pino HTTP; Winston is
not a repository dependency. Services with an existing structured wrapper
(`mcp-host`, HCC, workflow recipes, and the workflow approval reader) should
continue using that wrapper rather than bypassing it.

When editing a file, replace its direct `console.*` calls with the existing
service logger, preserve levels/context/redaction, and keep the change scoped
to that file plus minimal support. Do not start a repository-wide logging
migration or add a second logger convention. Direct console output is reserved
for logger adapters, explicit CLI/bootstrap output, tests, E2E/fixtures, and
intentional development diagnostics; never emit secrets, tokens, credentials,
DSNs, private URLs, or raw request/response bodies.

## Desktop Electron runtime

Electron 42 and later download the runtime when the package is first resolved,
not during `postinstall`. `npm ci` can therefore succeed before the runtime is
materialized. `npm run verify:electron` resolves Electron and materializes the
runtime in an unbounded setup phase; `npm run verify:electron -- --check-only`
checks that an earlier setup phase already materialized it without triggering a
download. Desktop validation must use Node 24, which is the CI and runtime
contract. Do not install `desktop-app` with `--ignore-scripts`, and do not count a
Desktop test/build result until these checks succeed from `desktop-app`:

```bash
node --version  # must report v24.x
npm run verify:electron
```

If runtime resolution fails, the dependency install or download is incomplete,
not a product failure. Stop the gate, switch to Node 24, remove only the
generated `desktop-app/node_modules/electron` directory, rerun `npm ci`, then
run `npm run verify:electron` without `--check-only` in an unbounded setup phase
and rerun the checks. Do not set
`ELECTRON_SKIP_BINARY_DOWNLOAD`, point
`ELECTRON_OVERRIDE_DIST_PATH` at an unverified binary, or report green evidence
from a missing runtime. A verified local cache may be used only when its
version and checksum are recorded in the run evidence.

## Before every push

Agent-authored PRs between 2026-09-19 and 2026-11-18 failed the same CI gates
and drew the same review findings again and again. The checks below catch
those repeats locally, without a cluster. Run them before every push,
including the push after a merge of `dev`.

### 1. Cheap CI gates

CI runs these on the PR merge result, so run them on a head that contains
`origin/dev`:

```bash
git fetch origin dev
git merge-base --is-ancestor origin/dev HEAD || echo "merge origin/dev first (merge, never rebase)"
```

Then:

```bash
bash scripts/tests/test-minikube-t2-public-boundary.sh
git ls-files -s '*.sh' | awk '$1 != "100755" {print $4}'
node scripts/release/validate-release-version-bumps.mjs --previous origin/dev --all-services
bash scripts/ci/check-no-infra-identifiers.sh
(cd control-api && node ../scripts/ci/password-recovery-suite-contract.mjs verify)
```

- `PUBLIC_BOUNDARY_REJECTED` (40 agent PRs, e.g. #766, #806, #932, #1111,
  #1231): the diff adds a credential assignment, a loopback or private URL
  with a port, a PostgreSQL URL, a bearer token or a private key, almost
  always in a test fixture. A credential assignment passes only when its
  value is built at runtime (contains `$`) or names itself as synthetic
  (contains `fixture`, `placeholder`, `fake`, `example`, `dummy` or
  `test-token`). Build loopback, private and PostgreSQL URLs at runtime from
  config instead of writing them as literals. Never widen the scanner's
  patterns or exemptions.
- The `awk` line prints a path (12 agent PRs, e.g. #739, #1111, #1243, #1336):
  run `git update-index --chmod=+x <path>`.
- `code changed but <pkg>/package.json stayed at <version>` (11 agent PRs,
  e.g. #796, #932, #1231, #1450): bump that package above the version on
  `dev`.
- `PostgreSQL suite census differs from exact manifest` (12 agent PRs, e.g.
  #1193, #1231, #1285, #1498): every `control-api/test/**/*realPostgres*.test.ts`
  added, renamed or removed is listed in
  `tests/contracts/password-recovery-suites.json` in the same commit.
- Run each added or changed shell script and shell test under `/bin/bash`
  (3.2) and under bash 5 (#1305: a check failed only under `/bin/bash`; #1336: `mapfile: command
  not found`).

### 2. Text the change made false

The most repeated review finding (64 agent PRs, e.g. #702, #806, #1231, #1453,
#1498) is a comment, doc, test title or PR body that still describes the code
before the change. When a commit removes or renames a file, symbol, flag, env
var, error code or test, or changes behaviour that text describes:

```bash
git diff --name-status origin/dev...HEAD
git grep -n '<each removed or renamed name>'
```

Fix every hit in code comments, `*.md`, `docs/`, `.d.ts` files, test titles
and the PR body in the same push. Head SHAs, commit counts and test counts in
the PR body describe the head being pushed (`git log --oneline
origin/dev..HEAD`) or name the head they refer to. When code is removed, also
delete the helpers that only it called (`git grep -n '<helper>'`; orphans in
12 agent PRs, e.g. #702, #726, #1451).

### 3. Every caller of the thing you fixed

A fix to a guard, validation, limit, error mapping or shared helper that
reaches one call site while a sibling keeps the defect was found in 30 agent
PRs (e.g. #701, #726, #1483, #1510). Before committing such a fix, run
`git grep -n '<function, route or constant>'` and list each caller in the
commit body as "fixed" or "not affected: <reason>".

### 4. Fixing review findings

Fix commits pushed between review rounds broke behaviour the round had not
flagged in 26 agent PRs (e.g. #796, #806, #1305, #1454). Fix one finding per
commit and name the finding in the subject. Before the push:

```bash
git diff <reviewed-head> HEAD -- '*.test.*' '*.spec.*' 'scripts/tests/test-*.sh' | grep -E '^-.*(expect|assert)'
```

Each removed or rewritten assertion maps to a finding; restore any other.
Then run the test files of the reviewed head against the new code.

### 5. A new test must fail without the fix

Tests that pass with or without the change they claim to prove were found in
65 agent PRs (e.g. #697, #726, #1499, #1502). For every test that proves a fix:

```bash
git status --porcelain   # must be empty: commit the fix and the test first
git checkout origin/dev -- <production files the fix changes>
<run the new test>   # it must FAIL
git checkout HEAD -- <production files the fix changes>
```

A production file the fix adds does not exist on `origin/dev`: delete it for
the run instead, and restore it with the same last command. A test that still
passes proves nothing; fix the test. A negative assertion
(`not.toHaveBeenCalled`, "nothing was written") needs a positive assertion in
the same test that the code path ran. A fixture that stands for another
component's payload is copied from that component's real output or its own
fixtures, not written by hand.

### 6. Errors stay visible

Swallowed errors and silent fallbacks were flagged in 17 agent PRs (e.g.
#806, #1453, #1500). The flagged shapes were `.catch(() => ({}))`, a failed
read that builds a default value, and a parser that returns a default on
invalid input. Before pushing, read every `catch`, `.catch(` and default value
your diff adds: each one rethrows, logs through the service logger, or has a
comment saying why dropping the error is correct.
