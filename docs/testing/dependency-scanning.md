# Dependency scanning in CI

CI runs three dependency checks on every pull request. They are defined in
`.github/workflows/ci-public.yml` and the scripts under `scripts/ci/`.

| Job                                        | What it scans                                                          | Fails on                                                                                      | Accepted findings                            |
| ------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `dependency-audit`                         | Every committed `package-lock.json` (`npm audit --omit=dev`)           | A high/critical advisory not in the baseline, an expired entry, or an entry that is now fixed | `scripts/ci/dependency-audit-baseline.json`  |
| `next-app-supply-chain` (bundled React)    | The React copy inside `next`, after `npm ci` and in the runtime image  | A Next.js app ships a `next` without the fix for an advisory in the advisory table            | None: fix it by upgrading `next`             |
| `next-app-supply-chain` (Trivy image scan) | The built `control-ui` and `profile-ui` images (OS and `node_modules`) | A HIGH/CRITICAL finding not in the ignore file, or an expired ignore entry                    | `scripts/ci/next-app-image.trivyignore.yaml` |

## The bundled-React gap

The Next.js App Router does not run the app's own `react` dependency. It runs
the React build compiled into the `next` package:
`node_modules/next/dist/compiled/react`, `react-dom`,
`react-server-dom-webpack`, `react-server-dom-turbopack`, and the prebundled
`next-server/app-page*.runtime.*.js`.

No lockfile mentions that copy. `npm audit`, Dependabot and lockfile-based
OSV scans only see `next@<version>`, so they only report advisories filed
against `next` itself. A React advisory, such as the React Server Components
RCE CVE-2026-126187 ([#1430](https://github.com/evenfire-ai/evenfire/issues/1430)),
can reach production without any of them flagging it. The bundled
`package.json` files carry no `version` field, so image scanners such as Trivy
cannot match them either: Trivy reported the Next.js advisories on the
`next@16.3.5` image but not CVE-2026-126187.

The version string cannot decide whether a build is fixed. `next@16.4.0` and
`next@16.4.6` both bundle React `19.3.0-canary-278794d7-20261002`, but only
16.4.6 carries the fix, because Next.js backports React fixes into canary builds
without changing the version string. For that reason
`scripts/ci/check-next-bundled-react.mjs` checks for a fix marker: a string
that the React fix introduced. It requires the marker in every React Server
Components server build and every `app-page` runtime that `next` ships. If a
listed file pattern matches nothing (for example after a `next` layout change),
the check fails closed. Stable React versions can also be checked by version
alone. A canary version with no marker fails as unverifiable.

To check an app locally after `npm ci`:

```bash
node scripts/ci/check-next-bundled-react.mjs control-ui profile-ui
```

## When a new React advisory is published

1. Add an entry to `scripts/ci/next-bundled-react-advisories.json` with the
   fixed React versions. Where the fixed `next` still bundles a canary, also add
   a `fixMarker` (a string the fix adds, such as a new error message) and the
   `markerFiles` patterns to check.
2. Confirm it against the published `next` releases (`npm pack next@<version>`):
   the check must fail on a release without the fix and pass on one with it.
3. Upgrade `next` in `control-ui` and `profile-ui`.

## When `dependency-audit` fails

- **New finding:** upgrade the dependency, or add an `overrides` entry. If it
  cannot be fixed in the same pull request, add a baseline entry with a
  tracking issue and an expiry date. To regenerate the baseline, run the
  command below. It keeps the tracking and expiry of existing entries, and
  stamps new entries with the values you pass:

  ```bash
  node scripts/ci/audit-lockfiles.mjs --update-baseline --tracking <issue-url> --expires YYYY-MM-DD
  ```

- **Stale entry:** the advisory no longer applies. Remove the entry.
- **Expired entry:** fix the finding, or extend the entry with a reason in the
  pull request.

Advisories are published continuously, so a new advisory can fail a pull
request that did not change any dependency. Handle it like any other new
finding.

## When the Trivy image scan fails

Fix the finding, or add an entry to `scripts/ci/next-app-image.trivyignore.yaml`
scoped to the exact package `paths` in the image, with `expired_at` and a
`statement`. The current entries cover:

- the npm CLI bundled in the `node` base image;
- devDependencies (`vite`, `undici` via `jsdom`) that the runtime stage copies
  with the full `npm ci` tree;
- `sharp` and `source-map-js`, also accepted in the lockfile baseline.

Pruning devDependencies from the runtime stage would clear the second group.
