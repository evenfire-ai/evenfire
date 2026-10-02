#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/conversation-store-verify-images.XXXXXX")"
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }
cleanup() {
  local status=$?
  rm -rf -- "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT

mkdir -p \
  "$TMP_ROOT/repo/scripts/conversation-store" \
  "$TMP_ROOT/repo/scripts/minikube" \
  "$TMP_ROOT/bin"
cp "$REPO_ROOT/scripts/conversation-store/verify-images.sh" \
  "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh"
cp "$REPO_ROOT/scripts/conversation-store/verify-image-output.mjs" \
  "$TMP_ROOT/repo/scripts/conversation-store/verify-image-output.mjs"
cp "$REPO_ROOT/scripts/minikube/docker-cli-env.sh" \
  "$TMP_ROOT/repo/scripts/minikube/docker-cli-env.sh"
cp "$REPO_ROOT/scripts/minikube/run-with-deadline.mjs" \
  "$TMP_ROOT/repo/scripts/minikube/run-with-deadline.mjs"
cat >"$TMP_ROOT/repo/scripts/minikube/require-t2-mutation-lock.sh" <<'LOCK_STUB'
#!/usr/bin/env bash
set -euo pipefail
exit 0
LOCK_STUB
chmod +x "$TMP_ROOT/repo/scripts/minikube/require-t2-mutation-lock.sh"

cat >"$TMP_ROOT/repo/scripts/conversation-store/verify-image-output.mjs" <<'VERIFY_STUB'
import * as fs from "node:fs";
const proof = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (proof.outcome !== "stub-ok") process.exit(1);
process.stdout.write("IMAGE_CAPABILITY_VERIFIED\n");
VERIFY_STUB

cat >"$TMP_ROOT/bin/docker" <<'DOCKER_STUB'
#!/usr/bin/env bash
printf 'HOST_DOCKER %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *SkipTLSVerify*)
    printf 'unix:///tmp/evenfire-test-docker.sock\tfalse\t{}\n'
    ;;
  'context inspect --format {{.Endpoints.docker.Host}} default')
    printf 'unix:///tmp/evenfire-test-docker.sock\n'
    ;;
  info|'info '*)
    : # The isolated local endpoint probe is allowed.
    ;;
  'image inspect '*|'run '*|'container ls '*|'container rm '*)
    printf 'UNEXPECTED_HOST_DOCKER_MUTATION_OR_LOOKUP\n' >&2
    exit 99
    ;;
  *)
    printf 'UNEXPECTED_HOST_DOCKER_CALL %s\n' "$*" >&2
    exit 98
    ;;
esac
DOCKER_STUB

cat >"$TMP_ROOT/bin/minikube" <<'MINIKUBE_STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'MINIKUBE %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "${5:-}" in
  "'docker' "*)
    ;;
  *)
    printf 'UNEXPECTED_MINIKUBE_INTERFACE\n' >&2
    exit 97
    ;;
esac
profile="$2"
if [[ "$profile" != "${TEST_PROFILE:?}" ]]; then
  printf 'WRONG_MINIKUBE_PROFILE %s\n' "$profile" >&2
  exit 96
fi
docker() {
  printf 'REMOTE_DOCKER %s\n' "$*" >>"${TEST_LOG_FILE:?}"
  if [[ "${TEST_INSPECT_FAILURE:-0}" == 1 && "$*" == 'image inspect '* ]]; then
    printf 'sha256:%064d\r\n' 1
    return 77
  fi
  case "$*" in
    'version --format {{.Server.Version}}')
      printf '99.9.0\n'
      ;;
    'image inspect --format {{.Id}} clerum/mcp-host:test')
      printf 'sha256:%064d\r\n' 1
      ;;
    'image inspect --format {{.Id}} clerum/mcp-host-slim:test')
      printf 'sha256:%064d\r\n' 2
      ;;
    'image inspect --format {{.Id}} clerum/mcp-host-full:test')
      printf 'sha256:%064d\r\n' 3
      ;;
    'image inspect --format {{.Id}} clerum/mcp-host-desktop:test')
      printf 'sha256:%064d\r\n' 4
      ;;
    'image inspect --format {{.Id}} registry.example:5000/clerum/mcp-host:test'|\
    'image inspect --format {{.Id}} clerum/mcp-host@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'|\
    'image inspect --format {{.Id}} sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
      printf 'sha256:%064d\r\n' 5
      ;;
    'container ls --all --no-trunc --filter label=clerum.io/conversation-store-probe='*)
      printf '%s' "${6#label=clerum.io/conversation-store-probe=}" \
        >"${TEST_LOG_FILE%/*}/stub-probe-id"
      printf '%s\r\n%s\r\n' \
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      ;;
    'container inspect --format '*)
      case "${!#}" in
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
          printf '%s\r\n' "$(cat "${TEST_LOG_FILE%/*}/stub-probe-id")"
          ;;
        bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
          printf 'foreign-probe\r\n'
          ;;
        *)
          printf 'UNEXPECTED_CONTAINER_INSPECT %s\n' "${!#}" >&2
          exit 92
          ;;
      esac
      ;;
    'container rm --force aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      :
      ;;
    'container rm --force '*)
      printf 'FOREIGN_CONTAINER_REMOVE_ATTEMPT %s\n' "${!#}" >&2
      exit 91
      ;;
    'run --rm --pull=never --network=none --user 1001:1001 --label clerum.io/conversation-store-probe='*)
      for required in \
        '--tmpfs /inspect-root:rw,size=512m,uid=1001,gid=1001,mode=0700' \
        '--entrypoint node' \
        '/app/mcp-host/ops/image-probe.mjs'; do
        [[ "$*" == *"$required"* ]] || exit 95
      done
      [[ "$*" == *" sha256:"*"/app/mcp-host/ops/image-probe.mjs" ]] || exit 94
      printf '{"outcome":"stub-ok"}\n'
      ;;
    *)
      printf 'UNEXPECTED_OWNED_DOCKER_COMMAND %s\n' "$*" >&2
      exit 93
      ;;
  esac
}
eval "${5:?}"
MINIKUBE_STUB

chmod +x "$TMP_ROOT/bin/docker" "$TMP_ROOT/bin/minikube"

TEST_PROFILE='clerum-fix-image-gate-abcdef01'
TEST_LOG_FILE="$TMP_ROOT/ops.log"
export TEST_PROFILE TEST_LOG_FILE

set +e
PATH="$TMP_ROOT/bin:$PATH" \
MINIKUBE_PROFILE="$TEST_PROFILE" \
  bash "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh" \
  >"$TMP_ROOT/out.log" 2>"$TMP_ROOT/err.log"
status=$?
set -e

output="$(cat "$TMP_ROOT/out.log")"
errors="$(cat "$TMP_ROOT/err.log")"
if [[ "$status" -ne 0 ]]; then
  fail "gate exited $status: $output $errors"
elif [[ "$output" != *'CONVERSATION_STORE_IMAGES_PASS images=4'* ]]; then
  fail "gate did not verify four canonical images: $output"
else
  pass 'gate verifies all four canonical image variants'
fi

for ref in \
  clerum/mcp-host:test \
  clerum/mcp-host-slim:test \
  clerum/mcp-host-full:test \
  clerum/mcp-host-desktop:test; do
  if grep -Fq "REMOTE_DOCKER image inspect --format {{.Id}} $ref" "$TEST_LOG_FILE"; then
    pass "selects canonical ref $ref"
  else
    fail "missing canonical ref $ref"
  fi
done

if grep -Fq -- "-p ${TEST_PROFILE} ssh -- 'docker'" "$TEST_LOG_FILE"; then
  pass 'all Docker operations target the owned Minikube node daemon'
else
  fail 'owned-node Docker transport was not used consistently'
fi
if grep -Fq "'image' 'inspect' '--format' '{{.Id}}' 'clerum/mcp-host:test'" "$TEST_LOG_FILE"; then
  pass 'remote argv is shell-quoted before minikube ssh'
else
  fail 'remote argv quoting was not observed'
fi
if grep -Fq -- '--pull=never' "$TEST_LOG_FILE" &&
   grep -Fq -- '--network=none' "$TEST_LOG_FILE" &&
   grep -Fq -- '--user 1001:1001' "$TEST_LOG_FILE"; then
  pass 'probe keeps immutable-ID, network-isolated UID1001 execution'
else
  fail 'probe isolation or immutable-ID execution was weakened'
fi
if grep -Fq 'HOST_DOCKER image inspect' "$TEST_LOG_FILE" ||
   grep -Fq 'HOST_DOCKER run' "$TEST_LOG_FILE"; then
  fail 'gate performed image lookup or probe mutation on host Docker'
else
  pass 'no host Docker image lookup or probe mutation'
fi
if grep -Fq 'docker-env' "$TEST_LOG_FILE"; then
  fail 'gate used docker-env transport'
else
  pass 'gate does not use eval docker-env transport'
fi
if grep -Fq -- 'clerum/mcp-host:test-slim' "$TEST_LOG_FILE" ||
   grep -Fq -- 'clerum/mcp-host:test-full' "$TEST_LOG_FILE"; then
  fail 'gate retained a noncanonical image tag'
else
  pass 'gate contains no legacy test-slim or test-full refs'
fi

if grep -Fq -- 'container ls --all --no-trunc --filter label=clerum.io/conversation-store-probe=' "$TEST_LOG_FILE" &&
   grep -Fq -- 'container inspect --format {{index .Config.Labels "clerum.io/conversation-store-probe"}} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$TEST_LOG_FILE" &&
   grep -Fq -- 'container rm --force aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$TEST_LOG_FILE" &&
   ! grep -Fq -- 'container rm --force bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$TEST_LOG_FILE"; then
  pass 'residual cleanup rechecks exact label and removes only owned full ID'
else
  fail 'residual container cleanup removed unsafe or foreign state'
fi

# Docker owns reference syntax; the gate accepts safe registry, digest and ID forms.
valid_refs_status=0
PATH="$TMP_ROOT/bin:$PATH" \
TEST_LOG_FILE="$TMP_ROOT/valid-refs.log" \
MINIKUBE_PROFILE="$TEST_PROFILE" \
  bash "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh" \
  registry.example:5000/clerum/mcp-host:test \
  clerum/mcp-host@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
  >"$TMP_ROOT/valid-refs-out.log" 2>"$TMP_ROOT/valid-refs-err.log" || valid_refs_status=$?
if [[ "$valid_refs_status" -eq 0 ]] && grep -Fq 'CONVERSATION_STORE_IMAGES_PASS images=3' "$TMP_ROOT/valid-refs-out.log"; then
  pass 'safe registry-port, digest and immutable-ID references remain supported'
else
  fail "safe explicit image references were rejected (exit $valid_refs_status): $(cat "$TMP_ROOT/valid-refs-err.log")"
fi

# A valid-looking ID must not hide a failed remote inspect through normalization.
inspect_failure_status=0
PATH="$TMP_ROOT/bin:$PATH" \
TEST_INSPECT_FAILURE=1 \
TEST_LOG_FILE="$TMP_ROOT/inspect-failure.log" \
MINIKUBE_PROFILE="$TEST_PROFILE" \
  bash "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh" \
  >"$TMP_ROOT/inspect-failure-out.log" 2>"$TMP_ROOT/inspect-failure-err.log" || inspect_failure_status=$?
if [[ "$inspect_failure_status" -eq 1 ]] &&
   grep -Fq 'IMAGE_MISSING' "$TMP_ROOT/inspect-failure-err.log" &&
   ! grep -Fq 'REMOTE_DOCKER run ' "$TMP_ROOT/inspect-failure.log"; then
  pass 'CRLF normalization preserves failed remote inspect exits before any probe'
else
  fail 'CRLF normalization hid a failed remote inspect'
fi

malicious_ref='clerum/mcp-host:test; printf pwned $(printf injected) `printf injected`'
: >"$TMP_ROOT/malicious.log"
set +e
PATH="$TMP_ROOT/bin:$PATH" \
TEST_LOG_FILE="$TMP_ROOT/malicious.log" \
MINIKUBE_PROFILE="$TEST_PROFILE" \
  bash "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh" "$malicious_ref" \
  >"$TMP_ROOT/malicious-out.log" 2>"$TMP_ROOT/malicious-err.log"
malicious_status=$?
set -e
if [[ "$malicious_status" -eq 1 ]] &&
   grep -Fq 'IMAGE_REF_INVALID' "$TMP_ROOT/malicious-err.log" &&
   ! grep -Fq 'MINIKUBE' "$TMP_ROOT/malicious.log" &&
   ! grep -Fq 'HOST_DOCKER' "$TMP_ROOT/malicious.log"; then
  pass 'malicious image ref is rejected before any remote operation'
else
  fail 'malicious image ref reached a remote or host operation'
fi

exit "$FAIL"
