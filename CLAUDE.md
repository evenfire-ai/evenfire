# Evenfire repository guidance

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
`make minikube-t2-preflight` is a planner, not a lane verdict. A T2 verdict is
produced only by the final exact-head preflight inside `make minikube-t2` (or
`make minikube-t2-runtime` after T0 and T1 are already green on the same HEAD).
`make minikube-pre-gate-sync` alone is not T2. Playwright and product E2E
scripts are separate lanes. T1 judges the JSON reporter (expected files,
executed/passed, zero failures, zero pending); a leftover Vitest process exit
after a complete green reporter is not a failed suite. The single run is
self-healing: the orchestrator planner selects `full-reconcile` for a
bootstrapped profile with an unready deployment (never `PROFILE_UNHEALTHY`
before a transition), T1 restores branch-profile GFS credentials on exit, and
`pre-gate-sync` provisions GFS serving with `GFS_RESTORE_ACTIVE_NOLOGIN=true`
in every plan; do not insert manual repair scripts between runs. Follow the rule
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

A skipped Electron `postinstall` leaves the runtime undownloaded while `npm ci`
still exits successfully, so the failure surfaces later as a test error that
looks like a product bug. No `package.json` field prevents this; the guard is
`npm run verify:electron`, which fails when `require('electron')` does not
resolve to an executable. Desktop validation must use Node 24, run `npm ci`
without `--ignore-scripts`, and pass that check before any test/build result is
counted. If the check reports `Electron failed to install correctly`, switch to
Node 24, repair the generated dependency directory, and rerun the install.
Never bypass the postinstall with `ELECTRON_SKIP_BINARY_DOWNLOAD`, use an
unverified override, or treat the resulting test failure as a product
regression.
