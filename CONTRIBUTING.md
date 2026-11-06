# Contributing to evenfire

Thanks for your interest! evenfire is **open source** under the
[Mozilla Public License 2.0](LICENSE) (MPL-2.0) and requires a signed CLA.

## Set up

- **Node.js 24.22.1 or a later Node 24 patch.** `.nvmrc` pins `24.22.1`, most services declare
  `"node": ">=24.22.1"`, `desktop-app` declares `^24.22.1`, and CI reads `.nvmrc`.
- Install dependencies across the repo:

  ```bash
  make install-all
  ```

  This runs `npm install` at the root, then in each directory listed in
  `SERVICES` in the Makefile, in parallel, then in `tests/e2e`. Directories not
  in that list, such as `control-ui`, `gfs-controller` and
  `workspace-files-controller`, need their own `npm install`. The root install's `postinstall` sets
  `git config core.hooksPath .githooks`, so the git hooks below are active from
  then on. `make install-git-hooks` does the same on its own.

## Dev loop (per service)

Each service is a standalone Node/TypeScript package:

```bash
cd <service>            # e.g. mcp-host, channel-reader, control-api
npm install
npm run build
npm test
npx tsc --noEmit
```

`control-api`, `workflow-recipes` and `packages/workflow-sdk` link
`packages/workflow-runtime-core`; run `npm ci && npm run build` there first or
their build fails with "Cannot find module '@clerum/workflow-runtime-core'".

From the repo root:

| Command                | What it does                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `make test-unit-all`   | Checks the local service list against the CI matrix, then runs `npm test` in each service in `TEST_SERVICES`. |
| `npm run format`       | Runs Prettier with `--write` over the projects and root files listed in `scripts/prettier/paths.mjs`.         |
| `npm run format:check` | Same, with `--check`. Use it to see what the pre-commit hook would change.                                    |
| `npm run style-rules`  | Runs the repo's frontend style rules (see [scripts/style-rules](scripts/style-rules/README.md)).              |

To run `mcp-host` on its own without Kubernetes, see
[Single-service dev mode](docs/get-started/dev-mode.md). Dev mode is for
iterating on one service; it is not full platform security.

## Tests are required

PRs must include tests for new behavior and keep `npm test` + `npx tsc --noEmit`
green for every changed service. PRs without tests may be closed.

## Git hooks

`core.hooksPath` is `.githooks`:

- **pre-commit** runs `npm run version:staged`, then `npm run format:staged`,
  then `npm run style-rules:staged`.
  - `version:staged` bumps the patch version in the `package.json` of each
    package (from `packageRoots` in `scripts/prettier/paths.mjs`) whose files
    you staged.
  - `format:staged` runs Prettier on your staged files that fall inside the
    Prettier targets in `scripts/prettier/paths.mjs`.
  - `style-rules:staged` checks staged frontend files against the style rules.
- **commit-msg** runs commitlint with `@commitlint/config-conventional`
  (`commitlint.config.cjs`). Commit messages must follow
  [Conventional Commits](https://www.conventionalcommits.org/), for example
  `fix(mcp-host): ...` or `docs: ...`. Body line length is not limited.

### The pre-commit hook may edit your commit

Two behaviours surprise people:

- **Your commit can gain files you did not stage.** Changing source under
  `external-rest-api/` or `rpc-proxy/` bumps that package's `package.json`
  patch version, and because `external-rest-api/src/releaseManifest.ts`
  declares those versions, the manifest is regenerated and staged to match.
  That is intended: CI rejects a manifest that disagrees with the packages.
  `desktop-app` is deliberately exempt — its version is the release version,
  set only by `scripts/release/prepare-release.mjs`.
- **A commit can be refused while `releaseManifest.ts` has unstaged changes**,
  even if your commit is unrelated to it. The hook will not regenerate a file
  you are mid-edit on. Stage or discard that file and commit again.

Every refusal names the file and the fix. If you need to bypass the hook to
get unstuck, say so in the PR rather than leaving it silent. The two release
validators run in CI and will catch what the hook would have.

## Branches and pull requests

- Name branches with a conventional prefix: `feat/`, `fix/`, `hotfix/`,
  `chore/`, `docs/`, `test/`, `refactor/`, `ci/`, `build/`, `perf/` or
  `revert/`. Do not use agent or vendor prefixes such as `codex/`, `claude/`,
  `openai/` or `anthropic/`.
- Open pull requests against **`dev`**, the integration branch. `main` is the
  release branch; changes reach it when `dev` is promoted.
- CI (`.github/workflows/ci-public.yml`) builds, tests and typechecks every
  service in its matrix on each pull request.

## Desktop App (Electron)

Electron 42 and later do not download the runtime in a `postinstall` script.
`npm ci` installs only the `electron` package; the runtime is downloaded the
first time `require('electron')` resolves. A missing or failed download then
shows up later as a test error that looks like a product bug. For any
`desktop-app` work:

1. Use Node 24.
2. Run `npm ci` **without** `--ignore-scripts` (keytar, esbuild and the macOS
   DMG tooling still build in lifecycle scripts).
3. Run `npm run verify:electron` and confirm it passes before you trust any
   test or build result. It downloads the runtime if it is missing and fails
   unless `electron` resolves to an executable.

If the check reports `Electron failed to install correctly`, switch to Node 24,
delete `desktop-app/node_modules/electron`, rerun `npm ci`, and rerun the
check. Do not point `ELECTRON_OVERRIDE_DIST_PATH` at an unverified binary.

## Validating against a cluster

Unit tests run without Kubernetes. For changes that need the full platform,
use the local Minikube lanes:

- [Minikube T2 runbook](docs/testing/minikube-t2-runbook.md) — the canonical
  `make minikube-t2-preflight`, `make minikube-t2` and
  `make minikube-t2-runtime` entry points.
- [E2E guide](docs/testing/e2e-guide.md) — integration, E2E and Playwright
  suites.

## Documentation

- Public docs describe what `deploy/base` and the Minikube overlays ship. If a
  feature is off by default, say so and name the flag.
- Follow the [claims guardrails](docs/meta/claims-guardrails.md): every claim
  must be backed by code in this repo, with honest caveats.

## What we accept

- Bug fixes and improvements to the platform services and core CRDs.
- New first-class capabilities — please open an issue to discuss first.

## What we do NOT accept as PRs

- New third-party MCP servers or WorkflowRecipes. Publish these to the registry
  (see docs) — they are not merged into this repo. This keeps the core lean and
  maintainable (the same model LangChain and n8n use).

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md)
for private reporting.

## CLA

The project plans to require a signed Contributor License Agreement, and
contributions may be used in the project's commercial / managed editions.

The agreement in [CLA.md](CLA.md) is a draft pending legal review and is not
open for signing yet: no CLA bot runs on pull requests and there is no
signature record. You cannot sign it today. Once it is final, CLA.md will say
how to accept it.
