#!/usr/bin/env bash
set -u
FAIL=0

# DRY_RUN=1 mode: scripts should echo the gcloud command they'd run
# without executing it, and honor env var overrides.

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_setup_defaults_prod() {
  local out
  out="$(DRY_RUN=1 bash deploy/scripts/gcp-setup.sh 2>&1 || true)"
  if [[ "$out" == *"clerum"* ]] && [[ "$out" != *"example-dev"* ]] && [[ "$out" == *"e2-standard-8"* ]]; then
    pass "setup defaults target prod cluster"
  else
    fail "setup defaults wrong"
    echo "$out"
  fi
}

assert_setup_dev_overrides() {
  local out
  out="$(DRY_RUN=1 CLUSTER_NAME=example-dev MACHINE_TYPE=e2-standard-4 RELEASE_CHANNEL=regular \
         bash deploy/scripts/gcp-setup.sh 2>&1 || true)"
  if [[ "$out" == *"example-dev"* ]] && [[ "$out" == *"e2-standard-4"* ]] && [[ "$out" == *"regular"* ]]; then
    pass "setup honors env overrides"
  else
    fail "setup env overrides not wired"
    echo "$out"
  fi
}

assert_teardown_dev() {
  local out
  out="$(DRY_RUN=1 CLUSTER_NAME=example-dev SKIP_CONFIRM=yes \
         bash deploy/scripts/gcp-teardown.sh 2>&1 || true)"
  if [[ "$out" == *"example-dev"* ]] && [[ "$out" != *"Aborted"* ]]; then
    pass "teardown targets example-dev with SKIP_CONFIRM=yes"
  else
    fail "teardown env override not wired"
    echo "$out"
  fi
}

assert_detect_k8s_api_ip() {
  local tmp
  tmp="$(mktemp -d)"
  # Stub kubectl — always returns 10.96.0.1 (typical minikube/GKE internal)
  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
echo "10.96.0.1"
STUB
  chmod +x "$tmp/kubectl"

  # Work on a copy of an overlay so we don't corrupt the real file
  local overlay_dir="$tmp/overlay"
  mkdir -p "$overlay_dir/patches"
  cat > "$overlay_dir/patches/k8s-api-ip.yaml" <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-k8s-api-egress-control-plane
  namespace: control-plane
spec:
  egress:
    - to:
        - ipBlock:
            cidr: 203.0.113.1/32
      ports:
        - port: 443
          protocol: TCP
YAML

  PATH="$tmp:$PATH" OVERLAY_DIR="$overlay_dir" CONTEXT=fake-context \
    bash deploy/scripts/gcp-detect-k8s-api-ip.sh >/dev/null 2>&1

  if grep -q "cidr: 10.96.0.1/32" "$overlay_dir/patches/k8s-api-ip.yaml"; then
    pass "detect-k8s-api-ip patched overlay with stubbed IP"
  else
    fail "detect-k8s-api-ip did not patch overlay"
    cat "$overlay_dir/patches/k8s-api-ip.yaml"
  fi

  rm -rf "$tmp"
}

assert_bump_tag() {
  local tmp
  tmp="$(mktemp -d)"
  cat > "$tmp/kustomization.yaml" <<'YAML'
images:
  - name: clerum/mcp-host
    newName: us-central1-docker.pkg.dev/your-gcp-project/clerum/mcp-host-slim
    newTag: "sha-OLD"
  - name: clerum/rpc-proxy
    newName: us-central1-docker.pkg.dev/your-gcp-project/clerum/rpc-proxy
    newTag: "0.9.8"
YAML
  bash deploy/scripts/bump-image-tag.sh "$tmp" mcp-host sha-NEW >/dev/null 2>&1
  if grep -q 'newTag: "sha-NEW"' "$tmp/kustomization.yaml" && \
     grep -q 'newTag: "0.9.8"' "$tmp/kustomization.yaml"; then
    pass "bump-image-tag updates target image only"
  else
    fail "bump-image-tag didn't update correctly"
    cat "$tmp/kustomization.yaml"
  fi
  rm -rf "$tmp"
}

assert_apply_registry_secrets_patches_voucher_material() {
  local tmp log_file patch_file out
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"
  patch_file="$tmp/control-api-voucher-patch.json"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
PATCH_FILE="${TEST_PATCH_FILE:?}"
args="$*"
printf '%s\n' "$args" >>"$LOG_FILE"

if [[ "$args" == *" create secret generic registry-client-credentials "* ]]; then
  cat <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: registry-client-credentials
YAML
  exit 0
fi

if [[ "$args" == *" apply -f -"* ]]; then
  cat >/dev/null
  echo "secret/registry-client-credentials configured"
  exit 0
fi

if [[ "$args" == *" patch secret control-api-secrets "* ]]; then
  for arg in "$@"; do
    case "$arg" in
      --patch-file=*) cp "${arg#--patch-file=}" "$PATCH_FILE" ;;
    esac
  done
  echo "secret/control-api-secrets patched"
  exit 0
fi

echo "unexpected kubectl args: $args" >&2
exit 1
STUB
  chmod +x "$tmp/kubectl"
  printf '%s' 'test-private-key' >"$tmp/voucher.key"

  out="$(
    TEST_LOG_FILE="$log_file" \
      TEST_PATCH_FILE="$patch_file" \
      PATH="$tmp:$PATH" \
      CONTEXT=clerum-test \
      CLIENT_ID=test-client \
      CLIENT_SECRET=test-secret \
      CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE="$tmp/voucher.key" \
      CONTROL_API_REGISTRY_VOUCHER_KID=test-kid \
      bash scripts/apply-registry-secrets.sh 2>&1
  )"

  if jq -e \
    '.stringData.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY == "test-private-key" and
     .stringData.CONTROL_API_REGISTRY_VOUCHER_KID == "test-kid"' \
    "$patch_file" >/dev/null &&
    grep -q 'patch secret control-api-secrets' "$log_file"; then
    pass "apply-registry-secrets patches voucher key and kid"
  else
    fail "apply-registry-secrets did not patch voucher key and kid"
    echo "$out"
    cat "$log_file"
    cat "$patch_file" 2>/dev/null || true
  fi

  rm -rf "$tmp"
}

assert_db_migration_job_uses_ci_suffix() {
  local tmp overlay log_file
  tmp="$(mktemp -d)"
  overlay="$tmp/overlay"
  log_file="$tmp/kubectl.log"
  mkdir -p "$overlay"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
args="$*"
printf '%s\n' "$args" >>"$LOG_FILE"
if [[ "${1:-}" == "--context=fake-context" ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: control-api
      namespace: control-plane
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: control-api-config
      namespace: control-plane
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: control-postgres-data
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: v1
    kind: Service
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-api
      namespace: control-plane
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:test
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: control-api-secrets
                      key: DATABASE_URL
              envFrom: []
YAML
  exit 0
fi

if [[ "${1:-}" == "apply" && "$args" == *"--dry-run=client"* ]]; then
  cat >/dev/null || true
  exit 0
fi

if [[ "${1:-}" == "apply" ]]; then
  cat >/dev/null
  exit 0
fi

if [[ "${1:-}" == "rollout" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$args" == *"jsonpath={.status.active}"* ]]; then
    exit 1
  fi
  exit 1
fi

if [[ "${1:-}" == "delete" && "${2:-}" == "job" ]]; then
  exit 0
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  manifest="$(cat)"
  printf '%s\n' "$manifest" >>"$LOG_FILE"
  echo "job.batch/control-api-db-migrate created"
  exit 0
fi

if [[ "${1:-}" == "wait" || "${1:-}" == "logs" ]]; then
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  sql="$(cat || true)"
  printf 'SQL\n%s\n' "$sql" >>"$LOG_FILE"
  if [[ "$sql" == *"public.schema_migrations"* && "$sql" == *"has_table_privilege"* ]]; then
    echo "f"
  elif [[ "$sql" == *"COUNT(*)"* ]]; then
    echo "0"
  else
    echo "t"
  fi
  exit 0
fi

exit 0
STUB
  chmod +x "$tmp/kubectl"

  if TEST_LOG_FILE="$log_file" GITHUB_RUN_ID=123456 PATH="$tmp:$PATH" \
    CONTEXT=fake-context ALLOWED_CONTEXTS=fake-context \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay "$overlay" >/dev/null 2>&1; then
    if grep -q 'control-api-db-migrate-123456' "$log_file"; then
      pass "db migration job appends CI suffix to avoid name collisions"
    else
      fail "db migration job did not include CI suffix"
      cat "$log_file"
    fi
  else
    fail "db migration script failed in CI suffix test"
  fi

  rm -rf "$tmp"
}

assert_db_migration_handles_concurrent_create_race() {
  local tmp overlay log_file
  tmp="$(mktemp -d)"
  overlay="$tmp/overlay"
  log_file="$tmp/kubectl.log"
  mkdir -p "$overlay"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
args="$*"
printf '%s\n' "$args" >>"$LOG_FILE"
if [[ "${1:-}" == "--context=fake-context" ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: control-api
      namespace: control-plane
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: control-api-config
      namespace: control-plane
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: control-postgres-data
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: v1
    kind: Service
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-api
      namespace: control-plane
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:test
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: control-api-secrets
                      key: DATABASE_URL
              envFrom: []
YAML
  exit 0
fi

if [[ "${1:-}" == "apply" && "$args" == *"--dry-run=client"* ]]; then
  cat >/dev/null || true
  exit 0
fi

if [[ "${1:-}" == "apply" ]]; then
  cat >/dev/null
  exit 0
fi

if [[ "${1:-}" == "rollout" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$args" == *"jsonpath={.status.active}"* ]]; then
    exit 1
  fi
  exit 1
fi

if [[ "${1:-}" == "delete" && "${2:-}" == "job" ]]; then
  exit 0
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  cat >/dev/null
  echo 'Error from server (AlreadyExists): jobs.batch "control-api-db-migrate-999" already exists' >&2
  exit 1
fi

if [[ "${1:-}" == "wait" || "${1:-}" == "logs" ]]; then
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  sql="$(cat || true)"
  printf 'SQL\n%s\n' "$sql" >>"$LOG_FILE"
  if [[ "$sql" == *"public.schema_migrations"* && "$sql" == *"has_table_privilege"* ]]; then
    echo "f"
  elif [[ "$sql" == *"COUNT(*)"* ]]; then
    echo "0"
  else
    echo "t"
  fi
  exit 0
fi

exit 0
STUB
  chmod +x "$tmp/kubectl"

  if TEST_LOG_FILE="$log_file" GITHUB_RUN_ID=999 PATH="$tmp:$PATH" \
    CONTEXT=fake-context ALLOWED_CONTEXTS=fake-context \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay "$overlay" >/dev/null 2>&1; then
    if grep -q 'wait --for=condition=complete --timeout=300s job/control-api-db-migrate-999 -n control-plane' "$log_file"; then
      pass "db migration script tolerates concurrent create AlreadyExists race"
    else
      fail "db migration script did not wait for concurrently-created job"
      cat "$log_file"
    fi
  else
    fail "db migration script failed on concurrent create race"
  fi

  rm -rf "$tmp"
}

assert_bootstrap_rbac_includes_cluster_wide_manifests() {
  local tmp log_file out
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"
exit 0
STUB
  chmod +x "$tmp/kubectl"

  out="$(TEST_LOG_FILE="$log_file" PATH="$tmp:$PATH" CONTEXT=gke_your-gcp-project_us-central1-a_example-dev \
    bash deploy/scripts/bootstrap-rbac.sh 2>&1 || true)"

  if [[ "$out" == *"deploy/base/cluster-wide/clusterroles.yaml"* ]] && \
     [[ "$out" == *"deploy/base/cluster-wide/clusterrolebindings.yaml"* ]]; then
    pass "bootstrap-rbac includes cluster-wide RBAC manifests"
  else
    fail "bootstrap-rbac missed cluster-wide RBAC manifests"
    echo "$out"
  fi

  rm -rf "$tmp"
}

assert_db_migration_reports_missing_migrate_artifact() {
  local tmp overlay out
  tmp="$(mktemp -d)"
  overlay="$tmp/overlay"
  mkdir -p "$overlay"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "${1:-}" == "--context=fake-context" ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: control-api
      namespace: control-plane
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: control-api-config
      namespace: control-plane
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: control-postgres-data
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: v1
    kind: Service
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-api
      namespace: control-plane
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:broken
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: control-api-secrets
                      key: DATABASE_URL
              envFrom: []
YAML
  exit 0
fi

if [[ "${1:-}" == "apply" && "$args" == *"--dry-run=client"* ]]; then
  cat >/dev/null || true
  exit 0
fi

if [[ "${1:-}" == "apply" || "${1:-}" == "rollout" ]]; then
  cat >/dev/null || true
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$args" == *"jsonpath={.status.active}"* ]]; then
    exit 1
  fi
  exit 1
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  cat >/dev/null
  echo "job.batch/control-api-db-migrate created"
  exit 0
fi

if [[ "${1:-}" == "describe" ]]; then
  exit 0
fi

if [[ "${1:-}" == "wait" ]]; then
  exit 1
fi

if [[ "${1:-}" == "logs" ]]; then
  cat <<'LOG'
node:internal/modules/cjs/loader:1479
Error: Cannot find module '/app/dist/migrate.js'
LOG
  exit 0
fi

exit 0
STUB
  chmod +x "$tmp/kubectl"

  out="$(PATH="$tmp:$PATH" CONTEXT=fake-context ALLOWED_CONTEXTS=fake-context \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay "$overlay" 2>&1 || true)"
  if [[ "$out" == *"is missing dist/migrate.js"* ]] && [[ "$out" == *"example/control-api:broken"* ]]; then
    pass "db migration script emits a direct error for images missing dist/migrate.js"
  else
    fail "db migration script did not surface the missing dist/migrate.js root cause"
    echo "$out"
  fi

  rm -rf "$tmp"
}

assert_db_migration_verifies_db_after_success() {
  local tmp overlay log_file out
  tmp="$(mktemp -d)"
  overlay="$tmp/overlay"
  log_file="$tmp/kubectl.log"
  mkdir -p "$overlay"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
args="$*"
printf '%s\n' "$args" >>"$LOG_FILE"
if [[ "${1:-}" == "--context=fake-context" ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: control-api
      namespace: control-plane
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: control-api-config
      namespace: control-plane
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: control-postgres-data
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: v1
    kind: Service
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-api
      namespace: control-plane
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:test
              env:
                - name: CONTROL_API_PG_CONNECTION_STRING
                  valueFrom:
                    secretKeyRef:
                      name: control-api-postgres-runtime
                      key: connection-string
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: control-api-secrets
                      key: DATABASE_URL
              envFrom:
                - configMapRef:
                    name: control-api-config
YAML
  exit 0
fi

if [[ "${1:-}" == "apply" && "$args" == *"--dry-run=client"* ]]; then
  cat >/dev/null || true
  exit 0
fi

if [[ "${1:-}" == "apply" || "${1:-}" == "rollout" ]]; then
  cat >/dev/null || true
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$args" == *"jsonpath={.status.active}"* ]]; then
    exit 1
  fi
  exit 1
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  job_manifest="$(cat)"
  printf 'JOB_MANIFEST %s\n' "$job_manifest" >>"$LOG_FILE"
  echo "job.batch/control-api-db-migrate created"
  exit 0
fi

if [[ "${1:-}" == "wait" || "${1:-}" == "logs" ]]; then
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  sql="$(cat || true)"
  printf 'SQL\n%s\n' "$sql" >>"$LOG_FILE"
  if [[ "$sql" == *"public.schema_migrations"* && "$sql" == *"has_table_privilege"* ]]; then
    echo "f"
  elif [[ "$sql" == *"COUNT(*)"* ]]; then
    echo "0"
  else
    echo "t"
  fi
  exit 0
fi

exit 0
STUB
  chmod +x "$tmp/kubectl"

  out="$(TEST_LOG_FILE="$log_file" PATH="$tmp:$PATH" CONTEXT=fake-context ALLOWED_CONTEXTS=fake-context \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay "$overlay" 2>&1 || true)"
  if [[ "$out" == *"Using control-api image for migration: example/control-api:test"* ]] && \
     [[ "$out" == *"Verifying DB-first schema in control-postgres"* ]] && \
     [[ "$(grep -c '^--context=fake-context exec -i deployment/control-postgres -n control-plane -- sh -lc psql -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -At$' "$log_file" || true)" -ge 16 ]] && \
     grep -q "0016_workflow_trigger_shared_foundation" "$log_file" && \
     grep -q "0061_governed_run_trace_schema_foundation" "$log_file" && \
     grep -q "0062_governed_trace_runtime_roles" "$log_file" && \
     grep -q "0063_workflow_approval_trace_binding" "$log_file" && \
     grep -q "0064_agent_decision_source_catalog" "$log_file" && \
     grep -q "0065_governed_session_replay_and_prompt_history" "$log_file" && \
     grep -q "0066_governed_trace_target_principal_projection" "$log_file" && \
     grep -q "0067_llm_runtime_access_profiles" "$log_file" && \
     grep -q "0090_identity_provider_connections" "$log_file" && \
     grep -q "table_name = 'governed_event_stream'" "$log_file" && \
     grep -q "table_name = 'administrative_events'" "$log_file" && \
     grep -q "column_name = 'tenant_id'" "$log_file" && \
     grep -q "data_type = 'text'" "$log_file" && \
     grep -q "is_nullable = 'YES'" "$log_file" && \
     grep -q "column_default IS NULL" "$log_file" && \
     grep -q "relation_constraint.contype = 'u'" "$log_file" && \
     grep -q "relation_constraint.conkey = ARRAY" "$log_file" && \
     grep -q "governed_administrative_event_stream_integrity" "$log_file" && \
     grep -q "governed_event_stream_family_integrity" "$log_file" && \
     grep -q "tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure" "$log_file" && \
     grep -q "tgdeferrable" "$log_file" && \
     grep -q "tginitdeferred" "$log_file" && \
     grep -q "tgtype = 13" "$log_file" && \
     grep -q "0054_workflow_run_completed_notification_download_detection" "$log_file" && \
     grep -q "has_table_privilege('control_api_runtime', 'public.schema_migrations'" "$log_file" && \
     grep -q "relation.relkind IN ('r', 'p', 'v', 'm')" "$log_file" && \
     grep -q 'JOB_MANIFEST.*DATABASE_URL' "$log_file" && \
     grep -q 'JOB_MANIFEST.*control-api-config' "$log_file" && \
     grep -q 'JOB_MANIFEST.*CONTROL_API_PG_CONNECTION_STRING.*"value":""' "$log_file" && \
     grep -q 'JOB_MANIFEST.*CONTROL_API_MIGRATION_PG_HOST' "$log_file" && \
     grep -q 'JOB_MANIFEST.*control-postgres.*POSTGRES_PASSWORD' "$log_file" && \
     grep -q -- '--context=fake-context get secret control-postgres -n control-plane' "$log_file" && \
     ! grep -q 'JOB_MANIFEST.*postgresql://postgres:' "$log_file" && \
     grep -q "workflow_approval_trigger_intents" "$log_file" && \
     grep -q "idx_wati_trigger" "$log_file" && \
     grep -q "NOT EXISTS" "$log_file"; then
    pass "db migration script logs resolved image and verifies DB schema after job success"
  else
    fail "db migration script did not verify DB state after a successful job"
    echo "$out"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_db_migration_reuses_existing_bound_pvc() {
  local tmp overlay log_file out
  tmp="$(mktemp -d)"
  overlay="$tmp/overlay"
  log_file="$tmp/kubectl.log"
  mkdir -p "$overlay"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
args="$*"
printf '%s\n' "$args" >>"$LOG_FILE"
if [[ "${1:-}" == "--context=fake-context" ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: control-api
      namespace: control-plane
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: control-api-config
      namespace: control-plane
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: control-postgres-data
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: v1
    kind: Service
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-api
      namespace: control-plane
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:test
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: control-api-secrets
                      key: DATABASE_URL
              envFrom: []
YAML
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "pvc" ]]; then
  exit 0
fi

if [[ "${1:-}" == "apply" ]]; then
  manifest="$(cat)"
  printf 'APPLY\n%s\n' "$manifest" >>"$LOG_FILE"
  if [[ "$manifest" == *"PersistentVolumeClaim"* ]]; then
    echo "unexpected pvc apply" >&2
    exit 99
  fi
  exit 0
fi

if [[ "${1:-}" == "rollout" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$args" == *"jsonpath={.status.active}"* ]]; then
    exit 1
  fi
  exit 1
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  manifest="$(cat)"
  printf 'CREATE\n%s\n' "$manifest" >>"$LOG_FILE"
  if [[ "$manifest" == *"PersistentVolumeClaim"* ]]; then
    echo "unexpected pvc create" >&2
    exit 98
  fi
  echo "job.batch/control-api-db-migrate created"
  exit 0
fi

if [[ "${1:-}" == "wait" || "${1:-}" == "logs" ]]; then
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  sql="$(cat || true)"
  printf 'SQL\n%s\n' "$sql" >>"$LOG_FILE"
  if [[ "$sql" == *"public.schema_migrations"* && "$sql" == *"has_table_privilege"* ]]; then
    echo "f"
  elif [[ "$sql" == *"COUNT(*)"* ]]; then
    echo "0"
  else
    echo "t"
  fi
  exit 0
fi

exit 0
STUB
  chmod +x "$tmp/kubectl"

  out="$(TEST_LOG_FILE="$log_file" PATH="$tmp:$PATH" CONTEXT=fake-context ALLOWED_CONTEXTS=fake-context \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay "$overlay" 2>&1 || true)"
  if [[ "$out" == *"Reusing existing PVC control-plane/control-postgres-data"* ]] && \
     [[ "$out" != *"Creating PVC control-plane/control-postgres-data"* ]] && \
     [[ "$out" != *"unexpected pvc"* ]]; then
    pass "db migration script reuses bound PVC without mutating it"
  else
    fail "db migration script did not safely reuse an existing PVC"
    echo "$out"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_db_migration_creates_missing_pvc() {
  local tmp overlay log_file out
  tmp="$(mktemp -d)"
  overlay="$tmp/overlay"
  log_file="$tmp/kubectl.log"
  mkdir -p "$overlay"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
args="$*"
printf '%s\n' "$args" >>"$LOG_FILE"
if [[ "${1:-}" == "--context=fake-context" ]]; then shift; fi

if [[ "${1:-}" == "kustomize" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: control-api
      namespace: control-plane
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: control-api-config
      namespace: control-plane
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: control-postgres-data
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: v1
    kind: Service
    metadata:
      name: control-postgres
      namespace: control-plane
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: control-api
      namespace: control-plane
    spec:
      template:
        spec:
          serviceAccountName: control-api
          containers:
            - name: control-api
              image: example/control-api:test
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: control-api-secrets
                      key: DATABASE_URL
              envFrom: []
YAML
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "pvc" ]]; then
  exit 1
fi

if [[ "${1:-}" == "apply" ]]; then
  manifest="$(cat)"
  printf 'APPLY\n%s\n' "$manifest" >>"$LOG_FILE"
  if [[ "$manifest" == *"PersistentVolumeClaim"* ]]; then
    echo "unexpected pvc apply" >&2
    exit 99
  fi
  exit 0
fi

if [[ "${1:-}" == "rollout" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "job" ]]; then
  if [[ "$args" == *"jsonpath={.status.active}"* ]]; then
    exit 1
  fi
  exit 1
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  manifest="$(cat)"
  if [[ "$manifest" == *"PersistentVolumeClaim"* ]]; then
    printf 'PVC_CREATE\n%s\n' "$manifest" >>"$LOG_FILE"
    echo "persistentvolumeclaim/control-postgres-data created"
    exit 0
  fi
  printf 'JOB_CREATE\n%s\n' "$manifest" >>"$LOG_FILE"
  echo "job.batch/control-api-db-migrate created"
  exit 0
fi

if [[ "${1:-}" == "wait" || "${1:-}" == "logs" ]]; then
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  sql="$(cat || true)"
  printf 'SQL\n%s\n' "$sql" >>"$LOG_FILE"
  if [[ "$sql" == *"public.schema_migrations"* && "$sql" == *"has_table_privilege"* ]]; then
    echo "f"
  elif [[ "$sql" == *"COUNT(*)"* ]]; then
    echo "0"
  else
    echo "t"
  fi
  exit 0
fi

exit 0
STUB
  chmod +x "$tmp/kubectl"

  out="$(TEST_LOG_FILE="$log_file" PATH="$tmp:$PATH" CONTEXT=fake-context ALLOWED_CONTEXTS=fake-context \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay "$overlay" 2>&1 || true)"
  if [[ "$out" == *"Creating PVC control-plane/control-postgres-data"* ]] && \
     grep -q '^PVC_CREATE$' "$log_file" && \
     grep -q '^JOB_CREATE$' "$log_file" && \
     [[ "$out" != *"unexpected pvc"* ]]; then
    pass "db migration script creates missing PVC separately before shared apply"
  else
    fail "db migration script did not safely bootstrap a missing PVC"
    echo "$out"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_deploy_dev_keeps_mcp_proxy_gating() {
  local workflow
  workflow="$(cat .github/workflows/deploy-dev.yaml)"

  if [[ "$workflow" == *'GATING_DEPLOYMENTS="mcp-server/deployment/mcp-proxy"'* ]] && \
     [[ "$workflow" == *'NONGATING_NAMESPACES="mcp-server"'* ]] && \
     [[ "$workflow" == *'if [[ "$ns/$dep" == "mcp-server/deployment/mcp-proxy" ]]; then'* ]]; then
    pass "deploy-dev keeps mcp-proxy gating while leaving mcp-server best-effort"
  else
    fail "deploy-dev no longer protects mcp-proxy as a gating rollout"
  fi
}

assert_recreate_strategy_repair_script_patches_stateful_deployments() {
  local tmp log_file out patch_count
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

if [[ "${3:-}" == "get" && "${4:-}" == "deployment" ]]; then
  exit 0
fi

if [[ "${3:-}" == "patch" && "${4:-}" == "deployment" ]]; then
  if [[ "$*" != *'{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'* ]]; then
    echo "missing recreate/rollingUpdate-null patch" >&2
    exit 2
  fi
  exit 0
fi

case " $* " in
  *" delete "*|*" replace "*|*" scale "*|*" rollout restart "*|*" pvc "*|*" secret "*")
    echo "destructive or data-bearing resource mutation is forbidden" >&2
    exit 3
    ;;
esac

exit 0
STUB
  chmod +x "$tmp/kubectl"

  out="$(TEST_LOG_FILE="$log_file" KUBECTL="$tmp/kubectl" bash deploy/scripts/repair-recreate-strategy-rollout-fields.sh 2>&1 || true)"
  patch_count="$(grep -c 'patch deployment' "$log_file" || true)"
  if [[ "$patch_count" -eq 2 ]] && \
     [[ "$out" == *"Reconciling control-plane/control-postgres strategy only"* ]] && \
     [[ "$out" == *"Reconciling registry/registry-postgres strategy only"* ]] && \
     ! grep -Eq ' delete | replace | scale | rollout restart | pvc | secret ' "$log_file"; then
    pass "recreate strategy repair script patches strategy only without touching persisted data"
  else
    fail "recreate strategy repair script did not patch the expected deployments"
    echo "$out"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_deploy_dev_repairs_recreate_strategy_before_server_side_apply() {
  local workflow repair_line apply_line
  workflow="$(cat .github/workflows/deploy-dev.yaml)"
  repair_line="$(printf '%s\n' "$workflow" | nl -ba | grep 'repair-recreate-strategy-rollout-fields.sh' | awk '{print $1}' | head -n1)"
  apply_line="$(printf '%s\n' "$workflow" | nl -ba | grep 'Apply kustomize overlay (server-side, drift-safe)' | awk '{print $1}' | head -n1)"

  if [[ -n "$repair_line" && -n "$apply_line" && "$repair_line" -lt "$apply_line" ]]; then
    pass "deploy-dev repairs Recreate strategy drift before server-side apply"
  else
    fail "deploy-dev does not repair Recreate strategy drift before server-side apply"
  fi
}

assert_deploy_dev_hardens_control_api_migration_selection() {
  local workflow
  workflow="$(cat .github/workflows/deploy-dev.yaml)"

  if [[ "$workflow" == *"fetch-depth: 0"* ]] && \
     [[ "$workflow" == *"Resolve deploy diff base"* ]] && \
     [[ "$workflow" == *"Validate control-api path detection"* ]] && \
     [[ "$workflow" == *"Resolved control-api image for migration gate"* ]] && \
     [[ "$workflow" == *'control-api: ${{ steps.control_api_changed.outputs.changed }}'* ]] && \
     [[ "$workflow" == *'base: ${{ steps.deploy_base.outputs.sha }}'* ]] && \
     [[ "$workflow" != *'RENDERED_JSON="$(kubectl kustomize deploy/overlays/gcp-dev | kubectl apply --dry-run=client -f - -o json)"'* ]] && \
     [[ "$workflow" == *'rendered_yaml_file="$(mktemp)"'* ]] && \
     [[ "$workflow" != *'kubectl apply --dry-run=client -f - -o json >"$rendered_json_file"'* ]]; then
    pass "deploy-dev hardens control-api change detection and logs the migration image"
  else
    fail "deploy-dev is missing the control-api migration image hardening"
  fi
}

assert_deploy_dev_blocks_crd_drift_before_auth() {
  local workflow deploy_section guard_line auth_line
  workflow="$(cat .github/workflows/deploy-dev.yaml)"
  deploy_section="$(printf '%s\n' "$workflow" | awk '
    /^  deploy:/ { in_deploy=1 }
    in_deploy { print }
  ')"
  guard_line="$(printf '%s\n' "$deploy_section" | nl -ba | grep 'Block deploy when CRDs changed but were not applied' | awk '{print $1}' | head -n1)"
  auth_line="$(printf '%s\n' "$deploy_section" | nl -ba | grep 'Authenticate to Google Cloud' | awk '{print $1}' | head -n1)"

  if [[ -n "$guard_line" && -n "$auth_line" && "$guard_line" -lt "$auth_line" ]]; then
    pass "deploy-dev checks CRD drift before attempting GKE auth"
  else
    fail "deploy-dev still checks CRD drift after GKE auth"
  fi
}


assert_deploy_dev_restarts_subpath_gateway_after_apply() {
  local workflow apply_line restart_line
  workflow="$(cat .github/workflows/deploy-dev.yaml)"
  apply_line="$(printf '%s\n' "$workflow" | nl -ba | grep 'Apply kustomize overlay (server-side, drift-safe)' | awk '{print $1}' | head -n1)"
  restart_line="$(printf '%s\n' "$workflow" | nl -ba | grep 'rollout restart deployment/nginx-workflow-approval-gateway -n control-plane' | awk '{print $1}' | head -n1)"

  if [[ -n "$apply_line" && -n "$restart_line" && "$apply_line" -lt "$restart_line" ]] && \
     [[ "$workflow" == *'nginx-workflow-approval-gateway mounts nginx.conf with subPath'* ]]; then
    pass "deploy-dev restarts nginx workflow approval gateway after ConfigMap apply"
  else
    fail "deploy-dev does not restart nginx workflow approval gateway after ConfigMap apply"
  fi
}

assert_deploy_dev_rollout_gate_is_baseline_aware() {
  local workflow baseline_line apply_line tmp baseline_file out
  workflow="$(cat .github/workflows/deploy-dev.yaml)"
  baseline_line="$(printf '%s\n' "$workflow" | nl -ba | grep 'Capture pre-deploy rollout baseline' | awk '{print $1}' | head -n1)"
  apply_line="$(printf '%s\n' "$workflow" | nl -ba | grep 'Apply kustomize overlay (server-side, drift-safe)' | awk '{print $1}' | head -n1)"

  if [[ -z "$baseline_line" || -z "$apply_line" || "$baseline_line" -ge "$apply_line" ]]; then
    fail "deploy-dev does not capture rollout baseline before applying the overlay"
    return
  fi

  if [[ "$workflow" != *'kubectl rollout status "$dep" --namespace "$ns" --timeout=1s'* ]] || \
     [[ "$workflow" != *'echo "$key" >> "$BASELINE_FILE"'* ]] || \
     [[ "$workflow" != *'was_preexisting_failure()'* ]] || \
     [[ "$workflow" != *'deployment_template_changed()'* ]] || \
     [[ "$workflow" != *'is_core_deployment()'* ]] || \
     [[ "$workflow" != *'Pre-existing rollout failure for ${key}; deployment template unchanged by this deploy'* ]]; then
    fail "deploy-dev is missing the baseline-aware rollout classification hooks"
    return
  fi

  tmp="$(mktemp -d)"
  baseline_file="$tmp/preexisting-rollout-failures.txt"

  cat > "$tmp/harness.sh" <<'HARNESS'
set -euo pipefail

kubectl() {
  local cmd="${1:-}"
  case "$cmd ${2:-} ${3:-}" in
    "rollout status deployment.apps/healthy-recipe") return 0 ;;
    "rollout status"*) return 1 ;;
    "get deployment.apps/changed-recipe"*) printf '%s\n' "${CHANGED_RECIPE_TEMPLATE:-template-before}"; return 0 ;;
    "get"*) printf '%s\n' 'repo/app:0.1.0'; return 0 ;;
  esac
  return 0
}

deployment_template_hash() {
  local ns="${1:-}"
  local dep="${2:-}"
  kubectl get "$dep" -n "$ns" -o jsonpath='{.spec.template}' | sha256sum | awk '{print $1}'
}

capture_rollout_baseline() {
  local ns="${1:-}"
  local dep="${2:-}"
  local key="${ns}/${dep}"
  local template_hash
  template_hash="$(deployment_template_hash "$ns" "$dep")"
  echo "${key} ${template_hash}" >> "$PRE_DEPLOY_TEMPLATE_BASELINE"

  if kubectl rollout status "$dep" --namespace "$ns" --timeout=1s >/dev/null 2>&1; then
    return 0
  fi
  echo "$key" >> "$PRE_DEPLOY_ROLLOUT_BASELINE"
}

print_rollout_debug() { :; }

was_preexisting_failure() {
  local key="${1:-}"
  [[ -f "$PRE_DEPLOY_ROLLOUT_BASELINE" ]] && grep -Fxq "$key" "$PRE_DEPLOY_ROLLOUT_BASELINE"
}

deployment_template_changed() {
  local ns="${1:-}"
  local dep="${2:-}"
  local key="${ns}/${dep}"
  local before after
  before="$(awk -v key="$key" '$1 == key { print $2; found=1 } END { if (!found) exit 1 }' "$PRE_DEPLOY_TEMPLATE_BASELINE" 2>/dev/null || true)"
  [[ -n "$before" ]] || return 0
  after="$(deployment_template_hash "$ns" "$dep")"
  [[ "$before" != "$after" ]]
}

is_core_deployment() {
  local ns="${1:-}"
  local dep="${2:-}"
  [[ "$ns/$dep" == "mcp-server/deployment/mcp-proxy" ]] && return 0
  [[ "$ns" != "sandbox-recipes" ]]
}

check_rollout() {
  local ns="${1:-}"
  local dep="${2:-}"
  local kind="${3:-}"
  local timeout="${4:-}"
  if kubectl rollout status "$dep" --namespace "$ns" --timeout="$timeout"; then
    return 0
  fi
  if [[ "$kind" == "gating" ]]; then
    local key="${ns}/${dep}"
    if was_preexisting_failure "$key" && ! deployment_template_changed "$ns" "$dep" && ! is_core_deployment "$ns" "$dep"; then
      return 0
    fi
    return 1
  fi
  return 0
}

: >"$PRE_DEPLOY_ROLLOUT_BASELINE"
capture_rollout_baseline sandbox-recipes deployment.apps/recap-api
capture_rollout_baseline sandbox-recipes deployment.apps/healthy-recipe
capture_rollout_baseline control-plane deployment.apps/control-api
capture_rollout_baseline sandbox-recipes deployment.apps/changed-recipe

if ! grep -Fxq 'sandbox-recipes/deployment.apps/recap-api' "$PRE_DEPLOY_ROLLOUT_BASELINE"; then echo missing-recap-baseline; exit 10; fi
if grep -Fxq 'sandbox-recipes/deployment.apps/healthy-recipe' "$PRE_DEPLOY_ROLLOUT_BASELINE"; then echo healthy-was-recorded; exit 11; fi
if ! grep -Fxq 'control-plane/deployment.apps/control-api' "$PRE_DEPLOY_ROLLOUT_BASELINE"; then echo missing-core-baseline; exit 12; fi
if ! grep -Eq '^sandbox-recipes/deployment.apps/changed-recipe [0-9a-f]{64}$' "$PRE_DEPLOY_TEMPLATE_BASELINE"; then echo missing-template-baseline; exit 13; fi

check_rollout sandbox-recipes deployment.apps/recap-api gating 300s
if check_rollout control-plane deployment.apps/control-api gating 300s; then echo core-was-downgraded; exit 14; fi
CHANGED_RECIPE_TEMPLATE=template-after
if check_rollout sandbox-recipes deployment.apps/changed-recipe gating 300s; then echo changed-was-downgraded; exit 15; fi
if check_rollout mcp-server deployment/mcp-proxy gating 300s; then echo mcp-proxy-was-downgraded; exit 16; fi

echo baseline-aware-rollout-gate-ok
HARNESS
  out="$(PRE_DEPLOY_ROLLOUT_BASELINE="$baseline_file" PRE_DEPLOY_TEMPLATE_BASELINE="$tmp/predeploy-rollout-template-hashes.txt" GITHUB_SHA="89d9cf81234567890abcdef1234567890abcdef1" bash "$tmp/harness.sh")"

  if [[ "$out" == *"baseline-aware-rollout-gate-ok"* ]]; then
    pass "deploy-dev captures pre-deploy rollout failures and only downgrades unchanged sandbox recipe failures"
  else
    fail "deploy-dev baseline-aware rollout gate cold unit test failed"
    echo "$out"
  fi

  rm -rf "$tmp"
}

assert_deploy_workflows_verify_networkpolicies_after_apply() {
  local dev prod dev_apply dev_verify prod_apply prod_verify
  dev="$(cat .github/workflows/deploy-dev.yaml)"
  prod="$(cat .github/workflows/deploy-prod.yaml)"
  dev_apply="$(printf '%s\n' "$dev" | nl -ba | grep 'Apply kustomize overlay (server-side, drift-safe)' | awk '{print $1}' | head -n1)"
  dev_verify="$(printf '%s\n' "$dev" | nl -ba | grep 'verify-networkpolicies.sh --overlay gcp-dev' | awk '{print $1}' | head -n1)"
  prod_apply="$(printf '%s\n' "$prod" | nl -ba | grep 'Apply kustomize overlay' | awk '{print $1}' | head -n1)"
  prod_verify="$(printf '%s\n' "$prod" | nl -ba | grep 'verify-networkpolicies.sh --overlay gcp-prod' | awk '{print $1}' | head -n1)"

  if [[ -n "$dev_apply" && -n "$dev_verify" && "$dev_apply" -lt "$dev_verify" ]] && \
     [[ "$dev" == *'Verify NetworkPolicies match gcp-dev overlay'* ]] && \
     [[ -n "$prod_apply" && -n "$prod_verify" && "$prod_apply" -lt "$prod_verify" ]] && \
     [[ "$prod" == *'Verify NetworkPolicies match gcp-prod overlay (explicit gate)'* ]]; then
    pass "deploy workflows verify NetworkPolicies after overlay apply"
  else
    fail "deploy workflows do not gate NetworkPolicy drift after overlay apply"
  fi
}

assert_deploy_dev_provisions_gfs_after_networkpolicy_verify() {
  local dev gfs_script verify gfs_step
  dev="$(cat .github/workflows/deploy-dev.yaml)"
  gfs_script="$(cat deploy/scripts/provision-gfs-runtime.sh)"
  verify="$(printf '%s\n' "$dev" | nl -ba | grep 'Verify NetworkPolicies match gcp-dev overlay' | awk '{print $1}' | head -n1)"
  gfs_step="$(printf '%s\n' "$dev" | nl -ba | grep 'Provision GFS runtime and dev CRD instances' | awk '{print $1}' | head -n1)"

  if [[ -n "$verify" && -n "$gfs_step" && "$verify" -lt "$gfs_step" ]] && \
     [[ "$dev" == *'provision-gfs-runtime.sh'* ]] && \
     [[ "$dev" == *'GATING_NAMESPACES="channels control-plane gfs mcp-host profiles registry rpc-proxy sandbox-recipes"'* ]] && \
     [[ "$dev" == *'--overlay deploy/overlays/gcp-dev'* ]] && \
     [[ "$gfs_script" == *'deployment/gfsc-writer'* ]] && \
     [[ "$gfs_script" == *'deployment/gfsc-reader'* ]]; then
    pass "deploy-dev provisions GFS runtime after overlay and includes GFS in rollout gates"
  else
    fail "deploy-dev does not provision GFS runtime with the required rollout gate"
  fi
}

assert_deploy_paths_reconcile_runtime_roles_after_migration() {
  local dev prod dev_migration dev_roles prod_migration prod_roles
  dev="$(cat .github/workflows/deploy-dev.yaml)"
  prod="$(cat .github/workflows/deploy-prod.yaml)"
  dev_migration="$(printf '%s\n' "$dev" | nl -ba | grep 'Run control-api DB migration gate' | awk '{print $1}' | head -n1)"
  dev_roles="$(printf '%s\n' "$dev" | nl -ba | grep 'Reconcile control-api runtime database roles' | awk '{print $1}' | head -n1)"
  prod_migration="$(printf '%s\n' "$prod" | nl -ba | grep 'Run control-api DB migration gate' | awk '{print $1}' | head -n1)"
  prod_roles="$(printf '%s\n' "$prod" | nl -ba | grep 'Reconcile control-api runtime database roles' | awk '{print $1}' | head -n1)"

  if [[ -n "$dev_migration" && -n "$dev_roles" && "$dev_migration" -lt "$dev_roles" ]] && \
     [[ -n "$prod_migration" && -n "$prod_roles" && "$prod_migration" -lt "$prod_roles" ]] && \
     [[ "$dev" == *'provision-control-api-runtime-roles.sh'* ]] && \
     [[ "$prod" == *'provision-control-api-runtime-roles.sh'* ]] && \
     [[ "$dev" == *'CONTEXT="$target_context" ALLOWED_CONTEXTS="$target_context"'* ]] && \
     [[ "$prod" == *'CONTEXT="$target_context" ALLOWED_CONTEXTS="$target_context"'* ]] && \
     [[ -x deploy/scripts/provision-control-api-runtime-roles.sh ]] && \
     grep -q 'ALLOWED_CONTEXTS="${PROFILE}"' scripts/minikube/full-setup.sh && \
     grep -q 'ALLOWED_CONTEXTS="${PROFILE}"' scripts/minikube/pre-gate-sync.sh && \
     grep -q 'ALLOWED_CONTEXTS=$(GCP_DEV_CONTEXT).*run-control-api-db-migration.sh' Makefile && \
     grep -q 'ALLOWED_CONTEXTS=$(GCP_PROD_CONTEXT).*run-control-api-db-migration.sh' Makefile && \
     grep -q 'provision-control-api-runtime-roles.sh' scripts/minikube/full-setup.sh && \
     grep -q 'provision-control-api-runtime-roles.sh' scripts/minikube/pre-gate-sync.sh && \
     grep -q 'provision-control-api-runtime-roles.sh' Makefile; then
    pass "deploy paths reconcile runtime roles after the migration gate"
  else
    fail "deploy paths do not reconcile runtime roles after migration"
  fi
}

assert_runtime_role_provisioning_script() {
  if bash scripts/tests/test-provision-control-api-runtime-roles.sh; then
    pass "runtime role provisioning preserves valid credentials and fails closed"
  else
    fail "runtime role provisioning regression suite failed"
  fi
}

assert_db_migration_context_fails_closed() {
  local missing_context denied_context
  missing_context="$(bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/minikube 2>&1 || true)"
  denied_context="$(CONTEXT=denied ALLOWED_CONTEXTS=allowed \
    bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/minikube 2>&1 || true)"

  if [[ "$missing_context" == *'set CONTEXT to the target kube-context'* ]] && \
     [[ "$denied_context" == *'CONTEXT=denied is not in ALLOWED_CONTEXTS'* ]]; then
    pass "db migration context authority fails closed"
  else
    fail "db migration context authority did not fail closed"
  fi
}

assert_trace_maintenance_runtime_access_contract_is_exact() {
  local relation_file sequence_file function_file migration_script
  local relation_count sequence_count function_count
  relation_file="deploy/scripts/trace-maintenance-runtime-access-profiles.tsv"
  sequence_file="deploy/scripts/trace-maintenance-runtime-sequence-access-profiles.tsv"
  function_file="deploy/scripts/trace-maintenance-runtime-function-access-profiles.tsv"
  migration_script="$(cat deploy/scripts/run-control-api-db-migration.sh)"

  relation_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$relation_file")"
  sequence_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$sequence_file")"
  function_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$function_file")"

  if [[ "$relation_count" == "8" && "$sequence_count" == "2" && "$function_count" == "11" ]] && \
     [[ "$migration_script" == *'verify_trace_maintenance_access_contract'* ]] && \
     [[ "$migration_script" == *'has_table_privilege('* ]] && \
     [[ "$migration_script" == *'has_sequence_privilege('* ]] && \
     [[ "$migration_script" == *'has_function_privilege('* ]] && \
     [[ "$migration_script" == *"'trace_maintenance_runtime'"* ]] && \
     [[ "$migration_script" == *"routine.proname LIKE 'governed_trace_%'"* ]]; then
    pass "trace maintenance runtime contract rejects missing and excessive privileges"
  else
    fail "trace maintenance runtime access contract is incomplete or not exact"
  fi
}

assert_control_api_runtime_access_contract_is_exact() {
  local profile_file sequence_profile_file migration_script
  local relation_count duplicate_count invalid_count sequence_count sequence_duplicate_count sequence_invalid_count
  profile_file="deploy/scripts/control-api-runtime-access-profiles.tsv"
  sequence_profile_file="deploy/scripts/control-api-runtime-sequence-access-profiles.tsv"
  migration_script="$(cat deploy/scripts/run-control-api-db-migration.sh)"

  relation_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$profile_file")"
  duplicate_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { seen[$1]++ } END { for (name in seen) if (seen[name] > 1) count++ } END { print count + 0 }' "$profile_file")"
  invalid_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ && (NF != 2 || $1 !~ /^[a-z][a-z0-9_]*$/ || $2 !~ /^(legacy_dml|upsert|append|read|none)$/) { count++ } END { print count + 0 }' "$profile_file")"
  sequence_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$sequence_profile_file")"
  sequence_duplicate_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { seen[$1]++ } END { for (name in seen) if (seen[name] > 1) count++ } END { print count + 0 }' "$sequence_profile_file")"
  sequence_invalid_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ && (NF != 2 || $1 !~ /^[a-z][a-z0-9_]*$/ || $2 !~ /^(legacy_rw|consume)$/) { count++ } END { print count + 0 }' "$sequence_profile_file")"

  if [[ "$relation_count" == "87" && "$duplicate_count" == "0" && "$invalid_count" == "0" ]] && \
     grep -qx $'identity_provider_connections\tlegacy_dml' "$profile_file" && \
     grep -qx $'identity_provider_setup_sessions\tlegacy_dml' "$profile_file" && \
     grep -qx $'invitation_agents\tlegacy_dml' "$profile_file" && \
     grep -qx $'llm_allowed_models\tlegacy_dml' "$profile_file" && \
     grep -qx $'member_registration_credentials\tupsert' "$profile_file" && \
     grep -qx $'llm_allowed_models_audit\tappend' "$profile_file" && \
     grep -qx $'llm_catalog_sync_runs\tappend' "$profile_file" && \
     grep -qx $'plugin_workload_sdk_spend_outcomes\tappend' "$profile_file" && \
     [[ "$sequence_count" == "7" && "$sequence_duplicate_count" == "0" && "$sequence_invalid_count" == "0" ]] && \
     grep -qx $'member_registration_credentials_id_seq\tconsume' "$sequence_profile_file" && \
     [[ "$migration_script" != *'RUNTIME_ACCESS_PROFILES_FILE:-'* ]] && \
     [[ "$migration_script" == *'FULL OUTER JOIN actual_relations'* ]] && \
     [[ "$migration_script" == *'FULL OUTER JOIN actual_sequences'* ]] && \
     [[ "$migration_script" == *'IS DISTINCT FROM required.allowed'* ]] && \
     [[ "$migration_script" == *'has_sequence_privilege('* ]] && \
     [[ "$migration_script" == *"('TRUNCATE', false)"* ]] && \
     [[ "$migration_script" == *"('REFERENCES', false)"* ]] && \
     [[ "$migration_script" == *"('TRIGGER', false)"* ]]; then
    pass "control-api runtime access contract rejects missing and excessive relation privileges"
  else
    fail "control-api runtime access contract is incomplete or not exact"
  fi
}

assert_setup_defaults_prod
assert_setup_dev_overrides
assert_teardown_dev
assert_detect_k8s_api_ip
assert_bump_tag
assert_apply_registry_secrets_patches_voucher_material
assert_db_migration_job_uses_ci_suffix
assert_db_migration_handles_concurrent_create_race
assert_db_migration_reports_missing_migrate_artifact
assert_db_migration_verifies_db_after_success
assert_db_migration_reuses_existing_bound_pvc
assert_db_migration_creates_missing_pvc
assert_bootstrap_rbac_includes_cluster_wide_manifests
assert_deploy_dev_keeps_mcp_proxy_gating
assert_recreate_strategy_repair_script_patches_stateful_deployments
assert_deploy_dev_repairs_recreate_strategy_before_server_side_apply
assert_deploy_dev_hardens_control_api_migration_selection
assert_deploy_dev_blocks_crd_drift_before_auth
assert_deploy_dev_rollout_gate_is_baseline_aware
assert_deploy_dev_restarts_subpath_gateway_after_apply
assert_deploy_workflows_verify_networkpolicies_after_apply
assert_deploy_dev_provisions_gfs_after_networkpolicy_verify
assert_control_api_runtime_access_contract_is_exact
assert_trace_maintenance_runtime_access_contract_is_exact
assert_deploy_paths_reconcile_runtime_roles_after_migration
assert_runtime_role_provisioning_script
assert_db_migration_context_fails_closed

exit $FAIL
