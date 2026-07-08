#!/usr/bin/env bash
set -euo pipefail

# Runs the control-api schema bootstrap as an explicit Kubernetes Job before the
# rest of the overlay rolls out. The Job reuses the rendered control-api image
# + env wiring, so the same code that owns the schema (`control-api/src/db.ts`)
# performs the migration with the same runtime config it will use in production.
#
# Guarantees added by this script:
#   1. The deploy blocks until DB migration succeeds.
#   2. Migration uses the target control-api image (after overlay tag bumps).
#   3. The migration pod is labeled `app=control-api`, so existing NetworkPolicy
#      rules for control-api ↔ control-postgres still apply.

usage() {
  cat <<'EOF'
Usage:
  deploy/scripts/run-control-api-db-migration.sh --overlay <path> [--job-name <name>] [--timeout <duration>]

Options:
  --overlay    Kustomize overlay directory (required)
  --job-name   Kubernetes Job name (default: control-api-db-migrate)
  --timeout    kubectl wait timeout (default: 300s)

Environment:
  CONTEXT      Optional kubectl context
  GITHUB_RUN_ID / MIGRATION_JOB_SUFFIX
               Optional CI-specific suffix appended to the Job name to avoid
               collisions across concurrent deploy runs.
EOF
}

kctl() {
  if [ -n "${CONTEXT:-}" ]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

log() {
  printf '[control-api-db-migrate] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

sanitize_job_suffix() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr '[:upper:]_' '[:lower:]-' \
    | tr -cd 'a-z0-9-' \
    | sed -E 's/^-+//; s/-+$//; s/-+/-/g' \
    | cut -c1-20
}

build_effective_job_name() {
  local base_name="$1"
  local suffix_source="${MIGRATION_JOB_SUFFIX:-${GITHUB_RUN_ID:-}}"
  local effective_name="$base_name"
  if [ -n "$suffix_source" ]; then
    local cleaned_suffix
    cleaned_suffix="$(sanitize_job_suffix "$suffix_source")"
    if [ -n "$cleaned_suffix" ]; then
      effective_name="${base_name}-${cleaned_suffix}"
    fi
  fi
  printf '%.63s' "$effective_name"
}

job_exists() {
  kctl get job "$JOB_NAME" -n control-plane >/dev/null 2>&1
}

job_is_active() {
  local active_count
  active_count="$(kctl get job "$JOB_NAME" -n control-plane -o 'jsonpath={.status.active}' 2>/dev/null || true)"
  [ -n "$active_count" ] && [ "$active_count" != "0" ]
}

create_job() {
  local output status
  set +e
  output="$({ JOB_NAME="$JOB_NAME" build_job_manifest | kctl create -f -; } 2>&1)"
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    [ -n "$output" ] && printf '%s\n' "$output" >&2
    return 0
  fi

  if [[ "$output" == *"AlreadyExists"* ]]; then
    log "Migration job $JOB_NAME was created concurrently; waiting for the existing job"
    return 0
  fi

  [ -n "$output" ] && printf '%s\n' "$output" >&2
  return "$status"
}

OVERLAY=""
JOB_NAME="${JOB_NAME:-control-api-db-migrate}"
TIMEOUT="${TIMEOUT:-300s}"

while [ $# -gt 0 ]; do
  case "$1" in
    --overlay)
      OVERLAY="${2:-}"
      shift 2
      ;;
    --job-name)
      JOB_NAME="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$OVERLAY" ] || {
  usage >&2
  exit 1
}
[ -d "$OVERLAY" ] || die "overlay directory not found: $OVERLAY"

JOB_NAME="$(build_effective_job_name "$JOB_NAME")"

RENDERED_MANIFEST_FILE="$(mktemp)"
cleanup() {
  rm -f "$RENDERED_MANIFEST_FILE"
}
trap cleanup EXIT

kubectl kustomize "$OVERLAY" >"$RENDERED_MANIFEST_FILE"

extract_prereqs_by_mode() {
  local mode="$1"
  ruby -ryaml -rjson -e '
    mode = ARGV[1]
    targets = [
      ["ServiceAccount", "control-plane", "control-api"],
      ["ConfigMap", "control-plane", "control-api-config"],
      ["PersistentVolumeClaim", "control-plane", "control-postgres-data"],
      ["Deployment", "control-plane", "control-postgres"],
      ["Service", "control-plane", "control-postgres"],
    ]
    docs = []
    YAML.load_stream(File.read(ARGV[0])) do |doc|
      next unless doc.is_a?(Hash)
      if doc["kind"] == "List" && doc["items"].is_a?(Array)
        doc["items"].each { |item| docs << item if item.is_a?(Hash) }
      else
        docs << doc
      end
    end
    selected = docs.select do |item|
      meta = item["metadata"] || {}
      key = [item["kind"], meta["namespace"], meta["name"]]
      next false unless targets.include?(key)
      if mode == "pvc-only"
        item["kind"] == "PersistentVolumeClaim"
      else
        item["kind"] != "PersistentVolumeClaim"
      end
    end
    puts JSON.generate({"apiVersion" => "v1", "kind" => "List", "items" => selected})
  ' "$RENDERED_MANIFEST_FILE" "$mode"
}

extract_prereqs() {
  extract_prereqs_by_mode "non-pvc"
}

extract_pvc_prereq() {
  extract_prereqs_by_mode "pvc-only"
}

ensure_postgres_pvc() {
  local pvc_name="control-postgres-data"
  local pvc_manifest

  pvc_manifest="$(extract_pvc_prereq)"
  if [[ "$pvc_manifest" != *'"PersistentVolumeClaim"'* ]]; then
    die "control-postgres PVC manifest was not found in rendered overlay"
  fi

  if kctl get pvc "$pvc_name" -n control-plane >/dev/null 2>&1; then
    log "Reusing existing PVC control-plane/$pvc_name"
    return 0
  fi

  log "Creating PVC control-plane/$pvc_name"
  if ! printf '%s' "$pvc_manifest" | kctl create -f -; then
    if kctl get pvc "$pvc_name" -n control-plane >/dev/null 2>&1; then
      log "PVC control-plane/$pvc_name was created concurrently; reusing existing claim"
      return 0
    fi
    die "failed to create PVC control-plane/$pvc_name"
  fi
}

extract_secret_refs() {
  ruby -ryaml -e '
    docs = []
    YAML.load_stream(File.read(ARGV[0])) do |doc|
      next unless doc.is_a?(Hash)
      if doc["kind"] == "List" && doc["items"].is_a?(Array)
        doc["items"].each { |item| docs << item if item.is_a?(Hash) }
      else
        docs << doc
      end
    end
    target = docs.find do |doc|
      next false unless doc["kind"] == "Deployment"
      meta = doc["metadata"] || {}
      meta["namespace"] == "control-plane" && meta["name"] == "control-api"
    end
    abort("control-api Deployment not found in rendered overlay") unless target
    containers = target.dig("spec", "template", "spec", "containers") || []
    container = containers.find { |c| c["name"] == "control-api" }
    abort("control-api container not found in rendered Deployment") unless container
    refs = []
    (container["env"] || []).each do |env|
      skr = (env["valueFrom"] || {})["secretKeyRef"]
      refs << skr["name"] if skr && !skr.fetch("optional", false)
    end
    (container["envFrom"] || []).each do |env_from|
      sr = env_from["secretRef"]
      refs << sr["name"] if sr && !env_from.fetch("optional", sr.fetch("optional", false))
    end
    refs.uniq.sort.each { |name| puts name }
  ' "$RENDERED_MANIFEST_FILE"
}

extract_control_api_image() {
  ruby -ryaml -e '
    docs = []
    YAML.load_stream(File.read(ARGV[0])) do |doc|
      next unless doc.is_a?(Hash)
      if doc["kind"] == "List" && doc["items"].is_a?(Array)
        doc["items"].each { |item| docs << item if item.is_a?(Hash) }
      else
        docs << doc
      end
    end
    docs.each do |doc|
      next unless doc["kind"] == "Deployment"
      meta = doc["metadata"] || {}
      next unless meta["namespace"] == "control-plane" && meta["name"] == "control-api"
      containers = doc.dig("spec", "template", "spec", "containers") || []
      target = containers.find { |c| c["name"] == "control-api" }
      if target && target["image"]
        puts target["image"]
        exit 0
      end
    end
    abort("control-api container image not found in rendered overlay")
  ' "$RENDERED_MANIFEST_FILE"
}

build_job_manifest() {
  ruby -ryaml -rjson -e '
    job_name = ENV.fetch("JOB_NAME")
    docs = []
    YAML.load_stream(File.read(ARGV[0])) do |doc|
      next unless doc.is_a?(Hash)
      if doc["kind"] == "List" && doc["items"].is_a?(Array)
        doc["items"].each { |item| docs << item if item.is_a?(Hash) }
      else
        docs << doc
      end
    end
    target = docs.find do |doc|
      next false unless doc["kind"] == "Deployment"
      meta = doc["metadata"] || {}
      meta["namespace"] == "control-plane" && meta["name"] == "control-api"
    end
    abort("control-api Deployment not found in rendered overlay") unless target

    tpl = target.dig("spec", "template") || {}
    pod_spec = tpl["spec"] || {}
    container = (pod_spec["containers"] || []).find { |c| c["name"] == "control-api" }
    abort("control-api container not found in rendered Deployment") unless container

    job = {
      "apiVersion" => "batch/v1",
      "kind" => "Job",
      "metadata" => {
        "name" => job_name,
        "namespace" => "control-plane",
        "labels" => {
          "app" => "control-api",
          "clerum.io/component" => "control-api-db-migrate",
        },
      },
      "spec" => {
        "backoffLimit" => 0,
        "ttlSecondsAfterFinished" => 600,
        "template" => {
          "metadata" => {
            "labels" => {
              "app" => "control-api",
              "clerum.io/component" => "control-api-db-migrate",
            },
          },
          "spec" => {
            "restartPolicy" => "Never",
            "serviceAccountName" => pod_spec["serviceAccountName"],
            "containers" => [
              {
                "name" => "migrate",
                "image" => container["image"],
                "imagePullPolicy" => container.fetch("imagePullPolicy", "IfNotPresent"),
                "command" => ["node", "dist/migrate.js"],
                "env" => container.fetch("env", []),
                "envFrom" => container.fetch("envFrom", []),
                "resources" => container["resources"],
                "securityContext" => container["securityContext"],
              },
            ],
          },
        },
      },
    }

    %w[imagePullSecrets nodeSelector affinity tolerations topologySpreadConstraints priorityClassName securityContext].each do |key|
      value = pod_spec[key]
      job["spec"]["template"]["spec"][key] = value if value
    end

    puts JSON.generate(job)
  ' "$RENDERED_MANIFEST_FILE"
}

db_query() {
  local sql="$1"
  kctl exec -i deployment/control-postgres -n control-plane -- \
    sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<<"$sql"
}

assert_db_query_true() {
  local description="$1"
  local sql="$2"
  local out
  out="$(db_query "$sql")"
  if [[ "$out" != "t" ]]; then
    die "${description} (expected true, got '${out:-<empty>}')"
  fi
}

assert_db_query_has_row() {
  local description="$1"
  local sql="$2"
  local out
  out="$(db_query "$sql")"
  if [[ -z "$out" ]]; then
    die "${description} (query returned no rows)"
  fi
}

assert_db_query_equals() {
  local description="$1"
  local expected="$2"
  local sql="$3"
  local out
  out="$(db_query "$sql")"
  if [[ "$out" != "$expected" ]]; then
    die "${description} (expected ${expected}, got '${out:-<empty>}')"
  fi
}

verify_db_migration_state() {
  log "Verifying DB-first schema in control-postgres"

  assert_db_query_true \
    "schema_migrations table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations');"

  assert_db_query_true \
    "baseline migration 0001_control_api_baseline was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0001_control_api_baseline');"

  assert_db_query_true \
    "follow-up migration 0002_workflow_runs_audit_recipe_triggered_at_index was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0002_workflow_runs_audit_recipe_triggered_at_index');"

  assert_db_query_true \
    "Phase 0 migration 0016_workflow_trigger_shared_foundation was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0016_workflow_trigger_shared_foundation');"

  assert_db_query_true \
    "workflow trigger run-intent migration 0020_workflow_approval_trigger_run_intents was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0020_workflow_approval_trigger_run_intents');"

  assert_db_query_true \
    "workflow_runs table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_runs');"

  assert_db_query_true \
    "workflow_runs_audit table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_runs_audit');"

  assert_db_query_true \
    "workflow_schedules table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_schedules');"

  assert_db_query_true \
    "workflow_approval_trigger_intents table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_approval_trigger_intents');"

  assert_db_query_true \
    "workflow_approval_trigger_intents_archive table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_approval_trigger_intents_archive');"

  assert_db_query_true \
    "workflow_approval_trigger_run_intents table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_approval_trigger_run_intents');"

  assert_db_query_true \
    "workflow_approval_trigger_run_intents_archive table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_approval_trigger_run_intents_archive');"

  assert_db_query_true \
    "team_workflow_triggers table is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'team_workflow_triggers');"

  assert_db_query_true \
    "workflow_runs.ttl_seconds_after_finished is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workflow_runs' AND column_name = 'ttl_seconds_after_finished');"

  assert_db_query_true \
    "workflow_schedules.ttl_seconds_after_finished is missing after migration gate" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workflow_schedules' AND column_name = 'ttl_seconds_after_finished');"

  assert_db_query_has_row \
    "idx_workflow_runs_audit_recipe_triggered_at is missing after migration gate" \
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workflow_runs_audit' AND indexname = 'idx_workflow_runs_audit_recipe_triggered_at';"

  assert_db_query_has_row \
    "idx_wati_trigger is missing after migration gate" \
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workflow_approval_trigger_intents' AND indexname = 'idx_wati_trigger';"

  assert_db_query_has_row \
    "idx_watia_trigger is missing after migration gate" \
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workflow_approval_trigger_intents_archive' AND indexname = 'idx_watia_trigger';"

  assert_db_query_has_row \
    "idx_watri_idempotency is missing after migration gate" \
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workflow_approval_trigger_run_intents' AND indexname = 'idx_watri_idempotency';"

  assert_db_query_has_row \
    "idx_watria_idempotency is missing after migration gate" \
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workflow_approval_trigger_run_intents_archive' AND indexname = 'idx_watria_idempotency';"

  assert_db_query_has_row \
    "idx_team_workflow_triggers_recipe is missing after migration gate" \
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'team_workflow_triggers' AND indexname = 'idx_team_workflow_triggers_recipe';"

  assert_db_query_equals \
    "live trigger-bound approvals with malformed workflowTrigger metadata remain after migration gate" \
    "0" \
    "SELECT COUNT(*) FROM workflow_approval_requests war
      WHERE war.status IN ('pending', 'approved')
        AND war.payload->'metadata' ? 'workflowTrigger'
        AND NOT (
          jsonb_typeof(war.payload->'metadata'->'workflowTrigger') = 'object'
          AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger'->'namespace') = 'string'
          AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger'->'name') = 'string'
          AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger'->'caller') = 'string'
          AND btrim(war.payload->'metadata'->'workflowTrigger'->>'namespace') <> ''
          AND btrim(war.payload->'metadata'->'workflowTrigger'->>'name') <> ''
          AND btrim(war.payload->'metadata'->'workflowTrigger'->>'caller') <> ''
        );"

  assert_db_query_equals \
    "live valid trigger-bound approvals without typed intent remain after migration gate" \
    "0" \
    "SELECT COUNT(*) FROM workflow_approval_requests war
      WHERE war.status IN ('pending', 'approved')
        AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger') = 'object'
        AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger'->'namespace') = 'string'
        AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger'->'name') = 'string'
        AND jsonb_typeof(war.payload->'metadata'->'workflowTrigger'->'caller') = 'string'
        AND btrim(war.payload->'metadata'->'workflowTrigger'->>'namespace') <> ''
        AND btrim(war.payload->'metadata'->'workflowTrigger'->>'name') <> ''
        AND btrim(war.payload->'metadata'->'workflowTrigger'->>'caller') <> ''
        AND NOT EXISTS (
          SELECT 1
            FROM workflow_approval_trigger_intents wati
           WHERE wati.approval_request_id = war.id
        );"
}

CONTROL_API_IMAGE="$(extract_control_api_image)"
log "Applying migration prerequisites from $OVERLAY"
ensure_postgres_pvc
extract_prereqs | kctl apply -f -
log "Using control-api image for migration: $CONTROL_API_IMAGE"

log "Waiting for control-postgres to be available"
kctl rollout status deployment/control-postgres -n control-plane --timeout="$TIMEOUT"

for secret_name in $(extract_secret_refs); do
  if ! kctl get secret "$secret_name" -n control-plane >/dev/null 2>&1; then
    die "required Secret control-plane/$secret_name is missing; run the secrets/bootstrap step first"
  fi
done

if job_exists; then
  if job_is_active; then
    log "Migration job $JOB_NAME is already active; waiting for the existing run"
  else
    log "Deleting previous terminal migration job $JOB_NAME"
    kctl delete job "$JOB_NAME" -n control-plane --ignore-not-found >/dev/null 2>&1 || true
    log "Starting migration job $JOB_NAME"
    create_job
  fi
else
  log "Starting migration job $JOB_NAME"
  create_job
fi

if ! kctl wait --for=condition=complete --timeout="$TIMEOUT" "job/$JOB_NAME" -n control-plane; then
  job_logs=""
  job_logs="$(kctl logs "job/$JOB_NAME" -n control-plane --all-containers=true 2>&1 || true)"
  log "Migration job failed or timed out; dumping diagnostics"
  kctl describe job "$JOB_NAME" -n control-plane || true
  printf '%s\n' "$job_logs" >&2
  if [[ "$job_logs" == *"Cannot find module '/app/dist/migrate.js'"* ]]; then
    die "control-api image ${CONTROL_API_IMAGE} is missing dist/migrate.js; rebuild/push the current image and ensure deploy-dev resolves the correct sha tag before rerunning the gate"
  fi
  exit 1
fi

log "Migration job completed successfully"
kctl logs "job/$JOB_NAME" -n control-plane --all-containers=true || true
verify_db_migration_state
