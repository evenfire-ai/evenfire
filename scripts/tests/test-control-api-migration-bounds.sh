#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
POLICY_FILE="$ROOT_DIR/control-api/src/migrations/migrationExecutionPolicy.json"
RUNNER_FILE="$ROOT_DIR/control-api/src/migrations/migrationRunner.ts"
INDEX_PLAN_FILE="$ROOT_DIR/control-api/src/migrations/pr1OnlineIndexPlan.ts"
DB_FILE="$ROOT_DIR/control-api/src/db.ts"
DEPLOY_FILE="$ROOT_DIR/deploy/scripts/run-control-api-db-migration.sh"
DEPLOY_POLICY_FILE="$ROOT_DIR/deploy/scripts/control-api-migration-execution-policy.json"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[ -f "$POLICY_FILE" ] || fail "canonical migration policy is missing"
[ -f "$RUNNER_FILE" ] || fail "bounded migration runner is missing"
[ -f "$INDEX_PLAN_FILE" ] || fail "PR1 online index plan is missing"
cmp -s "$POLICY_FILE" "$DEPLOY_POLICY_FILE" || \
  fail "deploy migration policy differs from the canonical control-api policy"

node - "$POLICY_FILE" <<'NODE'
const fs = require('node:fs')
const policy = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const expected = {
  lockTimeoutMs: 10000,
  ordinaryStatementTimeoutMs: 15000,
  onlineIndexStatementTimeoutMs: 120000,
  idleInTransactionTimeoutMs: 15000,
  jobActiveDeadlineSeconds: 300,
  clientWaitSeconds: 360,
  terminationProofSeconds: 60,
  backoffLimit: 2,
  ttlSecondsAfterFinished: 600,
}
if (JSON.stringify(policy) !== JSON.stringify(expected)) {
  throw new Error(`migration policy mismatch: ${JSON.stringify(policy)}`)
}
NODE

grep -q 'applyPendingPr1Migrations' "$DB_FILE" || \
  fail "PR1 migrations are not dispatched through the bounded runner"
grep -q 'CREATE INDEX CONCURRENTLY' "$INDEX_PLAN_FILE" || \
  fail "existing-table indexes are not prepared concurrently"

index_migrations='0130_user_access_foundation|0132_catalog_utf8_ordering'
index_count="$(grep -Ec "^    migrationVersion: '($index_migrations)'" "$INDEX_PLAN_FILE")"
[ "$index_count" = "25" ] || fail "expected 25 PR1 online indexes, found $index_count"

grep -q 'activeDeadlineSeconds' "$DEPLOY_FILE" || \
  fail "migration Job has no active deadline"
grep -q -- '--cascade=foreground' "$DEPLOY_FILE" || \
  fail "migration timeout does not use foreground deletion"
grep -q 'wait --for=delete' "$DEPLOY_FILE" && grep -q 'job-name=' "$DEPLOY_FILE" || \
  fail "migration timeout does not prove pod termination"
grep -q 'verify_active_job_identity' "$DEPLOY_FILE" || \
  fail "existing active migration Job identity is not verified"

fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT
overlay="$fixture_root/overlay"
mkdir -p "$overlay"
capture="$fixture_root/job.json"
log_file="$fixture_root/kubectl.log"

cat >"$fixture_root/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
mode="${TEST_MODE:?}"
capture="${TEST_JOB_CAPTURE:?}"
log_file="${TEST_KUBECTL_LOG:?}"
printf '%s\n' "$*" >>"$log_file"
if [[ "${1:-}" == --context=* ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata: {name: control-api, namespace: control-plane}
  - apiVersion: v1
    kind: ConfigMap
    metadata: {name: control-api-config, namespace: control-plane}
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata: {name: control-postgres-data, namespace: control-plane}
  - apiVersion: apps/v1
    kind: Deployment
    metadata: {name: control-postgres, namespace: control-plane}
  - apiVersion: v1
    kind: Service
    metadata: {name: control-postgres, namespace: control-plane}
  - apiVersion: apps/v1
    kind: Deployment
    metadata: {name: control-api, namespace: control-plane}
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:d34
              env: []
              envFrom: []
              resources: {}
              securityContext: {}
YAML
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "pvc" ]]; then exit 0; fi
if [[ "${1:-}" == "apply" || "${1:-}" == "rollout" ]]; then cat >/dev/null || true; exit 0; fi
if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then exit 0; fi
if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$mode" == active-* || "$mode" == queued-* || "$mode" == terminal-* ]]; then
    if [[ "$mode" == "active-status-error" && "$*" == *"-o json"* ]]; then exit 2; fi
    if [[ "$*" == *"-o json"* ]]; then cat "$capture"; exit 0; fi
    exit 0
  fi
  if [[ "$*" == *"-o json"* && -s "$capture" ]]; then
    cat "$capture"
    exit 0
  fi
  exit 1
fi
if [[ "${1:-}" == "create" ]]; then
  if [[ "$mode" == "create-race-mismatch" ]]; then
    cat >/dev/null
    printf 'Error from server (AlreadyExists): jobs.batch already exists\n' >&2
    exit 1
  fi
  cat >"$capture"
  exit 0
fi
if [[ "${1:-}" == "logs" ]]; then
  if [[ "$mode" == timeout-* ]]; then
    credential="fixture-${mode}"
    printf 'database=%s://user:%s@db/private token=%s\n' \
      'postgresql' "$credential" "$credential"
  fi
  exit 0
fi
if [[ "${1:-}" == "describe" ]]; then
  printf 'Authorization: Bearer super-secret password=also-secret\n'
  exit 0
fi
if [[ "${1:-}" == "delete" && "${2:-}" == "job" ]]; then
  if [[ "$mode" == "timeout-delete-fails" ]]; then exit 1; fi
  exit 0
fi
if [[ "${1:-}" == "wait" ]]; then
  if [[ "$*" == *"--for=condition=complete"* && "$mode" == timeout-* ]]; then exit 1; fi
  if [[ "$*" == *"--for=delete"* && "$mode" == timeout-cleanup-fails ]]; then exit 1; fi
  if [[ "$*" == *"--for=delete"* && "$mode" == timeout-job-wait-fails && "$*" == *"job/"* ]]; then exit 1; fi
  if [[ "$*" == *"--for=delete"* && "$mode" == timeout-shared-deadline && "$*" == *"job/"* ]]; then sleep 2; fi
  exit 0
fi
if [[ "${1:-}" == "exec" ]]; then
  sql="$(cat || true)"
  if [[ "$sql" == *"public.schema_migrations"* && "$sql" == *"has_table_privilege"* ]]; then
    printf 'f\n'
  elif [[ "$sql" == *"COUNT(*)"* ]]; then
    printf '0\n'
  else
    printf 't\n'
  fi
  exit 0
fi
exit 0
STUB
chmod +x "$fixture_root/kubectl"

run_fixture() {
  TEST_MODE="$1" TEST_JOB_CAPTURE="$capture" TEST_KUBECTL_LOG="$log_file" \
    PATH="$fixture_root:$PATH" CONTEXT=d34-context ALLOWED_CONTEXTS=d34-context \
    bash "$DEPLOY_FILE" --overlay "$overlay" 2>&1
}

expect_fixture_failure() {
  local description="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "$description unexpectedly succeeded"
  fi
  printf '%s' "$output"
}

run_fixture success >/dev/null
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  abort unless job.dig("spec", "activeDeadlineSeconds") == 300
  abort unless job.dig("spec", "backoffLimit") == 2
  abort unless job.dig("spec", "ttlSecondsAfterFinished") == 600
  abort unless job.dig("spec", "template", "spec", "restartPolicy") == "Never"
  annotations = job.dig("metadata", "annotations") || {}
  abort unless annotations.keys.sort == %w[
    clerum.io/migration-configuration-sha256 clerum.io/migration-policy-sha256
  ]
' "$capture" || fail "migration Job manifest does not match D34"

run_fixture active-matches >/dev/null || fail "matching active migration Job was not reused"
: >"$log_file"
run_fixture queued-matches >/dev/null || fail "matching queued migration Job was not reused"
grep -q 'wait --for=condition=complete.*job/control-api-db-migrate' "$log_file" || \
  fail "matching queued migration Job was not awaited"
if grep -Eq 'delete job control-api-db-migrate|create -f -' "$log_file"; then
  fail "matching queued migration Job was deleted or recreated"
fi
cp "$capture" "$fixture_root/mismatched.json"
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  job["metadata"]["annotations"]["clerum.io/migration-policy-sha256"] = "wrong"
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$fixture_root/mismatched.json"
mv "$capture" "$fixture_root/matched.json"
cp "$fixture_root/mismatched.json" "$capture"
if run_fixture active-mismatch >/dev/null; then
  fail "mismatched active migration Job was accepted"
fi
mv "$fixture_root/matched.json" "$capture"

cp "$capture" "$fixture_root/queued-mismatched.json"
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  job["metadata"]["annotations"]["clerum.io/migration-policy-sha256"] = "wrong"
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$fixture_root/queued-mismatched.json"
mv "$capture" "$fixture_root/queued-matched.json"
cp "$fixture_root/queued-mismatched.json" "$capture"
if run_fixture queued-mismatch >/dev/null; then
  fail "mismatched queued migration Job was accepted"
fi
mv "$fixture_root/queued-matched.json" "$capture"

cp "$capture" "$fixture_root/config-mismatched.json"
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  job["spec"]["template"]["spec"]["serviceAccountName"] = "wrong-service-account"
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$fixture_root/config-mismatched.json"
mv "$capture" "$fixture_root/config-matched.json"
cp "$fixture_root/config-mismatched.json" "$capture"
if run_fixture active-config-mismatch >/dev/null; then
  fail "active migration Job with forged configuration annotation was accepted"
fi
mv "$fixture_root/config-matched.json" "$capture"

cp "$capture" "$fixture_root/sidecar-mismatched.json"
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  sidecar = {"name" => "unexpected", "image" => "example/sidecar:latest"}
  job["spec"]["template"]["spec"]["containers"] << sidecar
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$fixture_root/sidecar-mismatched.json"
mv "$capture" "$fixture_root/sidecar-matched.json"
cp "$fixture_root/sidecar-mismatched.json" "$capture"
if run_fixture active-sidecar-mismatch >/dev/null; then
  fail "active migration Job with an unexpected sidecar was accepted"
fi
mv "$fixture_root/sidecar-matched.json" "$capture"

cp "$capture" "$fixture_root/jobspec-mismatched.json"
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  job["spec"]["parallelism"] = 2
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$fixture_root/jobspec-mismatched.json"
mv "$capture" "$fixture_root/jobspec-matched.json"
cp "$fixture_root/jobspec-mismatched.json" "$capture"
if run_fixture active-jobspec-mismatch >/dev/null; then
  fail "active migration Job with changed Job execution policy was accepted"
fi
mv "$fixture_root/jobspec-matched.json" "$capture"

# The API server does not preserve the key order of the submitted manifest, so
# the configuration identity must not depend on it. Reverse every object's
# keys (arrays keep their order) and the Job must still be reused; change one
# value under the same reordering and it must still be rejected.
reorder_job_keys() {
  ruby -rjson -e '
    reverse_keys = lambda do |value|
      case value
      when Hash then value.keys.reverse.each_with_object({}) { |k, acc| acc[k] = reverse_keys.call(value[k]) }
      when Array then value.map { |entry| reverse_keys.call(entry) }
      else value
      end
    end
    job = reverse_keys.call(JSON.parse(File.read(ARGV.fetch(0))))
    job["spec"]["template"]["spec"]["serviceAccountName"] = ARGV.fetch(1) unless ARGV.fetch(1).empty?
    File.write(ARGV.fetch(0), JSON.generate(job))
  ' "$1" "$2"
}
cp "$capture" "$fixture_root/reordered-matched.json"
cp "$capture" "$fixture_root/reordered.json"
reorder_job_keys "$fixture_root/reordered.json" ""
cmp -s "$fixture_root/reordered.json" "$fixture_root/reordered-matched.json" && \
  fail "key reordering fixture did not change the serialized Job"
cp "$fixture_root/reordered.json" "$capture"
run_fixture active-reordered-matches >/dev/null || \
  fail "active migration Job with reordered object keys was not reused"
cp "$fixture_root/reordered-matched.json" "$capture"
reorder_job_keys "$capture" "wrong-service-account"
if run_fixture active-reordered-mismatch >/dev/null; then
  fail "active migration Job with reordered keys and changed configuration was accepted"
fi
cp "$fixture_root/reordered-matched.json" "$capture"
# The digest sorts arrays; the direct contract comparison must keep their order.
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  env = job["spec"]["template"]["spec"]["containers"][0]["env"]
  abort("fixture needs at least two env entries") unless env.is_a?(Array) && env.length >= 2
  job["spec"]["template"]["spec"]["containers"][0]["env"] = env.reverse
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$capture" || fail "could not build the reordered env fixture"
if run_fixture active-env-order-mismatch >/dev/null; then
  fail "active migration Job with reordered env entries was accepted"
fi
mv "$fixture_root/reordered-matched.json" "$capture"

# The API server stores a defaulted Job, not the submitted manifest. These are the
# fields a Kubernetes v1.35.1 apiserver added or dropped for this Job under
# `create --dry-run=server` (T2 run1 on 92f6dc886 died on them): defaults are added
# and empty env values are omitted. The stored Job must still be reused; a
# non-default podReplacementPolicy must still be rejected.
server_default_job() {
  ruby -rjson -e '
    job = JSON.parse(File.read(ARGV.fetch(0)))
    spec = job["spec"]
    spec.merge!("completionMode" => "NonIndexed", "completions" => 1, "manualSelector" => false,
                "parallelism" => 1, "suspend" => false,
                "podReplacementPolicy" => ARGV.fetch(1))
    pod = spec["template"]["spec"]
    pod.merge!("dnsPolicy" => "ClusterFirst", "schedulerName" => "default-scheduler",
               "serviceAccount" => pod["serviceAccountName"], "terminationGracePeriodSeconds" => 30)
    pod["containers"].each do |container|
      container.merge!("terminationMessagePath" => "/dev/termination-log",
                       "terminationMessagePolicy" => "File")
      (container["env"] || []).each { |entry| entry.delete("value") if entry["value"] == "" }
    end
    File.write(ARGV.fetch(0), JSON.generate(job))
  ' "$1" "$2"
}
cp "$capture" "$fixture_root/server-default-matched.json"
server_default_job "$capture" "TerminatingOrFailed" || fail "could not build the server-defaulted fixture"
run_fixture active-server-defaulted-matches >/dev/null || \
  fail "active migration Job stored with API server defaults was not reused"
cp "$fixture_root/server-default-matched.json" "$capture"
server_default_job "$capture" "Failed" || fail "could not build the non-default fixture"
if run_fixture active-server-defaulted-mismatch >/dev/null; then
  fail "active migration Job with a non-default podReplacementPolicy was accepted"
fi
mv "$fixture_root/server-default-matched.json" "$capture"

status_output="$(expect_fixture_failure 'existing migration Job status check' \
  run_fixture active-status-error)"
[[ "$status_output" == *'could not determine existing migration Job status'* ]] || \
  fail "existing migration Job status error did not fail closed"

cp "$capture" "$fixture_root/race-mismatched.json"
ruby -rjson -e '
  job = JSON.parse(File.read(ARGV.fetch(0)))
  job["metadata"]["annotations"]["clerum.io/migration-configuration-sha256"] = "wrong"
  File.write(ARGV.fetch(0), JSON.generate(job))
' "$fixture_root/race-mismatched.json"
mv "$capture" "$fixture_root/race-matched.json"
cp "$fixture_root/race-mismatched.json" "$capture"
if run_fixture create-race-mismatch >/dev/null; then
  fail "concurrently created mismatched migration Job was accepted"
fi
mv "$fixture_root/race-matched.json" "$capture"

: >"$log_file"
timeout_output="$(expect_fixture_failure 'migration client timeout' \
  run_fixture timeout-cleanup-succeeds)"
grep -q 'delete job control-api-db-migrate.*--cascade=foreground.*--wait=false' "$log_file" || \
  fail "client timeout did not issue foreground Job deletion"
grep -Eq 'wait --for=delete --timeout=(59|60)s job/control-api-db-migrate' "$log_file" || \
  fail "client timeout did not bound Job termination proof"
grep -Eq 'wait --for=delete --timeout=(59|60)s pod -l job-name=control-api-db-migrate' "$log_file" || \
  fail "client timeout did not bound pod termination proof"
[[ "$timeout_output" == *'[REDACTED]'* ]] || fail "migration diagnostics were not redacted"
[[ "$timeout_output" != *'fixture-timeout-cleanup-succeeds'* ]] || \
  fail "migration diagnostics exposed a secret"

cleanup_output="$(expect_fixture_failure 'unproven migration cleanup' \
  run_fixture timeout-cleanup-fails)"
[[ "$cleanup_output" == *'cleanup could not prove Job and pod termination within 60s'* ]] || \
  fail "unproven migration Job cleanup did not fail distinctly"

delete_output="$(expect_fixture_failure 'failed migration Job delete' \
  run_fixture timeout-delete-fails)"
[[ "$delete_output" == *'cleanup could not prove Job and pod termination within 60s'* ]] || \
  fail "failed migration Job delete was masked"

job_wait_output="$(expect_fixture_failure 'failed migration Job deletion proof' \
  run_fixture timeout-job-wait-fails)"
[[ "$job_wait_output" == *'cleanup could not prove Job and pod termination within 60s'* ]] || \
  fail "failed migration Job deletion proof was masked"

: >"$log_file"
expect_fixture_failure 'shared migration cleanup deadline' \
  run_fixture timeout-shared-deadline >/dev/null 2>&1
job_timeout="$(sed -nE 's/.*--for=delete --timeout=([0-9]+)s job\/.*/\1/p' "$log_file" | tail -1)"
pod_timeout="$(sed -nE 's/.*--for=delete --timeout=([0-9]+)s pod .*/\1/p' "$log_file" | tail -1)"
[ -n "$job_timeout" ] && [ -n "$pod_timeout" ] && [ "$pod_timeout" -lt "$job_timeout" ] || \
  fail "Job and pod cleanup did not share one decreasing termination deadline"

if CONTEXT=d34-context ALLOWED_CONTEXTS=d34-context \
  bash "$DEPLOY_FILE" --overlay "$overlay" --timeout 359s >/dev/null 2>&1; then
  fail "client observation shorter than 360 seconds was accepted"
fi

printf 'PASS: control-api migration bounds contract\n'
