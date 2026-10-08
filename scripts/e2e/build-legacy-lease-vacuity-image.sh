#!/usr/bin/env bash
# Build the two images of the legacy processing-lease vacuity lane (issue #1022)
# inside the owned minikube profile, under the inherited T2 mutation lease:
#
#   clerum/mcp-host:legacy-lease-vacuity
#       mcp-host built from the pre-fix base revision (74e0d81d9, before #1019),
#       whose store treats a legacy lease as an inherited executor;
#   clerum/image-capabilities-mcp-host:legacy-lease-vacuity
#       the provider-fixture layer of THIS HEAD on top of that Host.
#
# It then writes the manifest `make minikube-run-legacy-lease-restart-vacuity`
# proves before patching anything:
#   <canonical>/.local-notes/infra/runs/legacy-lease-vacuity/<profile>/manifest.json
#
# Nothing is published. Run it through
# `make minikube-build-legacy-lease-vacuity-fixture`.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
profile="${MINIKUBE_PROFILE:?MINIKUBE_PROFILE is required}"
base_revision=74e0d81d9b70bbc0e123ed2bad89f08d3e13e99e
base_image=clerum/mcp-host:legacy-lease-vacuity
fixture_image=clerum/image-capabilities-mcp-host:legacy-lease-vacuity
deadline="${root}/scripts/minikube/run-with-deadline.mjs"

bash "${root}/scripts/minikube/require-t2-mutation-lock.sh"

[[ "${profile}" =~ ^clerum-.+-[a-f0-9]{8}$ ]] || {
  printf 'LEGACY_LEASE_VACUITY: %s is not a branch profile\n' "${profile}" >&2
  exit 1
}
[[ -z "$(git -C "${root}" status --porcelain)" ]] || {
  printf 'LEGACY_LEASE_VACUITY: the worktree must be clean (the fixture layer is built from HEAD)\n' >&2
  exit 1
}
head_revision="$(git -C "${root}" rev-parse --verify HEAD)"
[[ "$(git -C "${root}" cat-file -t "${base_revision}")" == commit ]] || {
  printf 'LEGACY_LEASE_VACUITY: base revision %s is not in this repository\n' "${base_revision}" >&2
  exit 1
}
common_dir="$(git -C "${root}" rev-parse --path-format=absolute --git-common-dir)"
canonical="$(cd -- "$(dirname -- "${common_dir}")" && pwd -P)"
[[ "$(basename -- "${canonical}")" == evenfire ]] || {
  printf 'LEGACY_LEASE_VACUITY: canonical Evenfire checkout required\n' >&2
  exit 1
}

run_dir="${canonical}/.local-notes/infra/runs/legacy-lease-vacuity/${profile}"
source_dir="${run_dir}/base-${base_revision:0:12}"

# Docker runs through the repository's isolated CLI environment (an empty task
# config, no ambient credentials), pointed at the profile's own daemon with
# `minikube docker-env`, exactly as scripts/minikube/build-images.sh does.
# shellcheck source=scripts/minikube/docker-cli-env.sh
source "${root}/scripts/minikube/docker-cli-env.sh"
cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  docker_cli_env_cleanup || cleanup_status=$?
  rm -rf -- "${source_dir}"
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then status="${cleanup_status}"; fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "${run_dir}"
rm -rf -- "${source_dir}"
mkdir -p "${source_dir}"
git -C "${root}" archive --format=tar "${base_revision}" | tar -x -C "${source_dir}"

# The archive must be the pre-fix store: it keeps the inherited-executor guard
# and has no legacy-lease discard. Either check failing means a wrong base.
store="${source_dir}/mcp-host/src/internalTools/gfsDownloadStore.ts"
grep -q 'hasInheritedExecutors' "${store}" || {
  printf 'LEGACY_LEASE_VACUITY: base store has no inherited-executor guard\n' >&2
  exit 1
}
if grep -q 'discardLegacyProcessingLeases' "${store}"; then
  printf 'LEGACY_LEASE_VACUITY: base store already discards legacy leases\n' >&2
  exit 1
fi

docker_cli_env_prepare
docker_env_output="$(node "${deadline}" --timeout-seconds 60 --kill-grace-seconds 5 --label minikube-docker-env -- \
  minikube -p "${profile}" docker-env --shell bash)"
[[ -n "${docker_env_output}" ]] || {
  printf 'LEGACY_LEASE_VACUITY: minikube returned an empty Docker environment\n' >&2
  exit 1
}
eval "${docker_env_output}"
unset DOCKER_API_VERSION

inspect() {
  docker_cli_run_public "inspect-$1" 60 docker image inspect "$1" --format "$2" | tr -d '\r\n'
}

# The base Host image from the archived pre-fix tree. Its build context is the
# archive root, which carries that revision's own root .dockerignore.
docker_cli_run_public legacy-lease-vacuity-host-build "${MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS}" \
  docker build --tag "${base_image}" --file "${source_dir}/mcp-host/Dockerfile" "${source_dir}"
base_id="$(inspect "${base_image}" '{{.Id}}')"

# The provider-fixture layer of THIS HEAD on top of that Host.
docker_cli_run_public legacy-lease-vacuity-fixture-build "${MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS}" \
  docker build --tag "${fixture_image}" \
  --build-arg "MCP_HOST_IMAGE=${base_image}" \
  --file "${root}/tests/e2e/fixtures/image-capabilities/Dockerfile" "${root}"
fixture_id="$(inspect "${fixture_image}" '{{.Id}}')"

for id in "${base_id}" "${fixture_id}"; do
  [[ "${id}" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    printf 'LEGACY_LEASE_VACUITY: unexpected image id "%s"\n' "${id}" >&2
    exit 1
  }
done
# The fixture image must extend exactly the base just built.
parent_layers="$(inspect "${base_image}" '{{json .RootFS.Layers}}')"
fixture_layers="$(inspect "${fixture_image}" '{{json .RootFS.Layers}}')"
[[ "${fixture_layers}" == "${parent_layers%]},"* ]] || {
  printf 'LEGACY_LEASE_VACUITY: the fixture layer does not extend the pre-fix Host image\n' >&2
  exit 1
}

manifest="${run_dir}/manifest.json"
temporary="$(mktemp "${run_dir}/manifest.json.XXXXXX")"
node -e '
const [file, profile, baseRevision, head, baseImage, baseId, fixtureImage, fixtureId] = process.argv.slice(1)
const manifest = {
  kind: "legacy-lease-vacuity",
  profile,
  baseRevision,
  fixtureLayerRevision: head,
  images: { [baseImage]: baseId, [fixtureImage]: fixtureId },
  derivedFrom: { [fixtureImage]: { ref: baseImage, id: baseId } },
  builtAt: new Date().toISOString(),
}
require("node:fs").writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
' "${temporary}" "${profile}" "${base_revision}" "${head_revision}" \
  "${base_image}" "${base_id}" "${fixture_image}" "${fixture_id}"
mv -f -- "${temporary}" "${manifest}"
printf 'LEGACY_LEASE_VACUITY_BUILT manifest=%s base=%s fixture=%s\n' "${manifest}" "${base_id}" "${fixture_id}"
