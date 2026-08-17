# Evenfire repository guidance

## Branch naming

Never create new branches with agent or vendor prefixes such as `codex/*`,
`claude/*`, `openai/*`, `anthropic/*`, `antrophic/*`, or any other Frontier
Labs reference. Use the repository's conventional prefixes instead: `feat/*`,
`fix/*`, `hotfix/*`, `chore/*`, `docs/*`, `test/*`, `refactor/*`, `ci/*`,
`build/*`, `perf/*`, or `revert/*`.

The local Minikube T0/T1/T2 contract is development-only. Follow the
canonical `make minikube-t2-preflight` and `make minikube-t2` entry points and
the ownership, secret-safety, and evidence rules in `AGENTS.md`.

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

Node 24 uses npm 11, whose install-script approval model can leave Electron
without its downloaded runtime while `npm ci` still exits successfully. The
pinned Electron package is explicitly approved in `desktop-app/package.json`.
Desktop validation must use Node 24 (Node 26 is not a supported validation
runtime), run `npm ci` without `--ignore-scripts`, and verify
`require('electron')` resolves to an executable before any test/build result is
counted. If the check reports `Electron failed to install correctly`, switch to
Node 24, repair the generated dependency directory, and rerun the install;
never bypass the postinstall with `ELECTRON_SKIP_BINARY_DOWNLOAD`, use an
unverified override, or treat the resulting test failure as a product
regression.
