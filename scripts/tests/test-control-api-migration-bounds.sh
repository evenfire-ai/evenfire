#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
POLICY_FILE="$ROOT_DIR/control-api/src/migrations/migrationExecutionPolicy.json"
RUNNER_FILE="$ROOT_DIR/control-api/src/migrations/migrationRunner.ts"
INDEX_PLAN_FILE="$ROOT_DIR/control-api/src/migrations/pr1OnlineIndexPlan.ts"
DB_FILE="$ROOT_DIR/control-api/src/db.ts"
DEPLOY_FILE="$ROOT_DIR/deploy/scripts/run-control-api-db-migration.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[ -f "$POLICY_FILE" ] || fail "canonical migration policy is missing"
[ -f "$RUNNER_FILE" ] || fail "bounded migration runner is missing"
[ -f "$INDEX_PLAN_FILE" ] || fail "PR1 online index plan is missing"

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

index_count="$(grep -c "^    migrationVersion: '010[79]_" "$INDEX_PLAN_FILE")"
[ "$index_count" = "25" ] || fail "expected 25 online indexes, found $index_count"

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
    printf 'database=postgresql://user:super-secret@db/private token=also-secret\n'
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

status_output="$(run_fixture active-status-error || true)"
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
timeout_output="$(run_fixture timeout-cleanup-succeeds || true)"
grep -q 'delete job control-api-db-migrate.*--cascade=foreground.*--wait=false' "$log_file" || \
  fail "client timeout did not issue foreground Job deletion"
grep -Eq 'wait --for=delete --timeout=(59|60)s job/control-api-db-migrate' "$log_file" || \
  fail "client timeout did not bound Job termination proof"
grep -Eq 'wait --for=delete --timeout=(59|60)s pod -l job-name=control-api-db-migrate' "$log_file" || \
  fail "client timeout did not bound pod termination proof"
[[ "$timeout_output" == *'[REDACTED]'* ]] || fail "migration diagnostics were not redacted"
[[ "$timeout_output" != *'super-secret'* && "$timeout_output" != *'also-secret'* ]] || \
  fail "migration diagnostics exposed a secret"

cleanup_output="$(run_fixture timeout-cleanup-fails || true)"
[[ "$cleanup_output" == *'cleanup could not prove Job and pod termination within 60s'* ]] || \
  fail "unproven migration Job cleanup did not fail distinctly"

delete_output="$(run_fixture timeout-delete-fails || true)"
[[ "$delete_output" == *'cleanup could not prove Job and pod termination within 60s'* ]] || \
  fail "failed migration Job delete was masked"

job_wait_output="$(run_fixture timeout-job-wait-fails || true)"
[[ "$job_wait_output" == *'cleanup could not prove Job and pod termination within 60s'* ]] || \
  fail "failed migration Job deletion proof was masked"

: >"$log_file"
run_fixture timeout-shared-deadline >/dev/null 2>&1 || true
job_timeout="$(sed -nE 's/.*--for=delete --timeout=([0-9]+)s job\/.*/\1/p' "$log_file" | tail -1)"
pod_timeout="$(sed -nE 's/.*--for=delete --timeout=([0-9]+)s pod .*/\1/p' "$log_file" | tail -1)"
[ -n "$job_timeout" ] && [ -n "$pod_timeout" ] && [ "$pod_timeout" -lt "$job_timeout" ] || \
  fail "Job and pod cleanup did not share one decreasing termination deadline"

if CONTEXT=d34-context ALLOWED_CONTEXTS=d34-context \
  bash "$DEPLOY_FILE" --overlay "$overlay" --timeout 359s >/dev/null 2>&1; then
  fail "client observation shorter than 360 seconds was accepted"
fi

printf 'PASS: control-api migration bounds contract\n'
