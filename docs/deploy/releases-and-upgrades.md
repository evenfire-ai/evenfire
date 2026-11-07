# Releases and upgrades

How evenfire is versioned and released, how to run a specific release, and what
to read before you upgrade.

## Version numbers

evenfire uses two kinds of version number. They mean different things.

| Version                     | Where it lives                                                                                  | What it means                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Release** `vX.Y.Z`        | Git tag, image tag `ghcr.io/evenfire-ai/<image>:vX.Y.Z`                                         | The repository release. Released images, the Desktop App, and the ghcr image pin all carry this one number.                                     |
| **Desktop App** `X.Y.Z`     | `desktop-app/package.json`                                                                      | Always equal to the release version. Only the release script writes it.                                                                         |
| **Service counter** `0.1.N` | `version` in each service's `package.json` (`external-rest-api`, `rpc-proxy`, `control-api`, …) | A per-service change counter. The pre-commit hook bumps the patch number on every commit that touches that service. It is not a release number. |

So `v0.10.0` is a release, and `external-rest-api` `0.1.100` only means that
service has changed about a hundred times. Do not compare service counters
across services, and do not use them to pick a release.

### How service counters are bumped

The tracked pre-commit hook (`.githooks/pre-commit`) runs
`npm run version:staged`. For every package root that has staged changes and
whose `package.json` version still equals `HEAD`, it raises the patch number by
one and stages `package.json` and `package-lock.json`. Run
`make install-git-hooks` (or `npm run install-git-hooks`) once to enable the
hook.

Two counters are also published to clients. `external-rest-api/src/releaseManifest.ts`
declares `externalRestApiVersion` and `rpcProxyVersion`, so the hook regenerates
and stages that file when either package is bumped. CI checks both rules on
every pull request:

- `update-desktop-release-manifest.mjs --validate-only` fails if the manifest
  disagrees with the package versions.
- `validate-release-version-bumps.mjs` fails if `src/`, `test/` or `tsconfig.json`
  under `external-rest-api/` or `rpc-proxy/`, or the `packages/jwt-key-policy/` they
  both ship, changed but that package's version did not. Bump that package's version
  to fix it.

On pull requests into `dev`, the required check `Repo hygiene (no internal working
artifacts)` runs the same script with `--all-services` against the merge result.
`dev` requires branches to be up to date, so that result contains `dev`'s tip. A
version line that merged cleanly into the same number on both sides fails, and so
does a version below the base; the hook bumps only a version equal to `HEAD`, so
set a lower one above the base by hand. A service the base does not have yet passes,
so one pull request can add or rename a service and list it.

The check covers `channel-reader`, `control-api`, `control-ui`, `external-rest-api`,
`host-context-controller`, `mcp-host`, `mcp-proxy`, `mcp-servers/doc-generator`,
`mcp-servers/web-search`, `profile-ui`, `rpc-proxy`, `stdio-bridge` and
`workflow-recipes`. Like the hook, it looks at every file under a service's directory,
and at `packages/jwt-key-policy/` for the three services that declare it (`control-api`,
`external-rest-api`, `rpc-proxy`), and it leaves out
`external-rest-api/src/releaseManifest.ts`, which the release script writes. Unlike the
hook, it counts both sides of a rename, so a file moved out of a service with nothing
else changed there fails the check with no hook bump: set that service's version by
hand. It also leaves out what a running service does not load: test code (`test/`,
`tests/` and `e2e/` at the service's root, `__tests__/`, JavaScript and TypeScript files
named `*.test.*` or `*.spec.*`, `*.testFixtures.ts`), Markdown, the dev-only files
`Makefile`, `makefile`, `vitest.config.*` and `.env.example` at the service's root, and
`scripts/` in `control-api`, `mcp-host` and `workflow-recipes`. The same names lower down
still count, and so does `scripts/` in any other service. `channel-reader` and
`external-rest-api` compile the test files under `src/` into `dist/`, so for those two one
version can name two `dist/` trees that differ only in test modules no production module
imports.

It covers nothing else, so a change elsewhere can still leave one version on two
trees: services the hook does not bump (`workflow-approval-request-reader`,
`gfs-controller`, `workspace-files-controller`, `webhook-gateway`, `webhook-proxy`,
`codex-llm-proxy`, `grok-llm-proxy`), images with no `package.json`
(`nginx-egress-proxy`, `hooks/reference-guardrail-hook`), `packages/**` other than
`packages/jwt-key-policy/`, and `mcp-servers/` outside the two services above. A pull
request retargeted to `dev` after its last push also has no run of the check, because
GitHub starts no run when the base changes: close and reopen it, or push a commit.

**A revert fails this check on purpose.** `git revert` and GitHub's Revert button run
no hook, so a revert lowers every version it touches and the check reports `went down`.
The next hook bump would otherwise issue a number that already named the reverted code.
In the revert pull request, set each package the error names above the base's version:

```bash
(cd <service> && npm version --no-git-tag-version --ignore-scripts <version above the base>)
git add <service>/package.json <service>/package-lock.json
git commit -m "chore: set versions above the base after the revert"
```

**If the check itself is wrong**, fix it in the pull request that needs it. The check
runs from the merge result, workflow and script included, so a corrected
`validate-release-version-bumps.mjs` and its test apply to that pull request's own run.
When an incident leaves no time for that, remove the check's two steps from the
`repo-hygiene` job in that pull request and restore them in the next one; the other
required checks and the approval still apply. Removing only the first step turns the
second one red, and removing or renaming the job leaves the required status missing, so
that pull request cannot merge until the ruleset changes.

`desktop-app` is not a hook package root, so the hook never bumps it. See
[CONTRIBUTING.md](../../CONTRIBUTING.md#the-pre-commit-hook-may-edit-your-commit)
for what the hook does to your commits.

## How a release is made

Images are built by `build-publish.yml`: automatically on every push to `dev`,
or when a maintainer runs that workflow by hand (`workflow_dispatch`, optionally
with `build_all`). A release never rebuilds them. It copies images that were
already built to the release tag.

```text
push to dev ──► build-publish.yml ──► ghcr.io/evenfire-ai/<image>:sha-<7> and :latest
                                       (multi-arch: linux/amd64 + linux/arm64)

prepare-release.mjs ──► release-prep commit ──► tag vX.Y.Z
                                                   │
                                                   ▼
                                     release-images.yml ──► :vX.Y.Z (and :stable)
```

1. **Continuous builds.** On every push to `dev`,
   [`build-publish.yml`](../../.github/workflows/build-publish.yml) rebuilds only
   the images whose source paths changed. Each image is built natively for
   `linux/amd64` and `linux/arm64` and merged into one manifest list tagged
   `sha-<7 chars>` and `latest`. The manifest list records the commit it was
   built from in the `org.opencontainers.image.revision` annotation. Pushes to
   `main` do not build images.
2. **Cut the release.** A maintainer runs:

   ```bash
   node scripts/release/prepare-release.mjs --version X.Y.Z --release-id vX.Y.Z \
     [--minimum-desktop-version A.B.C]
   ```

   It refuses a version that is not greater than the last committed Desktop App
   version. It writes every release coordinate (listed in
   [`release-coordinates.mjs`](../../scripts/release/release-coordinates.mjs)):

   | Coordinate                                                   | Rule                                                                               |
   | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
   | `desktop-app/package.json` and `package-lock.json`           | Equals `X.Y.Z`                                                                     |
   | `releaseManifest.desktopVersion`                             | Equals `X.Y.Z`                                                                     |
   | `releaseManifest.releaseId`                                  | Set explicitly (never `local`)                                                     |
   | `releaseManifest.minimumDesktopVersion`                      | A floor, at most `X.Y.Z`. Changes only when `--minimum-desktop-version` is passed. |
   | `releaseManifest.externalRestApiVersion` / `rpcProxyVersion` | Equal their own `package.json` counters                                            |
   | `newTag` of every row in `deploy/components/ghcr-images`     | Equals `vX.Y.Z`                                                                    |

   `node scripts/release/validate-release-tag.mjs --version X.Y.Z` checks that
   all coordinates agree. It does not check that the images exist, because they
   are only created when the tag is pushed.

3. **Tag.** Pushing a `v*` tag to `evenfire-ai/evenfire` starts
   [`release-images.yml`](../../.github/workflows/release-images.yml). For each
   published image in [`deploy/images.json`](../../deploy/images.json),
   [`resolve-release-images.mjs`](../../scripts/release/resolve-release-images.mjs)
   resolves `:latest` to a digest once, then refuses the image if:
   - it has no revision annotation;
   - the revision it was built from is not an ancestor of the tagged commit;
   - its source paths changed between that revision and the tagged commit.

   [`promote-release-images.sh`](../../scripts/release/promote-release-images.sh)
   then checks that the digest is a manifest list with both `amd64` and `arm64`,
   and copies it (with `crane copy`) to `:vX.Y.Z`. For a strict `vX.Y.Z` tag it
   also copies it to `:stable`. If any image is refused, the job fails, but the
   other images are still copied, so a failed run can leave a partial release.
   A manual
   `workflow_dispatch` run is a dry run: it prints what it would promote and
   copies nothing.

The hosted evenfire service deploys from these same images through a separate,
private pipeline. That pipeline is not part of this repository.

### What is fixed and what moves

| Tag                   | Moves?                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `:latest`, `:sha-<7>` | `:latest` moves on every `dev` build of that image. `:sha-<7>` names one build.                    |
| `:vX.Y.Z`             | Written by the release workflow for that tag. Nothing in normal operation rewrites it.             |
| `:stable`             | Moves to whichever strict `vX.Y.Z` tag was promoted last (a patch to an older line moves it back). |
| `@sha256:…` digest    | Never moves. Use a digest when you need a byte-for-byte guarantee.                                 |

The release workflow has no guard that stops a second run from writing
`:vX.Y.Z` again. If you need an image that cannot change, pin the digest.

## Run a specific release

### Minikube

`make minikube-setup` pulls images from `ghcr.io/evenfire-ai` by default
(`IMAGE_SOURCE=ghcr`). The `minikube-ghcr` and `minikube-no-uis-ghcr` overlays
add the [`ghcr-images`](../../deploy/components/ghcr-images/kustomization.yaml)
component. It rewrites the 25 images that are both published and deployed to
minikube from their local `clerum/<name>` refs to
`ghcr.io/evenfire-ai/<name>:vX.Y.Z`. It also rewrites image refs inside
Deployment env values, such as the images HCC uses to start child pods.

To run a release, check out its tag and run setup:

```bash
git checkout vX.Y.Z
make minikube-setup
```

`MINIKUBE_IMAGE_TAG` overrides the pinned tag for one run. It edits a temporary
copy of the deploy tree, never the committed file:

```bash
MINIKUBE_IMAGE_TAG=latest make minikube-setup   # newest dev builds
MINIKUBE_IMAGE_TAG=v0.9.0 make minikube-setup   # an older release
```

On a branch where the release-prep commit has landed but the tag has not been
promoted yet, the pin names images that do not exist yet. In that window,
re-run with `MINIKUBE_IMAGE_TAG=latest`, as
[the quickstart](../get-started/quickstart.md) explains.
To build every image from source instead, use `make minikube-setup-local`.
See [minikube.md](minikube.md) for the full setup.

### Your own cluster

[`deploy/base`](../../deploy/base) refers to images by local `clerum/<name>`
names. To run published images, rewrite them in your own kustomize overlay:

- include `deploy/components/ghcr-images` as a component, which pins the 25
  minikube-deployed images to the release tag of the commit you check out; or
- write your own `images:` block with `newName: ghcr.io/evenfire-ai/<name>` and
  a `digest:` per image.

Do not deploy `:latest` or `:stable` to a cluster you care about. Every image
in a cluster should come from the same release.
[`deploy/images.json`](../../deploy/images.json) lists every image, whether it
is published (`published`), and whether minikube deploys it
(`deployed_to_minikube`). Images such as `mcp-host-desktop`,
`clerum-workflow-base`, and `playwright-server` are published but are not in
the component.

The CRD Helm chart ([`charts/clerum-crds`](../../charts/clerum-crds)) has its
own chart version. It does not follow the release number. Always apply the CRDs
from the same checkout as your images.

## Desktop App versions

The Desktop App version is the release version, and its GitHub release tag is
the same `vX.Y.Z` tag. There is no separate `desktop-app-<version>` tag.

The External REST API serves `GET /api/v1/desktop/release` (authenticated). It returns
the values in `releaseManifest.ts` plus `releaseTag` (`v<desktopVersion>`) and
`releaseUrl`. `releaseUrl` is built from `EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL`,
which defaults to `https://github.com/evenfire-ai/evenfire/releases`. Point it
at your own releases page if you ship your own builds.

When the installed app is older than `minimumDesktopVersion`, the app shows
**Desktop update required** and links to `releaseUrl`. See
[Use the Desktop App](../how-to/use-the-desktop-app.md).

No workflow in this repository builds or signs Desktop App installers. To build
one yourself, use the Electron Forge scripts in `desktop-app/package.json`
(`make:mac:arm64`, `make:mac:x64`, `make:windows:x64`, `make:windows:arm64`,
`make:linux:x64`, `make:linux:arm64`) with Node 24, after `npm ci` and
`npm run verify:electron`.

## Upgrade notes

Read the notes for every release you skip over, not only the target release.

### General order

1. **Back up the database** (`control-postgres`) before any upgrade.
2. **Apply the CRDs first.**

   ```bash
   KCTX=<your-context>   # the cluster you are upgrading; never rely on the current context
   kubectl --context "$KCTX" apply -f ./charts/clerum-crds/crds/
   ```

   `helm upgrade` does not update files in a chart's `crds/` directory, so you
   must apply them yourself. The order matters: the API server drops fields
   that the installed CRD schema does not know, without an error. If new
   `control-api` or `mcp-host` pods write a new field (for example
   `spec.guardrails` or `spec.llmPolicy` on a Host) while the old CRD is still
   installed, that field is silently lost. The `ROLLOUT ORDER — CRD FIRST`
   comments in
   [`charts/clerum-crds/crds/host.yaml`](../../charts/clerum-crds/crds/host.yaml)
   mark these fields. See also the [CRD reference](../crds/README.md).

3. **Then roll out the images** for the new release, all from the same tag.
4. **Follow any feature-specific runbook** below.

### Feature-specific notes

| Note                                                                               | Read it when                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Workflow output PVC upgrade](workflow-output-pvc-upgrade.md)                      | You use WorkflowRecipes with `spec.output.destination: pvc`. The default PVC is now one per parent recipe.                                 |
| [Plugin Workload SDK upgrade and policy migration](plugin-workload-sdk-upgrade.md) | You use the Plugin Workload SDK. It has a required order with the SDK turned off during the upgrade.                                       |
| [GFS permission-store credential lifecycle](gfs-permission-store.md)               | You run the Global File System. It covers provisioning, rotating, and recovering the `gfs_controller` credential.                          |
| [Host PVC layout upgrade](host-pvc-layout-upgrade.md)                              | You upgrade from v0.10.x or v0.11.x and have created stateless Hosts. Run the inventory before the upgrade.                                |
| [Snippet runner Node permissions](#snippet-runner-node-permissions)                | You run workflow snippets with your own runner image (`CLERUM_SNIPPET_RUNNER_IMAGE`). It must run Node 24.x; Node 25+ blocks its network.  |
| [rpc-proxy default changes](#rpc-proxy-default-changes)                            | You run rpc-proxy from a ConfigMap without `RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS`, or you set a status or activity stream cap.           |
| [Changed code defaults](#changed-code-defaults-first-release-after-v0120)          | You run HCC, WRC, control-api or the approval reader with a variable unset. The pull Secret change restarts Host pods once; plan a window. |
| [LLM catalog seed retirement](llm-catalog-seed-retirement-upgrade.md)              | You upgrade across migration `0135_llm_retire_seeded_catalog`, use `cost` budgets, or install fresh. Review the kept placeholder prices.  |

#### Snippet runner Node permissions

The workflow snippet runner starts each snippet worker under the Node permission
model with the `--permission` flag. Node 24 accepts only this flag name and
rejects the earlier `--experimental-permission`. Each path has its own grant: a
worker can read the runner's `dist/` and `node_modules/` directories, and can
write to the workflow output directory but not read it. Other workloads share
the output volume, and Node follows a symlink inside a granted directory, so a
read grant would let a snippet read the target of a link placed there.

On earlier releases the snippet worker ran without the Node permission model
(the old `--experimental-permission` flag was rejected and the runner continued
without it), so an `ERR_ACCESS_DENIED` after this release comes from the
sandbox now being enforced.

At startup the runner checks that its Node runtime provides the permission
model. If it does not, the runner exits with an error and its Pod does not
become Ready.

`CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS` is removed. The workflow-recipes
controller never passed it to snippet-runner Pods: it passes them only an
allowlisted set of environment variables, and this variable is not in that set.

No action is needed when you use the runner image built from this repository:
the repository images use Node 24. If `CLERUM_SNIPPET_RUNNER_IMAGE` points at
your own image, run Node 24.x: `workflow-recipes` declares Node `>=24.22.1` and
is tested only on Node 24. On Node 25 and later the runner starts, but snippet
workers cannot open network connections, because those releases also restrict
network access under `--permission`, and the runner does not pass `--allow-net`
(Node 24 rejects that flag). On a runtime that rejects `--permission` (Node older
than 22.13.0, or a 23.x release older than 23.5.0) the startup check fails and
the runner exits.

### Changed code defaults (first release after v0.12.0)

These defaults apply only where a variable is unset. Check the env of your
Deployments against each item before you upgrade.

- **Host and workspace-files-controller pull Secret (HCC).** `CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET` and `CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET` now default to empty (no `imagePullSecrets`) instead of `clerum`. If neither variable is set on your HCC Deployment, as in installs that use `deploy/base` without an overlay, the first reconcile after the upgrade removes `imagePullSecrets: [{name: clerum}]` from every Host and workspace-files-controller Deployment. Both use the `Recreate` strategy, so every running Host pod and every workspace-files-controller pod restarts once; suspended Hosts stay suspended, and a Host whose suspension is blocked changes when the hold ends. Upgrade HCC in a maintenance window. If you rely on a pull Secret named `clerum`, set both variables to `clerum` on HCC before the upgrade, and before the [Host PVC layout](host-pvc-layout-upgrade.md#before-the-upgrade) `inventory` if you run it: the pod templates then stay identical and nothing restarts. Overlays that set both variables, including to `""` as the minikube overlay does, are unaffected.
- **Host workspace StorageClass (HCC).** `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` no longer defaults to `do-block-storage-retain`. When it is unset, new Host workspace PVCs omit `storageClassName` and get your cluster's default StorageClass and its reclaim policy. If you relied on the old default on DigitalOcean, set the variable to `do-block-storage-retain` on HCC before the upgrade to keep that class. Existing PVCs keep their StorageClass: HCC does not update a bound PVC, and when it updates an unbound one with the variable unset it carries over the class already set, because Kubernetes does not allow changing it. A Host workspace PVC that stayed `Pending` because your cluster has no `do-block-storage-retain` class therefore keeps that class; delete it, and HCC creates it again with the default class on its next reconcile. HCC deletes a Host's workspace PVC when you delete the Host, so with a default class whose reclaim policy is `Delete` the workspace volume and its data are deleted with it; the old default `do-block-storage-retain` kept the volume.
- **External-egress window (HCC, WRC).** `HCC_EXTERNAL_EGRESS_OVERLAP_SEC` and `WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS` now default to `3600` (was `300`), and `WRC_EXTERNAL_EGRESS_MAX_ENTRIES` to `256` (was `128`). The overlap window keeps each resolved IP of an allowed hostname in the egress NetworkPolicy after its DNS TTL. An IP that a provider rotates out of DNS stays allowed for at most that hour and for about half of it at least, because HCC and WRC write a renewed window only when less than half of it is left; size long-lived connections on the half hour. The entry cap bounds how many IPs one policy keeps. While DNS lookups for that hostname fail with a transient error such as a timeout or `SERVFAIL`, HCC and WRC keep the IPs they already have beyond that hour (fail-static) until a lookup succeeds or the hostname is removed from the declaration; when the resolver answers that the hostname has no records (`ENOTFOUND`, `ENODATA`), HCC and WRC remove its IPs on the next pass, without waiting for that hour. This release's `deploy/base` also sets all three explicitly, so an install that uses it carries these values instead of relying on the code default. The minikube overlays keep `WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS` at `300`, because the WRC egress degradation E2E bounds its recovery wait by that window. Overlays that patch these `env` entries by name keep their values. A value supplied through `envFrom` (a ConfigMap or Secret) no longer applies, because `deploy/base` now declares the entries explicitly and an `env` entry takes precedence over `envFrom`: patch the `env` entries instead. To keep the old behaviour, set them to `300` and `128`.
- **Defaults that `deploy/base` already sets.** An install that uses `deploy/base` sees no change; a Deployment from which you removed one of these variables gets the new value. `CONTEXT_MAPPER_RUNTIME_NAMESPACES` defaults to `mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui` (was `mcp-server,mcp-host,sandbox-recipes,rpc-proxy`, so `mcp-host` drops out) and `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES` to `sandbox-ui` (was empty, which gave every runtime namespace the full infrastructure set). HCC does not delete NetworkPolicies it wrote before. If you listed `sandbox-ui` in `CONTEXT_MAPPER_RUNTIME_NAMESPACES` and left `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES` unset, `allow-hcc-api-egress-sandbox-ui` and `allow-k8s-api-egress-sandbox-ui` stay after the upgrade and are no longer reconciled. To reach the DNS-only set, delete them if they carry the label `clerum.io/managed-by=host-context-controller`. If you relied on the old runtime default, the HCC-labelled policies in `mcp-host` also stay; keep `deny-all-mcp-host` unless another deny-all covers that namespace (`deploy/base/mcp-host/networkpolicies.yaml` ships one). With the new runtime default HCC also manages `sandbox-ui`. It needs that namespace and HCC's Role and RoleBinding there (`deploy/base/sandbox-ui/`), or HCC fails its startup NetworkPolicy pass. `deploy/scripts/np-enforce-preflight.sh` reads either variable, when your overlay leaves it unset, as the new default whichever HCC is running: if your overlay leaves one unset, upgrade HCC before you run the preflight, because an older HCC still manages `mcp-host` and gives a listed `sandbox-ui` the Kubernetes API policy. `WORKFLOW_APPROVAL_MAX_TTL_SEC` defaults to `172800` (was `604800`); where it is unset, a workflow approval step with `timeoutSeconds` above `172800` now fails when the step starts, with `Approval request failed (400)`. `WORKFLOW_APPROVAL_READER_ENABLED_MEDIA` defaults to `telegram,slack,teams` (was `telegram,slack`).
- **Plugin image allowlist default.** `CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES` and `CONTROL_API_ALLOWED_IMAGE_PREFIXES` default to `ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/,registry.evenfire.ai/`: the `deploy/base` list plus the Evenfire registry. The placeholder Artifact Registry path `us-central1-docker.pkg.dev/your-gcp-project/clerum/` is no longer listed. An install that uses `deploy/base` sets the variables and sees no change. Where a variable is unset, images from `ghcr.io/evenfire-ai/` now pass the check; with `CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST=true` or `CONTROL_API_ENFORCE_IMAGE_ALLOWLIST=true` they are accepted, and images under the placeholder path are refused.

### rpc-proxy default changes

The first release after v0.12.0 changes one rpc-proxy built-in default and makes
an invalid status or activity stream cap stop startup. A built-in default
applies when the variable is unset or empty in `rpc-proxy-config`.

| Variable                                 | Old default       | New default         |
| ---------------------------------------- | ----------------- | ------------------- |
| `RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS` | `60000` ms (60 s) | `100000` ms (100 s) |

If `RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS` is set in `rpc-proxy-config` or
`rpc-proxy-secrets`, that value wins and nothing changes. rpc-proxy reads both
through `envFrom`, the Secret last, so a key set in both takes the Secret's
value. The common case is a ConfigMap without the variable, which was added in
v0.11.0: rpc-proxy then used the old 60 s default and now uses 100 s. The timer
bounds the in-cluster transfer of an artifact body from the Host after the
Host's response headers arrive. It does not bound the client's download from
rpc-proxy. The largest body it has to move is
`RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB` (50 MiB by default), because rpc-proxy
refuses a larger response. The Host's own 50 MiB limit applies to the file
before the Host redacts secrets, and redaction can make the response longer. The
slowest transfer that still completes is that cap divided by the timer: with the
default 50 MiB, about 0.83 MiB/s with the old 60 s and 0.5 MiB/s with the new
100 s.
When the Host has to be woken first, the transfer is also bounded by the
remaining request hold, which is at most 48 s (`MAX_REQUEST_HOLD_MS`).

rpc-proxy sends nothing to the client until it has the whole body, so the edge
waits for three phases in a row: the Host lookup against control-api and the
Host's response headers, each bounded by `RPC_PROXY_UPSTREAM_TIMEOUT_MS` (8 s by
default), and then this body timer. Behind Cloudflare, the origin read timeout
(125 s by default) ends the request with an HTTP 524 when the three take longer,
while rpc-proxy keeps reading. With the defaults the worst case is
8 + 8 + 100 = 116 s. Keep twice `RPC_PROXY_UPSTREAM_TIMEOUT_MS` plus
`RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS` below your edge's timeout. If your
`rpc-proxy-config` started as a copy of the minikube ConfigMap, as
[the production guide](production.md) suggests, it sets `60000` and `300000`, a
worst case of 420 s: lower both before you serve it behind an edge. A copy taken
before v0.11.0 sets `RPC_PROXY_UPSTREAM_TIMEOUT_MS` to `60000` and
`RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB` to `250` but not the download timer, so it
now waits up to 60 + 60 + 100 = 220 s (180 s before this release), above
Cloudflare's 125 s default: lower `RPC_PROXY_UPSTREAM_TIMEOUT_MS` so that the
sum stays below your edge's timeout (the 8 s default gives 116 s). A body at its
250 MiB cap also needs 2.5 MiB/s to finish within the 100 s timer. Confirming
the timeout of the operated zones is tracked in #1309.

The six stream caps below keep their defaults, but an invalid value is now a
startup error. rpc-proxy reads the value as a number, as it already does for its
timeouts, and stops with an error naming the variable unless that number is a
whole number of at least 1: `abc`, `0`, `-1`, `1.5`, `Infinity` and a value that
is only whitespace all stop it. A numeric form that evaluates to a whole number,
such as `1e3` or `0x10`, is accepted as that number, and there is no upper
limit. Each cap counts the open streams of one rpc-proxy pod, and
a new stream gets HTTP 429 once its count reaches the cap. Before this release
`abc` parsed as `NaN` and `Infinity` stayed unbounded, which turned the cap off
in both cases, while `0` rejected every stream and a whitespace-only value parsed
as `0` with the same effect.

| Variable                                      | Limits                                  | Default |
| --------------------------------------------- | --------------------------------------- | ------- |
| `RPC_PROXY_STREAM_MAX_CONCURRENT`             | Host status streams, all users          | `1000`  |
| `RPC_PROXY_STREAM_MAX_PER_USER`               | Host status streams per user            | `3`     |
| `RPC_PROXY_STREAM_MAX_PER_USER_HOST`          | Host status streams per user and Host   | `1`     |
| `RPC_PROXY_ACTIVITY_STREAM_MAX_CONCURRENT`    | Host activity streams, all users        | `1000`  |
| `RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER`      | Host activity streams per user          | `3`     |
| `RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER_HOST` | Host activity streams per user and Host | `1`     |

To keep the old artifact download timeout, set
`RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS` in `rpc-proxy-config` before you roll
out the new image, and check every stream cap set in `rpc-proxy-config` or
`rpc-proxy-secrets` against the rule above. For the Secret, list its key names
only, for example
`kubectl -n rpc-proxy get secret rpc-proxy-secrets -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'`;
do not print its values. rpc-proxy reads these values at startup, so the new
default and the cap check apply when the new pods start.
