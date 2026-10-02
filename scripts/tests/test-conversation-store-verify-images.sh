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
cp "$REPO_ROOT/scripts/conversation-store/desktop-startup-observation.mjs" \
  "$TMP_ROOT/repo/scripts/conversation-store/desktop-startup-observation.mjs"
cp "$REPO_ROOT/scripts/minikube/docker-cli-env.sh" \
  "$TMP_ROOT/repo/scripts/minikube/docker-cli-env.sh"
cp "$REPO_ROOT/scripts/minikube/run-with-deadline.mjs" \
  "$TMP_ROOT/repo/scripts/minikube/run-with-deadline.mjs"
cat >"$TMP_ROOT/repo/scripts/minikube/require-t2-mutation-lock.sh" <<'LOCK_STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${TEST_LOCK_FAILURE:-0}" != 1 ]] || exit 88
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
    'container inspect --format {{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} '*)
      if [[ "${TEST_STARTUP_MODE:-live}" == s6 || "$(cat "${TEST_LOG_FILE%/*}/stub-startup-state")" == exited ]]; then
        printf 'exited 1 false\r\n'
      else
        printf 'running 0 false\r\n'
      fi
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
    'container rm --force aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'|    'container rm --force --volumes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      [[ "${TEST_CLEANUP_FAILURE:-0}" != 1 ]] || return 79
      ;;
    'run --detach --pull=never --network=none --user 1001:1001 '*)
      for required in \
        '--cap-drop=ALL' '--security-opt=no-new-privileges:true' '--memory=1g' '--memory-swap=1g' \
        '--cpus=1' '--pids-limit=256' '--stop-timeout=5' \
        '--log-driver=json-file' '--log-opt=max-size=256k' '--log-opt=max-file=1' \
        '--tmpfs /tmp:rw,size=64m,uid=1001,gid=1001,mode=1777' \
        '--tmpfs /config/workspace:rw,size=64m,uid=1001,gid=1001,mode=0700'; do
        [[ "$*" == *"$required"* ]] || return 95
      done
      for forbidden in '--entrypoint' '--env' '--volume' '--mount' '--tmpfs /run' '--privileged'; do
        [[ "$*" != *"$forbidden"* ]] || return 95
      done
      [[ "${!#}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 94
      for arg in "$@"; do
        if [[ "$arg" == clerum.io/conversation-store-probe=* ]]; then
          printf '%s' "${arg#clerum.io/conversation-store-probe=}" >"${TEST_LOG_FILE%/*}/stub-probe-id"
        fi
      done
      case "${TEST_STARTUP_MODE:-live}" in
        launch-log)
          # Remote stderr arrives on stdout through the Minikube SSH PTY.
          printf 'Error response from daemon: failed to initialize logging driver: unknown log opt\r\nPRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'
          return 125 ;;
        launch-oci|launch-oci-zero)
          # A valid ID must not hide a create failure on the other stream.
          printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n'
          printf 'OCI runtime create failed: PRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\n' >&2
          [[ "$TEST_STARTUP_MODE" == launch-oci-zero ]] && return 0
          return 126 ;;
        launch-mount) printf 'invalid mount config: PRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'; return 125 ;;
        launch-policy) printf 'invalid security option: PRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'; return 125 ;;
        launch-config) printf 'unknown flag: PRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'; return 125 ;;
        launch-daemon) printf 'Cannot connect to the Docker daemon: PRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'; return 125 ;;
        launch-unknown) printf 'PRIVATE_LAUNCH_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'; return 73 ;;
        launch-timeout) return 124 ;;
      esac
      printf 'running' >"${TEST_LOG_FILE%/*}/stub-startup-state"
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n'
      ;;
    'exec --user 1001:1001 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node --input-type=module -e '*)
      case "${TEST_STARTUP_MODE:-live}" in
        s6) return 1 ;;
        transport) printf '{"proofVersion":1}\r\n'; return 77 ;;
        timeout) return 124 ;;
      esac
      TEST_STARTUP_MODE="${TEST_STARTUP_MODE:-live}" node --input-type=module - <<'SNAPSHOT_STUB'
const fact = (pid, ppid) => ({ pid, ppid, startTime: String(pid), state: "S", uid: [1001,1001,1001,1001], gid: [1001,1001,1001,1001], noNewPrivs: 1, caps: Object.fromEntries(["CapInh","CapPrm","CapEff","CapBnd","CapAmb"].map((name) => [name,"0000000000000000"])) });
const init = fact(1,0), supervisor = fact(20,1), child = fact(21,20);
const last = { init, supervisors: [supervisor], children: [child], childExitRecorded: false, categories: [] };
let reason = "EntryObserved";
switch (process.env.TEST_STARTUP_MODE) {
  case "missing": last.supervisors = []; break;
  case "duplicate": last.children.push(fact(22,20)); break;
  case "dead": last.children = []; last.childExitRecorded = true; break;
  case "uid": child.uid[0] = 0; break;
  case "gid": supervisor.gid[0] = 0; break;
  case "nnp": init.noNewPrivs = 0; break;
  case "caps": supervisor.caps.CapEff = "0000000000000001"; break;
  case "auth": reason = "ChildConfigurationFailure"; last.children = []; last.childExitRecorded = true; last.categories = ["MissingAuthentication"]; break;
}
process.stdout.write(JSON.stringify({ proofVersion: 1, reason, singleChildEntered: true, windowCompleted: true, distinctSupervisors: 1, distinctChildren: 1, last }) + "\r\n");
SNAPSHOT_STUB
      ;;
    'container stop --time 5 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      printf 'exited' >"${TEST_LOG_FILE%/*}/stub-startup-state"
      ;;
    'logs --tail 80 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      if [[ "${TEST_STARTUP_MODE:-live}" == s6 ]]; then
        printf 's6-mkdir: fatal: unable to mkdir /run/s6: Permission denied\r\n'
      fi
      printf 'PRIVATE_LOG_SENTINEL_SHOULD_NOT_BE_EMITTED\r\n'
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


# The same CI-selected wrapper exercises the opt-in actual-entrypoint subprobe.
run_startup_case() {
  local scenario="$1" expected_status="$2" expected_category="$3" result=0
  local log="$TMP_ROOT/startup-$scenario.log" out="$TMP_ROOT/startup-$scenario.out" err="$TMP_ROOT/startup-$scenario.err"
  PATH="$TMP_ROOT/bin:$PATH" TEST_STARTUP_MODE="$scenario" \
  TEST_CLEANUP_FAILURE="$([[ "$scenario" == cleanup ]] && printf 1 || printf 0)" \
  TEST_LOG_FILE="$log" MINIKUBE_PROFILE="$TEST_PROFILE" \
    bash "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh" --desktop-startup \
    >"$out" 2>"$err" || result=$?
  if [[ "$result" -eq "$expected_status" ]] && \
     grep -Fq 'DESKTOP_STARTUP status=Pending' "$out" && \
     grep -Fq "${expected_category}" "$out" && \
     ! grep -Fq 'PRIVATE_LOG_SENTINEL' "$out" && \
     ! grep -Fq 'PRIVATE_LOG_SENTINEL' "$err" && \
     ! grep -Fq 'PRIVATE_LAUNCH_SENTINEL' "$out" && \
     ! grep -Fq 'PRIVATE_LAUNCH_SENTINEL' "$err" && \
     ! grep -Fq 'CONVERSATION_STORE_IMAGES_PASS' "$out"; then
    pass "Desktop entrypoint subprobe handles $scenario truthfully"
  else
    fail "Desktop scenario $scenario returned $result (expected $expected_status): $(cat "$out") $(cat "$err")"
  fi
  if ! grep -Fq 'container rm --force --volumes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$log" || \
     grep -Fq 'container rm --force --volumes bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$log"; then
    fail "Desktop scenario $scenario did not restrict anonymous-volume cleanup to its exact-label container"
  fi
}

run_startup_case live 0 '"status":"EntryObserved"'
if grep -Fq 'REMOTE_DOCKER run --detach --pull=never --network=none --user 1001:1001 --cap-drop=ALL --security-opt=no-new-privileges:true' "$TMP_ROOT/startup-live.log" && \
   grep -Fq '"uid":[1001,1001,1001,1001]' "$TMP_ROOT/startup-live.out" && \
   grep -Fq '"noNewPrivs":1' "$TMP_ROOT/startup-live.out" && \
   grep -Fq '"CapEff":"0000000000000000"' "$TMP_ROOT/startup-live.out" && \
   grep -Fq '"windowCompleted":true' "$TMP_ROOT/startup-live.out" && \
   grep -Fq '"termination":"probe-stop"' "$TMP_ROOT/startup-live.out" && \
   grep -Fq '"final":{"status":"exited","exitCode":1,"oomKilled":false}' "$TMP_ROOT/startup-live.out" && \
   ! grep -Fq 'HOST_DOCKER run' "$TMP_ROOT/startup-live.log"; then
  pass 'Desktop uses the real entrypoint, bounded policy, actual kernel identities and observed exit'
else
  fail 'Desktop entrypoint policy or compact process/exit proof was incomplete'
fi
run_startup_case s6 1 '"category":"S6RuntimePermission"'
run_startup_case auth 1 '"category":"MissingAuthentication"'
run_startup_case missing 1 '"category":"MissingSupervisorOrChild"'
run_startup_case dead 1 '"status":"Failed"'
run_startup_case duplicate 1 '"category":"MultipleProcesses"'
for scenario in uid gid nnp caps; do
  run_startup_case "$scenario" 1 '"category":"ProcessPolicyMismatch"'
done
run_startup_case transport 1 '"transportExit":77'
run_startup_case timeout 1 '"transportTimedOut":true'
run_startup_case cleanup 1 'status=Failed category=CleanupFailed'

# Launch diagnostics stay failed, preserve the original transport status, and
# do not race a background reader or persist/emit either raw launch stream.
run_startup_case launch-log 125 'category=DockerLoggingFailed launchExit=125'
run_startup_case launch-oci 126 'category=OciCreateFailed launchExit=126'
run_startup_case launch-oci-zero 1 'category=OciCreateFailed launchExit=0'
run_startup_case launch-mount 125 'category=DockerMountFailed launchExit=125'
run_startup_case launch-policy 125 'category=DockerPolicyRejected launchExit=125'
run_startup_case launch-config 125 'category=DockerLaunchConfigurationFailed launchExit=125'
run_startup_case launch-daemon 125 'category=DockerDaemonUnavailable launchExit=125'
run_startup_case launch-unknown 73 'category=UnknownLaunchFailure launchExit=73'
run_startup_case launch-timeout 124 'category=LaunchTransportTimeout launchExit=124 transportTimedOut=true'

lock_result=0
: >"$TMP_ROOT/startup-lock.log"
PATH="$TMP_ROOT/bin:$PATH" TEST_LOCK_FAILURE=1 TEST_LOG_FILE="$TMP_ROOT/startup-lock.log" \
MINIKUBE_PROFILE="$TEST_PROFILE" \
  bash "$TMP_ROOT/repo/scripts/conversation-store/verify-images.sh" --desktop-startup \
  >"$TMP_ROOT/startup-lock.out" 2>"$TMP_ROOT/startup-lock.err" || lock_result=$?
if [[ "$lock_result" -eq 88 && ! -s "$TMP_ROOT/startup-lock.log" ]]; then
  pass 'Desktop subprobe refuses a missing inherited mutation lease before Docker transport'
else
  fail 'Desktop subprobe bypassed the inherited mutation lease'
fi

# Compare the public target's lease identity to the existing image gate.
if node --input-type=module - "$REPO_ROOT/Makefile" <<'MAKE_CONTRACT'
import * as fs from "node:fs";
const make = fs.readFileSync(process.argv[2], "utf8");
const recipe = (target) => make.match(new RegExp(`^${target}:.*\\n((?:\\t.*\\n)+)`, "m"))?.[1];
const existing = recipe("minikube-verify-conversation-store-images");
const startup = recipe("minikube-probe-desktop-startup");
if (!existing || !startup || existing.split("bash scripts/conversation-store/")[0] !== startup.split("bash scripts/conversation-store/")[0] || !startup.endsWith("bash scripts/conversation-store/verify-images.sh --desktop-startup\n")) process.exit(1);
MAKE_CONTRACT
then
  pass 'public Desktop target inherits the same profile/context/worktree/lock contract'
else
  fail 'public Desktop target changed the image gate ownership contract'
fi

# Execute the exact emitted observer with a hermetic /proc surface. This catches
# source mutations that canned Docker responses cannot detect.
if node --input-type=module - "$REPO_ROOT/scripts/conversation-store/desktop-startup-observation.mjs" <<'OBSERVER_CONTRACT'
import * as vm from "node:vm";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const source = execFileSync(process.execPath, [process.argv[2], "--remote-source"], { encoding: "utf8" }).replace('import * as fs from "node:fs";\n', "");
async function probe(scenario) {
  let clock = 0, output = "";
  const members = scenario === "missing" ? [1] : scenario === "multiple" ? [1,20,21,22] : [1,20,21];
  const fields = (pid) => ["S", pid === 1 ? 0 : pid === 20 ? 1 : 20, ...Array(17).fill(0), pid];
  const status = (pid) => `Uid:\t${(scenario === "uid" && pid === 21) || (scenario === "inituid" && pid === 1) ? 0 : 1001}\t1001\t1001\t1001\nGid:\t${scenario === "gid" && pid === 20 ? 0 : 1001}\t1001\t1001\t1001\nNoNewPrivs:\t${scenario === "nnp" && pid === 21 ? 0 : 1}\n` + ["CapInh","CapPrm","CapEff","CapBnd","CapAmb"].map((name) => `${name}:\t${pid === 20 && ((scenario === "caps" && name === "CapEff") || (scenario === "bnd" && name === "CapBnd")) ? "0000000000000001" : "0000000000000000"}\n`).join("");
  const fs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
    readdirSync: () => members.filter((pid) => scenario !== "dead" || clock < 250 || pid !== 21).map(String),
    readlinkSync: () => "/usr/bin/node",
    readFileSync: (file) => {
      const [, pidRaw, kind] = file.match(/^\/proc\/(\d+)\/(status|stat|cmdline)$/) ?? [];
      const pid = Number(pidRaw);
      if (!members.includes(pid)) throw new Error("Absent");
      if (kind === "status") return status(pid);
      if (kind === "stat") return `${pid} (node) ${fields(pid).join(" ")}`;
      if (kind === "cmdline") return `node\0${pid === 20 ? "/app/mcp-host/ops/desktop-supervisor.mjs" : pid >= 21 ? "/app/mcp-host/dist/main.js" : "/init"}\0`;
      throw new Error("UnexpectedRead");
    },
    openSync: () => { throw new Error("Absent"); },
  };
  await vm.runInNewContext(`(async () => { ${source} })()`, {
    fs, Buffer, performance: { now: () => clock },
    setTimeout: (resolve, delay) => { clock += delay; resolve(); },
    process: { stdout: { write: (text) => { output += text; } } },
  });
  return JSON.parse(output);
}
const live = await probe("live");
assert.equal(live.reason, "EntryObserved");
assert.equal(live.singleChildEntered, true);
assert.equal(live.windowCompleted, true);
assert.equal(live.last.children[0].ppid, live.last.supervisors[0].pid);
assert.equal((await probe("missing")).reason, "MissingSupervisorOrChild");
assert.equal((await probe("dead")).reason, "ChildExited");
assert.equal((await probe("multiple")).reason, "MultipleProcesses");
for (const scenario of ["uid","inituid","gid","nnp","caps","bnd"]) assert.equal((await probe(scenario)).reason, "ProcessPolicyMismatch");
OBSERVER_CONTRACT
then
  pass 'emitted observer reads real process lineage and kernel privileges before any entry result'
else
  fail 'emitted observer accepted absent/dead children or unsafe kernel privileges'
fi

exit "$FAIL"
