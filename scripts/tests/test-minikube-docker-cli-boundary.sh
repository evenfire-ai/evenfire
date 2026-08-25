#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck source=scripts/minikube/docker-cli-env.sh
source "${ROOT}/scripts/minikube/docker-cli-env.sh"
BUILD_SCRIPT="${ROOT}/scripts/minikube/build-images.sh"
PULL_SCRIPT="${ROOT}/scripts/minikube/pull-images.sh"
INCREMENTAL_SCRIPT="${ROOT}/scripts/minikube/pre-gate-incremental.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect_reject() {
  local endpoint="$1"
  if docker_cli_env_validate_local_endpoint "${endpoint}"; then
    fail "accepted unsafe Docker endpoint: ${endpoint}"
  fi
}

has_unwrapped_docker_operation() {
  local file="$1"
  awk '
    /^[[:space:]]*docker[[:space:]]+(build|pull|tag|inspect|images|info|context)([[:space:]]|$)/ {
      if (previous !~ /docker_cli_(run_public|run_private)|incremental_docker_run|docker_minikube/ &&
          before_previous !~ /docker_cli_(run_public|run_private)|incremental_docker_run|docker_minikube/) {
        print NR ":" $0
        found = 1
      }
    }
    { before_previous = previous; previous = $0 }
    END { exit found ? 0 : 1 }
  ' "$file"
}

docker_cli_env_validate_local_endpoint unix:///var/run/docker.sock ||
  fail 'rejected the local Unix Docker endpoint'
docker_cli_env_validate_local_endpoint tcp://127.0.0.1:2375 ||
  fail 'rejected the loopback Docker TCP endpoint'
docker_cli_env_validate_minikube_endpoint tcp://192.168.49.2:2375 192.168.49.2 ||
  fail 'rejected the selected Minikube profile endpoint'
if docker_cli_env_validate_minikube_endpoint tcp://192.168.49.3:2375 192.168.49.2; then
  fail 'accepted a Docker endpoint belonging to a different Minikube profile'
fi
DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT=tcp://127.0.0.1:61906
docker_cli_env_validate_minikube_endpoint tcp://127.0.0.1:61906 192.168.49.2 ||
  fail 'rejected the loopback endpoint published by minikube docker-env'
if docker_cli_env_validate_minikube_endpoint tcp://127.0.0.1:61907 192.168.49.2; then
  fail 'accepted a different loopback Docker endpoint for the selected profile'
fi
if (unset DOCKER_HOST; DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT=tcp://127.0.0.1:61906 docker_cli_env_resolve_endpoint); then
  fail 'resolved an ambient Docker context when minikube endpoint was missing'
fi
unset DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT
expect_reject 'ssh://prod.invalid/var/run/docker.sock'
expect_reject 'tcp://10.0.0.7:2375'
expect_reject 'tcp://127.0.0.1:70000'

docker_cli_env_validate_seconds TEST_TIMEOUT 5 10 ||
  fail 'rejected a valid bounded timeout'
if docker_cli_env_validate_seconds TEST_TIMEOUT 0 10; then
  fail 'accepted a zero timeout'
fi
if docker_cli_env_validate_seconds TEST_TIMEOUT 11 10; then
  fail 'accepted a timeout above the configured maximum'
fi

runner="${ROOT}/scripts/minikube/run-with-deadline.mjs"
success_output="$(node "${runner}" --timeout-seconds 3 --label boundary-success -- node -e 'process.stdout.write("RUNNER_GREEN\\n")')"
[[ "${success_output}" == *RUNNER_GREEN* ]] || fail 'deadline runner did not preserve a successful child result'
timeout_status=0
node "${runner}" --timeout-seconds 1 --heartbeat-seconds 1 --label boundary-timeout -- \
  node -e 'setTimeout(() => {}, 3000)' >/dev/null 2>&1 || timeout_status=$?
[[ "${timeout_status}" -eq 124 ]] || fail "deadline runner returned ${timeout_status} instead of timeout 124"

# The Docker driver publishes the profile daemon through an exact loopback
# port returned by `minikube docker-env`; the port must remain bound to that
# selected profile rather than to an ambient Docker context.
profile_config="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-minikube-docker-test.XXXXXX")"
DOCKER_CONFIG="${profile_config}"
DOCKER_HOST='tcp://127.0.0.1:61906'
DOCKER_CLI_TASK_CONFIG="${profile_config}"
DOCKER_CLI_ENDPOINT_SOURCE=minikube
DOCKER_CLI_EXPECTED_MINIKUBE_IP=192.168.49.2
DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT='tcp://127.0.0.1:61906'
profile_output="$(docker_cli_run_with_config "${profile_config}" profile-dispatch 3 node -e 'process.stdout.write("PROFILE_ENDPOINT_GREEN")')"
[[ "${profile_output}" == *PROFILE_ENDPOINT_GREEN* ]] ||
  fail 'profile-owned Docker endpoint did not pass the bounded dispatch path'
rm -rf -- "${profile_config}"

for caller in "${BUILD_SCRIPT}" "${PULL_SCRIPT}"; do
  grep -Fq 'docker-cli-env.sh' "${caller}" ||
    fail "image operation caller does not source the Docker boundary: ${caller}"
  grep -Fq 'docker_cli_env_prepare' "${caller}" ||
    fail "image operation caller does not prepare an isolated Docker config: ${caller}"
  grep -Fq 'docker_cli_run_public' "${caller}" ||
    fail "image operation caller does not route operations through deadlines: ${caller}"
  grep -Fq 'DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT' "${caller}" ||
    fail "image operation caller does not bind docker-env to the selected profile: ${caller}"
  if has_unwrapped_docker_operation "${caller}"; then
    fail "image operation caller has a raw Docker operation outside the boundary: ${caller}"
  fi
done

grep -Fq 'docker-cli-env.sh' "${INCREMENTAL_SCRIPT}" ||
  fail 'incremental pre-gate does not source the Docker boundary'
grep -Fq 'incremental_docker_run' "${INCREMENTAL_SCRIPT}" ||
  fail 'incremental pre-gate does not route image operations through deadlines'
grep -Fq 'DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT' "${INCREMENTAL_SCRIPT}" ||
  fail 'incremental pre-gate does not bind docker-env to the selected profile'
grep -Fq 'INCREMENTAL_RELEASE_BASELINE_COMMIT' "${INCREMENTAL_SCRIPT}" ||
  fail 'incremental baseline does not retain Docker cleanup state in the parent shell'
if grep -Fq 'baseline="$(incremental_release_baseline_commit)"' "${INCREMENTAL_SCRIPT}"; then
  fail 'incremental baseline still prepares Docker inside a leaking command substitution'
fi
if has_unwrapped_docker_operation "${INCREMENTAL_SCRIPT}"; then
  fail 'incremental pre-gate has a raw Docker image operation outside the boundary'
fi
for caller in "${ROOT}/Makefile" "${ROOT}/scripts/minikube/full-setup.sh"; do
  if has_unwrapped_docker_operation "${caller}"; then
    fail "startup/deploy caller has a raw Docker operation outside the boundary: ${caller}"
  fi
done

grep -Fq 'docker_cli_run_private' "${BUILD_SCRIPT}" ||
  fail 'build caller has no explicit-auth path for private Docker operations'
grep -Fq 'docker_cli_run_private' "${PULL_SCRIPT}" ||
  fail 'pull caller has no explicit-auth path for private Docker operations'
grep -Fq 'docker_cli_env_prepare pull' "${PULL_SCRIPT}" ||
  fail 'pull caller still requests the build-only Docker mode'
grep -Fq 'DOCKER_CLI_IMAGE_MODE=pull' "${BUILD_SCRIPT}" ||
  fail 'public-only build caller does not select pull mode'
grep -Fq 'VERIFY_ONLY" = false' "${BUILD_SCRIPT}" ||
  fail 'verify-only path does not bypass Docker preparation'
if grep -Eq 'docker_cli_env_prepare (true|false)' "${BUILD_SCRIPT}" "${PULL_SCRIPT}" "${ROOT}/scripts/minikube/docker-cli-env.sh"; then
  fail 'Docker preparation still uses the ambiguous boolean mode'
fi
grep -Fq 'docker_cli_env_prepare probe' "${ROOT}/scripts/minikube/docker-cli-env.sh" ||
  fail 'Docker CLI entry point does not select probe mode'

printf 'PASS: Docker endpoint and deadline boundary contract\n'
