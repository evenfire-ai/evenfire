#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ACCESS_PROFILES_FILE="${SCRIPT_DIR}/control-api-runtime-access-profiles.tsv"
RUNTIME_SEQUENCE_ACCESS_PROFILES_FILE="${SCRIPT_DIR}/control-api-runtime-sequence-access-profiles.tsv"
MAINTENANCE_ACCESS_PROFILES_FILE="${SCRIPT_DIR}/trace-maintenance-runtime-access-profiles.tsv"
MAINTENANCE_SEQUENCE_ACCESS_PROFILES_FILE="${SCRIPT_DIR}/trace-maintenance-runtime-sequence-access-profiles.tsv"
MAINTENANCE_FUNCTION_ACCESS_PROFILES_FILE="${SCRIPT_DIR}/trace-maintenance-runtime-function-access-profiles.tsv"
WORKFLOW_RECIPES_ACCESS_PROFILES_FILE="${SCRIPT_DIR}/workflow-recipes-runtime-access-profiles.tsv"
CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ALLOWED_CONTEXTS="${ALLOWED_CONTEXTS:?set ALLOWED_CONTEXTS to an exact comma-separated context allowlist}"

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
  CONTEXT      Required target kubectl context
  ALLOWED_CONTEXTS
               Required exact comma-separated context allowlist
  GITHUB_RUN_ID / MIGRATION_JOB_SUFFIX
               Optional CI-specific suffix appended to the Job name to avoid
               collisions across concurrent deploy runs.
EOF
}

kctl() {
  kubectl --context="$CONTEXT" "$@"
}

log() {
  printf '[control-api-db-migrate] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

context_is_allowed() {
  local candidate
  local entries=()
  IFS=',' read -r -a entries <<<"$ALLOWED_CONTEXTS"
  for candidate in "${entries[@]}"; do
    if [ "$candidate" = "$CONTEXT" ]; then
      return 0
    fi
  done
  return 1
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
context_is_allowed || die "CONTEXT=$CONTEXT is not in ALLOWED_CONTEXTS"

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
      next if env["name"] == "CONTROL_API_PG_CONNECTION_STRING"
      skr = (env["valueFrom"] || {})["secretKeyRef"]
      refs << skr["name"] if skr && !skr.fetch("optional", false)
    end
    (container["envFrom"] || []).each do |env_from|
      sr = env_from["secretRef"]
      refs << sr["name"] if sr && !env_from.fetch("optional", sr.fetch("optional", false))
    end
    refs << "control-postgres"
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
    migration_env = container.fetch("env", []).reject { |env| env["name"] == "CONTROL_API_PG_CONNECTION_STRING" }

    postgres_secret = lambda do |name|
      {
        "name" => name,
        "valueFrom" => {
          "secretKeyRef" => { "name" => "control-postgres", "key" => name },
        },
      }
    end
    migration_env.concat([
      { "name" => "CONTROL_API_PG_CONNECTION_STRING", "value" => "" },
      {
        "name" => "CONTROL_API_MIGRATION_PG_HOST",
        "value" => "control-postgres.control-plane.svc.cluster.local",
      },
      { "name" => "CONTROL_API_MIGRATION_PG_PORT", "value" => "5432" },
      postgres_secret.call("POSTGRES_USER"),
      postgres_secret.call("POSTGRES_PASSWORD"),
      postgres_secret.call("POSTGRES_DB"),
    ])

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
                "env" => migration_env,
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

runtime_access_contract_values() {
  [ -f "$RUNTIME_ACCESS_PROFILES_FILE" ] || \
    die "runtime access profile file not found: $RUNTIME_ACCESS_PROFILES_FILE"

  awk -F '\t' '
    BEGIN { count = 0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF != 2 { exit 2 }
    $1 !~ /^[a-z][a-z0-9_]*$/ { exit 3 }
    $2 !~ /^(legacy_dml|upsert|append|read|none)$/ { exit 4 }
    seen[$1]++ { exit 5 }
    {
      count++
      printf "%s(\047%s\047, \047%s\047)", (count == 1 ? "" : ",\n"), $1, $2
    }
    END { if (count == 0) exit 6 }
  ' "$RUNTIME_ACCESS_PROFILES_FILE" || \
    die "runtime access profile file is malformed or contains duplicate relations: $RUNTIME_ACCESS_PROFILES_FILE"
}

runtime_sequence_access_contract_values() {
  [ -f "$RUNTIME_SEQUENCE_ACCESS_PROFILES_FILE" ] || \
    die "runtime sequence access profile file not found: $RUNTIME_SEQUENCE_ACCESS_PROFILES_FILE"

  awk -F '\t' '
    BEGIN { count = 0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF != 2 { exit 2 }
    $1 !~ /^[a-z][a-z0-9_]*$/ { exit 3 }
    $2 !~ /^(legacy_rw|consume)$/ { exit 4 }
    seen[$1]++ { exit 5 }
    {
      count++
      printf "%s(\047%s\047, \047%s\047)", (count == 1 ? "" : ",\n"), $1, $2
    }
    END { if (count == 0) exit 6 }
  ' "$RUNTIME_SEQUENCE_ACCESS_PROFILES_FILE" || \
    die "runtime sequence access profile file is malformed or contains duplicate sequences: $RUNTIME_SEQUENCE_ACCESS_PROFILES_FILE"
}

maintenance_access_contract_values() {
  [ -f "$MAINTENANCE_ACCESS_PROFILES_FILE" ] || \
    die "maintenance access profile file not found: $MAINTENANCE_ACCESS_PROFILES_FILE"

  awk -F '\t' '
    BEGIN { count = 0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF != 2 { exit 2 }
    $1 !~ /^[a-z][a-z0-9_]*$/ { exit 3 }
    $2 !~ /^(append|read)$/ { exit 4 }
    seen[$1]++ { exit 5 }
    {
      count++
      printf "%s(\047%s\047, \047%s\047)", (count == 1 ? "" : ",\n"), $1, $2
    }
    END { if (count == 0) exit 6 }
  ' "$MAINTENANCE_ACCESS_PROFILES_FILE" || \
    die "maintenance access profile file is malformed or contains duplicate relations: $MAINTENANCE_ACCESS_PROFILES_FILE"
}

maintenance_sequence_access_contract_values() {
  [ -f "$MAINTENANCE_SEQUENCE_ACCESS_PROFILES_FILE" ] || \
    die "maintenance sequence profile file not found: $MAINTENANCE_SEQUENCE_ACCESS_PROFILES_FILE"

  awk -F '\t' '
    BEGIN { count = 0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF != 2 { exit 2 }
    $1 !~ /^[a-z][a-z0-9_]*$/ { exit 3 }
    $2 != "consume" { exit 4 }
    seen[$1]++ { exit 5 }
    {
      count++
      printf "%s(\047%s\047, \047%s\047)", (count == 1 ? "" : ",\n"), $1, $2
    }
    END { if (count == 0) exit 6 }
  ' "$MAINTENANCE_SEQUENCE_ACCESS_PROFILES_FILE" || \
    die "maintenance sequence profile file is malformed or contains duplicate sequences: $MAINTENANCE_SEQUENCE_ACCESS_PROFILES_FILE"
}

maintenance_function_access_contract_values() {
  [ -f "$MAINTENANCE_FUNCTION_ACCESS_PROFILES_FILE" ] || \
    die "maintenance function profile file not found: $MAINTENANCE_FUNCTION_ACCESS_PROFILES_FILE"

  awk -F '\t' '
    BEGIN { count = 0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF != 2 { exit 2 }
    $1 !~ /^governed_trace_[a-z0-9_]*\([a-z0-9_,\[\]]*\)$/ { exit 3 }
    $2 !~ /^(execute|none)$/ { exit 4 }
    seen[$1]++ { exit 5 }
    {
      count++
      printf "%s(\047%s\047, \047%s\047)", (count == 1 ? "" : ",\n"), $1, $2
    }
    END { if (count == 0) exit 6 }
  ' "$MAINTENANCE_FUNCTION_ACCESS_PROFILES_FILE" || \
    die "maintenance function profile file is malformed or contains duplicate functions: $MAINTENANCE_FUNCTION_ACCESS_PROFILES_FILE"
}

workflow_recipes_access_contract_values() {
  [ -f "$WORKFLOW_RECIPES_ACCESS_PROFILES_FILE" ] || \
    die "workflow-recipes access profile file not found: $WORKFLOW_RECIPES_ACCESS_PROFILES_FILE"

  awk -F '\t' '
    BEGIN { count = 0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF != 2 { exit 2 }
    $1 !~ /^[a-z][a-z0-9_]*$/ { exit 3 }
    $2 !~ /^(legacy_dml|read_update|upsert|delete)$/ { exit 4 }
    seen[$1]++ { exit 5 }
    {
      count++
      printf "%s(\047%s\047, \047%s\047)", (count == 1 ? "" : ",\n"), $1, $2
    }
    END { if (count == 0) exit 6 }
  ' "$WORKFLOW_RECIPES_ACCESS_PROFILES_FILE" || \
    die "workflow-recipes access profile file is malformed or contains duplicate relations: $WORKFLOW_RECIPES_ACCESS_PROFILES_FILE"
}

verify_runtime_access_contract() {
  local expected_values expected_sequence_values
  expected_values="$(runtime_access_contract_values)"
  expected_sequence_values="$(runtime_sequence_access_contract_values)"

  assert_db_query_equals \
    "control_api_runtime relation privileges differ from the explicit access contract" \
    "0" \
    "WITH expected_access(relation_name, access_profile) AS (
       VALUES ${expected_values}
     ),
     actual_relations AS (
       SELECT relation.oid, relation.relname AS relation_name
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm')
     ),
     relation_coverage_violations AS (
       SELECT COALESCE(expected.relation_name, actual.relation_name) AS relation_name
         FROM expected_access expected
         FULL OUTER JOIN actual_relations actual USING (relation_name)
        WHERE expected.relation_name IS NULL OR actual.relation_name IS NULL
     ),
     privilege_violations AS (
       SELECT expected.relation_name
         FROM expected_access expected
         JOIN actual_relations actual USING (relation_name)
         CROSS JOIN LATERAL (
           VALUES
             ('SELECT', expected.access_profile != 'none'),
             ('INSERT', expected.access_profile IN ('legacy_dml', 'upsert', 'append')),
             ('UPDATE', expected.access_profile IN ('legacy_dml', 'upsert')),
             ('DELETE', expected.access_profile = 'legacy_dml'),
             ('TRUNCATE', false),
             ('REFERENCES', false),
             ('TRIGGER', false)
         ) required(privilege_name, allowed)
        WHERE has_table_privilege(
                'control_api_runtime',
                actual.oid,
                required.privilege_name
              ) IS DISTINCT FROM required.allowed
     )
     SELECT
       (SELECT COUNT(*) FROM relation_coverage_violations)
       + (SELECT COUNT(*) FROM privilege_violations);"

  assert_db_query_equals \
    "control_api_runtime sequence privileges differ from the explicit access contract" \
    "0" \
    "WITH expected_access(sequence_name, access_profile) AS (
       VALUES ${expected_sequence_values}
     ),
     actual_sequences AS (
       SELECT sequence.oid, sequence.relname AS sequence_name
         FROM pg_class sequence
         JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
        WHERE namespace.nspname = 'public'
          AND sequence.relkind = 'S'
     ),
     sequence_coverage_violations AS (
       SELECT COALESCE(expected.sequence_name, actual.sequence_name) AS sequence_name
         FROM expected_access expected
         FULL OUTER JOIN actual_sequences actual USING (sequence_name)
        WHERE expected.sequence_name IS NULL OR actual.sequence_name IS NULL
     ),
     privilege_violations AS (
       SELECT expected.sequence_name
         FROM expected_access expected
         JOIN actual_sequences actual USING (sequence_name)
         CROSS JOIN LATERAL (
           VALUES
             ('USAGE', true),
             ('SELECT', true),
             ('UPDATE', expected.access_profile = 'legacy_rw')
         ) required(privilege_name, allowed)
        WHERE has_sequence_privilege(
                'control_api_runtime',
                actual.oid,
                required.privilege_name
              ) IS DISTINCT FROM required.allowed
     )
     SELECT
       (SELECT COUNT(*) FROM sequence_coverage_violations)
       + (SELECT COUNT(*) FROM privilege_violations);"
}

verify_trace_maintenance_access_contract() {
  local expected_values expected_sequence_values expected_function_values
  expected_values="$(maintenance_access_contract_values)"
  expected_sequence_values="$(maintenance_sequence_access_contract_values)"
  expected_function_values="$(maintenance_function_access_contract_values)"

  assert_db_query_equals \
    "trace_maintenance_runtime relation privileges differ from the explicit access contract" \
    "0" \
    "WITH expected_access(relation_name, access_profile) AS (
       VALUES ${expected_values}
     ),
     actual_relations AS (
       SELECT relation.oid, relation.relname AS relation_name
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm')
     ),
     relation_coverage_violations AS (
       SELECT expected.relation_name
         FROM expected_access expected
         LEFT JOIN actual_relations actual USING (relation_name)
        WHERE actual.relation_name IS NULL
     ),
     privilege_violations AS (
       SELECT actual.relation_name
         FROM actual_relations actual
         LEFT JOIN expected_access expected USING (relation_name)
         CROSS JOIN LATERAL (
           VALUES
             ('SELECT', COALESCE(expected.access_profile IN ('append', 'read'), false)),
             ('INSERT', COALESCE(expected.access_profile = 'append', false)),
             ('UPDATE', false),
             ('DELETE', false),
             ('TRUNCATE', false),
             ('REFERENCES', false),
             ('TRIGGER', false)
         ) required(privilege_name, allowed)
        WHERE has_table_privilege(
                'trace_maintenance_runtime',
                actual.oid,
                required.privilege_name
              ) IS DISTINCT FROM required.allowed
     )
     SELECT
       (SELECT COUNT(*) FROM relation_coverage_violations)
       + (SELECT COUNT(*) FROM privilege_violations);"

  assert_db_query_equals \
    "trace_maintenance_runtime sequence privileges differ from the explicit access contract" \
    "0" \
    "WITH expected_access(sequence_name, access_profile) AS (
       VALUES ${expected_sequence_values}
     ),
     actual_sequences AS (
       SELECT sequence.oid, sequence.relname AS sequence_name
         FROM pg_class sequence
         JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
        WHERE namespace.nspname = 'public'
          AND sequence.relkind = 'S'
     ),
     sequence_coverage_violations AS (
       SELECT expected.sequence_name
         FROM expected_access expected
         LEFT JOIN actual_sequences actual USING (sequence_name)
        WHERE actual.sequence_name IS NULL
     ),
     privilege_violations AS (
       SELECT actual.sequence_name
         FROM actual_sequences actual
         LEFT JOIN expected_access expected USING (sequence_name)
         CROSS JOIN LATERAL (
           VALUES
             ('USAGE', COALESCE(expected.access_profile = 'consume', false)),
             ('SELECT', COALESCE(expected.access_profile = 'consume', false)),
             ('UPDATE', false)
         ) required(privilege_name, allowed)
        WHERE has_sequence_privilege(
                'trace_maintenance_runtime',
                actual.oid,
                required.privilege_name
              ) IS DISTINCT FROM required.allowed
     )
     SELECT
       (SELECT COUNT(*) FROM sequence_coverage_violations)
       + (SELECT COUNT(*) FROM privilege_violations);"

  assert_db_query_equals \
    "trace_maintenance_runtime governed function privileges differ from the explicit access contract" \
    "0" \
    "WITH expected_access(function_signature, access_profile) AS (
       VALUES ${expected_function_values}
     ),
     actual_functions AS (
       SELECT routine.oid, routine.oid::regprocedure::text AS function_signature
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'public'
          AND routine.proname LIKE 'governed_trace_%'
     ),
     function_coverage_violations AS (
       SELECT COALESCE(expected.function_signature, actual.function_signature) AS function_signature
         FROM expected_access expected
         FULL OUTER JOIN actual_functions actual USING (function_signature)
        WHERE expected.function_signature IS NULL OR actual.function_signature IS NULL
     ),
     privilege_violations AS (
       SELECT actual.function_signature
         FROM actual_functions actual
         LEFT JOIN expected_access expected USING (function_signature)
        WHERE has_function_privilege(
                'trace_maintenance_runtime',
                actual.oid,
                'EXECUTE'
              ) IS DISTINCT FROM COALESCE(expected.access_profile = 'execute', false)
     )
     SELECT
       (SELECT COUNT(*) FROM function_coverage_violations)
       + (SELECT COUNT(*) FROM privilege_violations);"
}

verify_workflow_recipes_runtime_boundary() {
  local expected_values
  expected_values="$(workflow_recipes_access_contract_values)"

  assert_db_query_equals \
    "workflow_recipes_runtime relation privileges differ from the explicit access contract" \
    "0" \
    "WITH expected_access(relation_name, access_profile) AS (
       VALUES ${expected_values}
     ),
     actual_relations AS (
       SELECT relation.oid, relation.relname AS relation_name
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm')
     ),
     relation_coverage_violations AS (
       SELECT expected.relation_name
         FROM expected_access expected
         LEFT JOIN actual_relations actual USING (relation_name)
        WHERE actual.relation_name IS NULL
     ),
     privilege_violations AS (
       SELECT actual.relation_name
         FROM actual_relations actual
         LEFT JOIN expected_access expected USING (relation_name)
         CROSS JOIN LATERAL (
           VALUES
             ('SELECT', COALESCE(expected.access_profile IN ('legacy_dml', 'read_update', 'upsert'), false)),
             ('INSERT', COALESCE(expected.access_profile IN ('legacy_dml', 'upsert'), false)),
             ('UPDATE', COALESCE(expected.access_profile IN ('legacy_dml', 'read_update', 'upsert'), false)),
             ('DELETE', COALESCE(expected.access_profile IN ('legacy_dml', 'delete'), false)),
             ('TRUNCATE', false),
             ('REFERENCES', false),
             ('TRIGGER', false)
         ) required(privilege_name, allowed)
        WHERE has_table_privilege(
                'workflow_recipes_runtime',
                actual.oid,
                required.privilege_name
              ) IS DISTINCT FROM required.allowed
     )
     SELECT
       (SELECT COUNT(*) FROM relation_coverage_violations)
       + (SELECT COUNT(*) FROM privilege_violations);"

  assert_db_query_equals \
    "workflow_recipes_runtime sequence privileges differ from the explicit access contract" \
    "0" \
    "SELECT COUNT(*)
       FROM pg_class sequence
       JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
      WHERE namespace.nspname = 'public'
        AND sequence.relkind = 'S'
        AND (
          has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'USAGE')
          OR has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'SELECT')
          OR has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'UPDATE')
        );"

  assert_db_query_equals \
    "workflow_recipes_runtime governed function privileges differ from the explicit access contract" \
    "0" \
    "SELECT COUNT(*)
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND routine.proname LIKE 'governed_trace_%'
        AND has_function_privilege('workflow_recipes_runtime', routine.oid, 'EXECUTE');"
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
    "governed trace schema foundation migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0061_governed_run_trace_schema_foundation');"

  assert_db_query_true \
    "governed trace runtime-role migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0062_governed_trace_runtime_roles');"

  assert_db_query_true \
    "workflow approval trace binding migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0063_workflow_approval_trace_binding');"

  assert_db_query_true \
    "agent decision source catalog migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0064_agent_decision_source_catalog');"

  assert_db_query_true \
    "governed session replay and prompt-history migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0065_governed_session_replay_and_prompt_history');"

  assert_db_query_true \
    "governed trace target-principal projection migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0066_governed_trace_target_principal_projection');"

  assert_db_query_true \
    "LLM runtime access profile migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0067_llm_runtime_access_profiles');"

  assert_db_query_true \
    "member-registration runtime DELETE revoke migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0070_member_registration_runtime_delete_revoke');"

  assert_db_query_true \
    "governed_event_stream.tenant_id is missing or incompatible after the tracing migrations" \
    "SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'governed_event_stream'
          AND column_name = 'tenant_id'
          AND data_type = 'text'
          AND is_nullable = 'YES'
          AND column_default IS NULL
     );"

  assert_db_query_true \
    "administrative_events unexpectedly duplicates canonical tenant attribution" \
    "SELECT NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'administrative_events'
          AND column_name = 'tenant_id'
     );"

  assert_db_query_true \
    "governed event stream family identity is not unique" \
    "SELECT EXISTS (
       SELECT 1
         FROM pg_constraint relation_constraint
        WHERE relation_constraint.conrelid = 'public.governed_event_stream'::regclass
          AND relation_constraint.contype = 'u'
          AND relation_constraint.conkey = ARRAY[
            (SELECT attnum
               FROM pg_attribute
              WHERE attrelid = relation_constraint.conrelid
                AND attname = 'event_family'),
            (SELECT attnum
               FROM pg_attribute
              WHERE attrelid = relation_constraint.conrelid
                AND attname = 'event_id')
          ]::smallint[]
     );"

  assert_db_query_true \
    "administrative event stream integrity triggers are missing or disabled" \
    "SELECT EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgrelid = 'public.administrative_events'::regclass
          AND tgname = 'governed_administrative_event_stream_integrity'
          AND tgenabled = 'O'
          AND tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure
          AND tgconstraint <> 0
          AND tgdeferrable
          AND tginitdeferred
          AND tgtype = 13
     ) AND EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgrelid = 'public.governed_event_stream'::regclass
          AND tgname = 'governed_event_stream_family_integrity'
          AND tgenabled = 'O'
          AND tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure
          AND tgconstraint <> 0
          AND tgdeferrable
          AND tginitdeferred
          AND tgtype = 13
     );"

  assert_db_query_true \
    "workflow completion notification refresh migration was not recorded" \
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0054_workflow_run_completed_notification_download_detection');"

  assert_db_query_equals \
    "control_api_runtime can mutate schema_migrations" \
    "f" \
    "SELECT has_table_privilege('control_api_runtime', 'public.schema_migrations', 'INSERT')
         OR has_table_privilege('control_api_runtime', 'public.schema_migrations', 'UPDATE')
         OR has_table_privilege('control_api_runtime', 'public.schema_migrations', 'DELETE')
         OR has_table_privilege('control_api_runtime', 'public.schema_migrations', 'TRUNCATE');"

  # Every public relation must be classified explicitly. The gate rejects both
  # missing privileges and broader privileges than the selected profile.
  verify_runtime_access_contract
  verify_trace_maintenance_access_contract
  verify_workflow_recipes_runtime_boundary

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
log "Runtime role Secrets must contain connection-string before control-api and trace-maintenance rollout"
