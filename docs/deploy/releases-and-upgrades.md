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
- `validate-release-version-bumps.mjs` fails if code under `external-rest-api/`
  or `rpc-proxy/` changed but that package's version did not.

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

| Note                                                                               | Read it when                                                                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Workflow output PVC upgrade](workflow-output-pvc-upgrade.md)                      | You use WorkflowRecipes with `spec.output.destination: pvc`. The default PVC is now one per parent recipe.        |
| [Plugin Workload SDK upgrade and policy migration](plugin-workload-sdk-upgrade.md) | You use the Plugin Workload SDK. It has a required order with the SDK turned off during the upgrade.              |
| [GFS permission-store credential lifecycle](gfs-permission-store.md)               | You run the Global File System. It covers provisioning, rotating, and recovering the `gfs_controller` credential. |
| [Host PVC layout upgrade](host-pvc-layout-upgrade.md)                              | You upgrade from v0.10.x or v0.11.x and have created stateless Hosts. Run the inventory before the upgrade.       |
