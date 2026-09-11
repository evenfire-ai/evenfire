#!/usr/bin/env bash
# Regression coverage for strict profile readiness and startup reuse.

set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)"
READINESS="$ROOT/scripts/minikube/profile-readiness.sh"
START="$ROOT/scripts/minikube/start.sh"
TMP_ROOT="$(printenv TMPDIR || printf '/tmp')"
tmp="$(mktemp -d "$TMP_ROOT/evenfire-profile-readiness.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

healthy_text=$'host: Running\nkubelet: Running\napiserver: Running\nkubeconfig: Configured'
healthy_json='{"Name":"profile","Host":"Running","Kubelet":"Running","APIServer":"Running","Kubeconfig":"Configured"}'
partial_text=$'host: Running\nkubelet: Stopped\napiserver: Running\nkubeconfig: Configured'
stopped_text=$'host: Stopped\nkubelet: Stopped\napiserver: Stopped\nkubeconfig: Configured'

# The same predicate must accept the native text and JSON shapes, while a
# single stopped component must never qualify for profile reuse.
source "$READINESS"
minikube_profile_status_is_healthy "$healthy_text" || fail 'healthy text status was rejected'
minikube_profile_status_is_healthy "$healthy_json" || fail 'healthy JSON status was rejected'
if minikube_profile_status_is_healthy "$partial_text"; then
  fail 'partial profile status was accepted as healthy'
fi
minikube_profile_status_is_missing_or_stopped "$stopped_text" || fail 'stopped profile was not classified as stopped'

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/minikube" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'minikube %s\n' "$*" >>"$MINIKUBE_CALLS"

if [ "$#" -gt 0 ] && [ "$1" = "-p" ]; then
  shift 2
fi
command_name="$1"
case "$command_name" in
  status)
    if [ -f "$MINIKUBE_STARTED" ] || [ "$TEST_PROFILE_STATE" = healthy ]; then
      printf '%s\n' 'host: Running' 'kubelet: Running' 'apiserver: Running' 'kubeconfig: Configured'
      exit 0
    fi
    if [ "$TEST_PROFILE_STATE" = partial ]; then
      printf '%s\n' 'host: Running' 'kubelet: Stopped' 'apiserver: Running' 'kubeconfig: Configured'
    else
      printf '%s\n' 'host: Stopped' 'kubelet: Stopped' 'apiserver: Stopped' 'kubeconfig: Configured'
    fi
    exit 2
    ;;
  start)
    : >"$MINIKUBE_STARTED"
    ;;
  addons)
    ;;
  *)
    ;;
esac
EOF
cat >"$fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'kubectl %s\n' "$*" >>"$KUBECTL_CALLS"
case "$*" in
  *'get nodes --no-headers'*) printf '%s\n' 'minikube Ready' ;;
  *'get pods -l k8s-app=calico-node --no-headers'*) printf '%s\n' 'calico-node 1/1 Running' ;;
  *) ;;
esac
EOF
chmod +x "$fake_bin/minikube" "$fake_bin/kubectl"

run_start() {
  state="$1"
  output_file="$2"
  calls_file="$3"
  started_file="$4"
  : >"$calls_file"
  : >"$KUBECTL_CALLS"
  rm -f "$started_file"
  TEST_PROFILE_STATE="$state" \
    MINIKUBE_PROFILE=evenfire-readiness-test \
    MINIKUBE_CALLS="$calls_file" \
    MINIKUBE_STARTED="$started_file" \
    KUBECTL_CALLS="$KUBECTL_CALLS" \
    PATH="$fake_bin:$PATH" \
    bash "$START" >"$output_file"
}

healthy_output="$tmp/healthy.out"
healthy_calls="$tmp/healthy.minikube.calls"
healthy_started="$tmp/healthy.started"
KUBECTL_CALLS="$tmp/healthy.kubectl.calls"
run_start healthy "$healthy_output" "$healthy_calls" "$healthy_started"
grep -Fq 'MINIKUBE_PROFILE_ACTION=REUSED' "$healthy_output" || fail 'healthy profile was not reported as reused'
if grep -Eq '^minikube start ' "$healthy_calls"; then
  fail 'healthy profile still invoked minikube start'
fi

partial_output="$tmp/partial.out"
partial_calls="$tmp/partial.minikube.calls"
partial_started="$tmp/partial.started"
KUBECTL_CALLS="$tmp/partial.kubectl.calls"
run_start partial "$partial_output" "$partial_calls" "$partial_started"
grep -Fq 'MINIKUBE_PROFILE_ACTION=STARTED' "$partial_output" || fail 'partial profile was not repaired through startup'
grep -Eq '^minikube start ' "$partial_calls" || fail 'partial profile did not invoke minikube start'

healthy_start_calls="$(grep -cE '^minikube start ' "$healthy_calls" || true)"
partial_start_calls="$(grep -cE '^minikube start ' "$partial_calls" || true)"
printf 'METRIC evenfire_minikube_healthy_start_calls=%s\n' "$healthy_start_calls"
printf 'METRIC evenfire_minikube_partial_start_calls=%s\n' "$partial_start_calls"
printf 'PASS: strict profile readiness and healthy-profile startup reuse\n'
