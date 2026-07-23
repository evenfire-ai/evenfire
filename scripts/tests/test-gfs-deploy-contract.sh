#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
fail() { echo "FAIL: $*" >&2; exit 1; }
for mode in stage-writer stage-reader rotate-reader rotate-writer; do
  grep -q "$mode" deploy/scripts/provision-gfs-db.sh || fail "missing $mode"
done
grep -q 'PG_DB="${PG_DB:-profiles}"' deploy/scripts/provision-gfs-db.sh || fail 'provisioner canonical GFS database default drifted'
grep -q 'PG_DB="${PG_DB:-profiles}"' deploy/scripts/preflight-gfs-db-reset.sh || fail 'reset preflight diverges from provisioner GFS database default'
grep -q 'recover_abandoned_applying' deploy/scripts/provision-gfs-db.sh || fail 'explicit applying-state recovery is not wired'
grep -q 'role_can_login' deploy/scripts/lib/gfs-credential-recovery.sh || fail 'fresh bootstrap recovery does not verify NOLOGIN'
! grep -q 'rollout restart deployment -l' deploy/scripts/provision-gfs-db.sh || fail 'broad rollout'
role_migration="$(sed -n "/version: '0074_gfs_runtime_role_exact_contract'/,/^  },$/p" control-api/src/db.ts)"
[[ "$role_migration" == *'ALTER ROLE gfs_controller'* && "$role_migration" == *'ALTER ROLE gfs_controller_reader'* && "$role_migration" == *'NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'* ]] || fail 'exact GFS runtime role attributes are not reconciled'
[[ "$role_migration" != *'NOLOGIN'* && "$role_migration" != *'LOGIN'* && "$role_migration" != *'PASSWORD'* && "$role_migration" != *'DROP ROLE'* ]] || fail 'role-contract migration changes credentials or replaces a role'
[[ "$role_migration" == *"ARRAY['gfs_controller', 'gfs_controller_reader']"* && "$role_migration" == *"EXECUTE format('REVOKE %I FROM %I'"* ]] || fail 'role-contract migration leaves inherited memberships'
provision_contract="$(sed -n '/verify_role_contract()/,/^}/p' deploy/scripts/provision-gfs-db.sh)"
[[ "$provision_contract" == *"has_column_privilege(:'role_name', 'control_admin_users', 'id', 'SELECT')"* && "$provision_contract" == *"has_column_privilege(:'role_name', 'team_members', 'status', 'SELECT')"* && "$provision_contract" == *"column_name NOT IN ('id', 'status')"* && "$provision_contract" == *"column_name NOT IN ('team_id', 'user_id', 'status')"* ]] || fail 'provisioner does not verify the exact subject-column contract'
writer_case="$(sed -n '/rotate-writer)/,/;;/p' deploy/scripts/provision-gfs-db.sh)"
[[ "$writer_case" == *'reconcile_credential gfs_controller writer "$WRITER_SECRET" gfsc-writer true'* && "$writer_case" != *'gfsc-reader'* ]] || fail 'writer rollout scope'
for workflow in .github/workflows/deploy-dev.yaml .github/workflows/deploy-prod.yaml; do
  heading="$(grep -n 'Reconcile GFS database credentials' "$workflow" | head -1 | cut -d: -f1)"
  reconcile="$(grep -n 'reconcile-gfs-deploy-credentials.sh' "$workflow" | head -1 | cut -d: -f1)"
  overlay="$(grep -n 'Apply kustomize overlay' "$workflow" | head -1 | cut -d: -f1)"
  [[ "$heading" -lt "$reconcile" && "$reconcile" -lt "$overlay" ]] || fail "$workflow order"
  runtime="$(grep -n 'provision-gfs-runtime.sh' "$workflow" | head -1 | cut -d: -f1)"
  verify="$(grep -n 'scripts/minikube/verify-gfs.sh' "$workflow" | head -1 | cut -d: -f1)"
  [[ -n "$runtime" && -n "$verify" && "$overlay" -lt "$runtime" && "$runtime" -lt "$verify" ]] \
    || fail "$workflow missing post-overlay GFS reconciliation before verification"
done
runtime_script="$(cat deploy/scripts/provision-gfs-runtime.sh)"
[[ "$runtime_script" == *'reconcile-gfs-deploy-credentials.sh'* ]] \
  || fail 'post-overlay runtime path does not reconcile staged credentials'
[[ "$runtime_script" == *'rollout status deployment/gfsc-writer'* && \
   "$runtime_script" == *'rollout status deployment/gfsc-reader'* ]] \
  || fail 'post-overlay runtime path does not wait for exact GFSC rollouts'
[[ "$runtime_script" != *'rollout restart'* && "$runtime_script" != *'rotate-writer'* ]] \
  || fail 'post-overlay runtime path rotates or unconditionally restarts GFS'
grep -q 'NAMESPACES="channels control-plane gfs ' .github/workflows/deploy-prod.yaml || fail 'prod GFS rollout gate absent'
for target in gcp-dev-deploy-all gcp-prod-deploy-all; do
  recipe="$(make -n "$target" CONFIRM=yes 2>/dev/null || true)"
  reconcile="$(printf '%s\n' "$recipe" | grep -n 'reconcile-gfs-deploy-credentials.sh' | head -1 | cut -d: -f1)"
  overlay="$(printf '%s\n' "$recipe" | grep -n 'kustomize deploy/overlays/' | head -1 | cut -d: -f1)"
  [[ -n "$reconcile" && -n "$overlay" && "$reconcile" -lt "$overlay" ]] || fail "$target order"
  [[ "$recipe" == *'scripts/minikube/verify-gfs.sh'* ]] || fail "$target missing GFS verification"
done
make_block() {
  awk -v target="$1" '$0 ~ "^" target ":" {active=1} active && /^\.PHONY:/ {exit} active {print}' Makefile
}
for target in gcp-prod-deploy-service gcp-prod-deploy-release gcp-dev-deploy-service; do
  block="$(make_block "$target")"
  reconcile="$(grep -n 'reconcile-gfs-deploy-credentials.sh' <<<"$block" | head -1 | cut -d: -f1)"
  overlay="$(grep -n 'kustomize deploy/overlays/gcp-' <<<"$block" | head -1 | cut -d: -f1)"
  verify="$(grep -n 'verify-gfs.sh' <<<"$block" | head -1 | cut -d: -f1)"
  [[ -n "$reconcile" && -n "$overlay" && -n "$verify" && "$reconcile" -lt "$overlay" && "$overlay" -lt "$verify" ]] \
    || fail "$target bypasses GFS deploy reconciliation"
done
for target in minikube-db-reset gcp-prod-db-reset gcp-dev-db-reset; do
  block="$(make_block "$target")"
  reset="$(grep -n 'reset-control-db-storage.sh' <<<"$block" | head -1 | cut -d: -f1)"
  recreate="$(grep -n 'apply -k .* -l app=control-postgres' <<<"$block" | head -1 | cut -d: -f1)"
  postgres_ready="$(grep -nE 'wait .*control-postgres|wait .*deploy/control-postgres' <<<"$block" | head -1 | cut -d: -f1)"
  converge="$(grep -n 'converge-control-db-after-reset.sh' <<<"$block" | head -1 | cut -d: -f1)"
  success="$(grep -n 'DB reset complete' <<<"$block" | tail -1 | cut -d: -f1)"
  [[ -n "$reset" && -n "$recreate" && -n "$postgres_ready" && -n "$converge" && -n "$success" ]] && \
    [[ "$reset" -lt "$recreate" && "$recreate" -lt "$postgres_ready" && "$postgres_ready" -lt "$converge" && "$converge" -lt "$success" ]] \
    || fail "$target bypasses safe GFS reset recovery"
done
reset_storage="$(cat deploy/scripts/reset-control-db-storage.sh)"
for required in preflight-gfs-db-reset.sh 'scale deployment/control-api --replicas=0' 'scale deployment/control-postgres --replicas=0' 'wait_for_pods_gone app=control-api' 'wait_for_pods_gone app=control-postgres' 'preconditions":{"uid":"%s"}' 'persistentvolumeclaims/${PVC}'; do
  [[ "$reset_storage" == *"$required"* ]] || fail "reset storage boundary omits $required"
done
preflight="$(grep -n 'preflight-gfs-db-reset.sh' deploy/scripts/reset-control-db-storage.sh | cut -d: -f1)"
scale="$(grep -n 'scale deployment/control-api' deploy/scripts/reset-control-db-storage.sh | cut -d: -f1)"
delete="$(grep -n 'delete --raw' deploy/scripts/reset-control-db-storage.sh | head -1 | cut -d: -f1)"
[[ "$preflight" -lt "$scale" && "$scale" -lt "$delete" ]] || fail 'reset storage mutates before metadata preflight'
grep -q 'claim.get("namespace") == "control-plane"' deploy/scripts/reset-control-db-storage.sh || fail 'released PV cleanup is not namespace-scoped'
grep -q 'claim.get("uid") == expected_uid' deploy/scripts/reset-control-db-storage.sh || fail 'released PV cleanup is not claim-UID-scoped'
! grep -q 'ensure_pvc "control-postgres-data"' scripts/minikube/ensure-pvcs.sh || fail 'generic PVC reconciler can still delete the control database'
reset_convergence="$(cat deploy/scripts/converge-control-db-after-reset.sh)"
for required in run-control-api-db-migration.sh provision-control-api-runtime-roles.sh 'rollout status deployment/control-api' 'GFS_RESTORE_ACTIVE_NOLOGIN=true' reconcile-gfs-deploy-credentials.sh verify-gfs.sh; do
  [[ "$reset_convergence" == *"$required"* ]] || fail "reset convergence omits $required"
done
migration="$(grep -n 'run-control-api-db-migration.sh' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
roles="$(grep -n 'provision-control-api-runtime-roles.sh' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
scale="$(grep -n 'scale deployment/control-api' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
ready="$(grep -n 'rollout status deployment/control-api' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
restore="$(grep -n 'GFS_RESTORE_ACTIVE_NOLOGIN=true' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
verify="$(grep -n 'verify-gfs.sh' deploy/scripts/converge-control-db-after-reset.sh | tail -1 | cut -d: -f1)"
success="$(grep -n 'migrations, runtime roles, GFS restore, and verification complete' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
[[ "$migration" -lt "$roles" && "$roles" -lt "$scale" && "$scale" -lt "$ready" && "$ready" -lt "$restore" && "$restore" -lt "$verify" && "$verify" -lt "$success" ]] \
  || fail 'reset convergence ordering is incomplete'
! grep -q '|| true' deploy/scripts/converge-control-db-after-reset.sh || fail 'reset convergence suppresses a critical failure'
for upgrade_path in Makefile scripts/minikube/pre-gate-sync.sh scripts/minikube/full-setup.sh; do
  grep -q 'get secret gfs-controller-db' "$upgrade_path" || fail "$upgrade_path does not distinguish partial bootstrap"
done
assert_minikube_upgrade_classifier() {
  local path="$1" start="$2" end="$3" block dsn classify ready abort reconcile fallback fresh
  block="$(awk -v start="$start" -v end="$end" '
    index($0, start) { active=1 }
    active { print }
    active && index($0, end) { exit }
  ' "$path")"
  dsn="$(grep -n 'writer_dsn=.*get secret gfs-controller-db' <<<"$block" | head -1 | cut -d: -f1)"
  classify="$(grep -nE 'if \[\[? -n .*writer_dsn' <<<"$block" | head -1 | cut -d: -f1)"
  ready="$(grep -n 'rollout status deployment/control-api' <<<"$block" | head -1 | cut -d: -f1)"
  abort="$(grep -n 'exit 1' <<<"$block" | tail -1 | cut -d: -f1)"
  reconcile="$(grep -n 'reconcile-gfs-deploy-credentials.sh' <<<"$block" | head -1 | cut -d: -f1)"
  fallback="$(grep -nE '^[[:space:]]*else' <<<"$block" | tail -1 | cut -d: -f1)"
  fresh="$(grep -ni 'fresh bootstrap' <<<"$block" | tail -1 | cut -d: -f1)"
  [[ -n "$dsn" && -n "$classify" && -n "$ready" && -n "$abort" && -n "$reconcile" && -n "$fallback" && -n "$fresh" ]] \
    || fail "$path upgrade classifier is incomplete"
  [[ "$dsn" -lt "$classify" && "$classify" -lt "$ready" && "$ready" -lt "$abort" && \
     "$abort" -lt "$reconcile" && "$reconcile" -lt "$fallback" && "$fallback" -lt "$fresh" ]] \
    || fail "$path does not reconcile ready upgrades, abort unready upgrades, and defer only empty bootstraps"
}
assert_minikube_upgrade_classifier Makefile '# Upgrade path: adopt/validate writer' 'kustomize deploy/overlays/minikube'
assert_minikube_upgrade_classifier scripts/minikube/full-setup.sh '# Upgrade path: stage the additive reader' 'Applying kustomize overlay'
assert_minikube_upgrade_classifier scripts/minikube/pre-gate-sync.sh 'apply-gfs-writer-secret.sh' 'make minikube-build-images'
full_setup_classifier="$(sed -n '/# Upgrade path: stage the additive reader/,/Applying kustomize overlay/p' scripts/minikube/full-setup.sh)"
reset_classifier="$(grep -n 'if \[ "$RESET_DB" = true \]; then' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
reset_classifier_defer="$(grep -n 'HCC cutover deferred until post-convergence verification' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
reset_classifier_else="$(grep -n '^else$' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
reset_classifier_dsn="$(grep -n 'writer_dsn=.*get secret gfs-controller-db' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
[[ -n "$reset_classifier" && -n "$reset_classifier_defer" && -n "$reset_classifier_else" && -n "$reset_classifier_dsn" ]] && \
  [[ "$reset_classifier" -lt "$reset_classifier_defer" && "$reset_classifier_defer" -lt "$reset_classifier_else" && \
     "$reset_classifier_else" -lt "$reset_classifier_dsn" ]] \
  || fail 'full-setup reset still reaches the control-api readiness upgrade classifier'
full_setup_reset="$(sed -n '/# 6a. Optional DB reset/,/# 6c. Re-apply generated service tokens/p' scripts/minikube/full-setup.sh)"
reset_defer="$(grep -n 'HCC cutover deferred until post-convergence verification' <<<"$full_setup_reset" | head -1 | cut -d: -f1)"
reset_postgres_only="$(grep -n 'apply -k .* -l app=control-postgres' <<<"$full_setup_reset" | head -1 | cut -d: -f1)"
reset_converge="$(grep -n 'converge-control-db-after-reset.sh' <<<"$full_setup_reset" | head -1 | cut -d: -f1)"
reset_full_overlay="$(grep -n 'kubectl kustomize .* | .* apply -f -' <<<"$full_setup_reset" | tail -1 | cut -d: -f1)"
[[ -n "$reset_defer" && -n "$reset_postgres_only" && -n "$reset_converge" && -n "$reset_full_overlay" ]] && \
  [[ "$reset_defer" -lt "$reset_postgres_only" && "$reset_postgres_only" -lt "$reset_converge" && "$reset_converge" -lt "$reset_full_overlay" ]] \
  || fail 'full-setup reset can require ready control-api or cut over HCC before convergence'
pre_gate_crds="$(grep -n 'make minikube-deploy-crds' scripts/minikube/pre-gate-sync.sh | cut -d: -f1)"
pre_gate_writer="$(grep -n 'apply-gfs-writer-secret.sh' scripts/minikube/pre-gate-sync.sh | head -1 | cut -d: -f1)"
pre_gate_overlay="$(grep -n 'make minikube-deploy-all' scripts/minikube/pre-gate-sync.sh | head -1 | cut -d: -f1)"
[[ "$(wc -l <<<"$pre_gate_crds" | tr -d ' ')" -eq 1 ]] || fail 'pre-gate must apply CRDs exactly once'
[[ "$pre_gate_crds" -lt "$pre_gate_writer" && "$pre_gate_writer" -lt "$pre_gate_overlay" ]] \
  || fail 'pre-gate must apply namespaces/CRDs before GFS Secrets and overlay'
make -n minikube-deploy-all MINIKUBE_PROFILE=test-context \
  | awk '/deploy\/base\/namespaces.yaml/{namespaces=NR} /apply-gfs-writer-secret.sh/{writer=NR} END{exit !(namespaces && writer && namespaces < writer)}' \
  || fail 'minikube-deploy-all must declare namespaces before the GFS writer Secret'
render="$(mktemp)"; trap 'rm -f "$render"' EXIT
kubectl kustomize deploy/overlays/gcp-prod >"$render"
grep -q 'name: gfs-controller-reader-db' "$render" || fail 'reader resource absent'
grep -A1 'name: CONTEXT_MAPPER_GFSC_IMAGE' "$render" | grep -q 'gfs-controller:sha-' || fail 'prod pin absent'
! grep -A1 'name: CONTEXT_MAPPER_GFSC_IMAGE' "$render" | grep -q 'gfs-controller:test' || fail 'test tag in prod'
bash scripts/tests/test-gfs-credential-lifecycle.sh
bash scripts/tests/test-provision-gfs-runtime.sh
bash scripts/tests/test-gfs-writer-secret-apply.sh
bash scripts/tests/test-gfs-nologin-restore.sh
bash scripts/tests/test-gfs-db-reset-preflight.sh
bash scripts/tests/test-reset-control-db-storage.sh
bash scripts/tests/test-gfs-hcc-rollback-static.sh
echo 'PASS: GFS deploy contract'
