#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
fail() { echo "FAIL: $*" >&2; exit 1; }
external_rest_manifest="$(cat deploy/base/profiles/external-rest-api.yaml)"
profiles_network_policy="$(cat deploy/base/profiles/networkpolicies.yaml)"
ingress_network_policy="$(cat deploy/base/ingress/networkpolicies.yaml)"
[[ "$external_rest_manifest" == *'type: ClusterIP'* ]] \
  || fail 'external-rest-api must remain an internal ClusterIP, not a directly exposed service'
[[ "$profiles_network_policy" == *'name: allow-ingress-profiles'* && \
   "$profiles_network_policy" == *'app: cloudflared'* && \
   "$profiles_network_policy" == *'values: [external-rest-api, profile-ui]'* && \
   "$profiles_network_policy" == *'name: external-rest-api-from-profile-ui'* ]] \
  || fail 'profiles ingress policy does not document the trusted Cloudflare/profile-ui paths'
[[ "$ingress_network_policy" == *'app: external-rest-api'* && \
   "$ingress_network_policy" == *'kubernetes.io/metadata.name: profiles'* ]] \
  || fail 'ingress namespace policy does not restrict cloudflared egress to profiles services'
# Scope: OSS-resident GFS deploy invariants only. The GCP deploy invariants
# (deploy-dev/deploy-prod workflow ordering, gcp-* Makefile targets, gcp-prod
# overlay render, and the HCC rollback contract) live in evenfire-infra after
# the app/config repo split and are validated by its sibling contract there.
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
[[ "$provision_contract" == *"has_column_privilege(:'role_name', 'control_admin_users', 'id', 'SELECT')"* && "$provision_contract" == *"has_column_privilege(:'role_name', 'control_admin_users', 'session_version', 'SELECT')"* && "$provision_contract" == *"has_column_privilege(:'role_name', 'users', 'lifecycle_version', 'SELECT')"* && "$provision_contract" == *"has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'lineage_id', 'SELECT')"* && "$provision_contract" == *"column_name NOT IN ('id', 'status', 'session_version')"* && "$provision_contract" == *"column_name NOT IN ('team_id', 'user_id', 'status')"* ]] || fail 'provisioner does not verify the exact subject-column contract'
writer_case="$(sed -n '/rotate-writer)/,/;;/p' deploy/scripts/provision-gfs-db.sh)"
[[ "$writer_case" == *'reconcile_credential gfs_controller writer "$WRITER_SECRET" gfsc-writer true'* && "$writer_case" != *'gfsc-reader'* ]] || fail 'writer rollout scope'
runtime_script="$(sed '/^[[:space:]]*#/d' deploy/scripts/provision-gfs-runtime.sh)"
[[ "$runtime_script" == *'reconcile-gfs-deploy-credentials.sh'* ]] \
  || fail 'post-overlay runtime path does not reconcile staged credentials'
[[ "$runtime_script" == *'rollout status deployment/gfsc-writer'* && \
   "$runtime_script" == *'rollout status deployment/gfsc-reader'* ]] \
  || fail 'post-overlay runtime path does not wait for exact GFSC rollouts'
[[ "$runtime_script" != *'rollout restart'* && "$runtime_script" != *'rotate-writer'* ]] \
  || fail 'post-overlay runtime path rotates or unconditionally restarts GFS'
# Use a clean, minimal Git fixture so this contract tests the profile/cluster
# boundary rather than whichever unrelated files a developer has open in the
# main worktree. The fake Minikube command fails closed with no status output;
# it must never be interpreted as authorization for a remote mutation.
T2_FIXTURE_ROOT="$(mktemp -d)"
T2_PROFILE_ROOT="${T2_FIXTURE_ROOT}/profiles"
T2_PROFILE="contract-profile"
T2_CONTEXT="${T2_PROFILE}"
T2_PROFILE_DIR="${T2_PROFILE_ROOT}/${T2_PROFILE}"
T2_PROFILE_ENV="${T2_PROFILE_DIR}/profile.env"
T2_PORTS_ENV="${T2_PROFILE_DIR}/ports.env"
T2_BIN="${T2_FIXTURE_ROOT}/bin"
T2_MUTATION_LOG="${T2_FIXTURE_ROOT}/mutations.log"
trap 'rm -rf "${T2_FIXTURE_ROOT}"' EXIT
mkdir -p "${T2_PROFILE_DIR}" "${T2_BIN}"
git init -q "${T2_FIXTURE_ROOT}/repo"
git -C "${T2_FIXTURE_ROOT}/repo" config user.email contract@example.invalid
git -C "${T2_FIXTURE_ROOT}/repo" config user.name contract-fixture
git -C "${T2_FIXTURE_ROOT}/repo" checkout -q -b feat/contract-lock
git -C "${T2_FIXTURE_ROOT}/repo" remote add origin https://github.com/evenfire-ai/evenfire.git
git -C "${T2_FIXTURE_ROOT}/repo" commit --allow-empty -qm fixture
git -C "${T2_FIXTURE_ROOT}/repo" update-ref refs/remotes/origin/dev HEAD
T2_HEAD_SHORT="$(git -C "${T2_FIXTURE_ROOT}/repo" rev-parse --short HEAD)"
printf 'PROFILE=%s\nREPO_DIR=%s\nBRANCH=feat/contract-lock\nSHA_SHORT=%s\nDIRTY=false\n' \
  "${T2_PROFILE}" "${T2_FIXTURE_ROOT}/repo" "${T2_HEAD_SHORT}" >"${T2_PROFILE_ENV}"
: >"${T2_PORTS_ENV}"
printf '#!/usr/bin/env bash\nexit 42\n' >"${T2_BIN}/minikube"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$T2_MUTATION_LOG"\nexit 99\n' >"${T2_BIN}/kubectl"
chmod +x "${T2_BIN}/minikube" "${T2_BIN}/kubectl"

reconcile_context_err="$(mktemp)"
if CONTEXT="${T2_CONTEXT}" T2_PROJECT_DIR="${T2_FIXTURE_ROOT}/repo" \
  T2_PROFILE="${T2_PROFILE}" T2_CONTEXT="${T2_CONTEXT}" \
  T2_PROFILE_ROOT="${T2_PROFILE_ROOT}" T2_PROFILE_ENV="${T2_PROFILE_ENV}" \
  T2_PORTS_ENV="${T2_PORTS_ENV}" PATH="${T2_BIN}:$PATH" \
  bash deploy/scripts/reconcile-gfs-deploy-credentials.sh 2>"$reconcile_context_err"; then
  rm -f "$reconcile_context_err"
  fail 'credential reconciliation accepted an unverified Kubernetes context'
fi
grep -Fq 'DEVELOPMENT_SCOPE_REQUIRED' "$reconcile_context_err" \
  || fail 'credential reconciliation did not fail closed when the local profile was not bootstrapped'
[[ ! -s "$T2_MUTATION_LOG" ]] \
  || fail 'credential reconciliation mutated Kubernetes after Minikube status failed'
rm -f "$reconcile_context_err"
reconcile_remote_context_err="$(mktemp)"
if CONTEXT="${T2_CONTEXT}" GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS=other-context \
  T2_PROJECT_DIR="${T2_FIXTURE_ROOT}/repo" T2_PROFILE="${T2_PROFILE}" T2_CONTEXT="${T2_CONTEXT}" \
  T2_PROFILE_ROOT="${T2_PROFILE_ROOT}" T2_PROFILE_ENV="${T2_PROFILE_ENV}" \
  T2_PORTS_ENV="${T2_PORTS_ENV}" PATH="${T2_BIN}:$PATH" \
  bash deploy/scripts/reconcile-gfs-deploy-credentials.sh 2>"$reconcile_remote_context_err"; then
  rm -f "$reconcile_remote_context_err"
  fail 'credential reconciliation accepted a GKE context outside the explicit allowlist'
fi
grep -Fq 'remote context is not explicitly allowlisted' "$reconcile_remote_context_err" \
  || fail 'credential reconciliation did not fail closed before a protected context could mutate GFS'
[[ ! -s "$T2_MUTATION_LOG" ]] \
  || fail 'credential reconciliation mutated Kubernetes after remote allowlist validation failed'
rm -f "$reconcile_remote_context_err"
grep -Fq 't2_mutation_lock' deploy/scripts/reconcile-gfs-deploy-credentials.sh \
  || fail 'GFS reconciliation does not require the canonical profile mutation lock'
! grep -Fq 'minikube_profile_exists' deploy/scripts/reconcile-gfs-deploy-credentials.sh \
  || fail 'GFS reconciliation still infers remote ownership from Minikube status'
make_block() {
  awk -v target="$1" '$0 ~ "^" target ":" {active=1} active && /^\.PHONY:/ {exit} active {print}' Makefile
}
target=minikube-db-reset
block="$(make_block "$target")"
reset="$(grep -n 'reset-control-db-storage.sh' <<<"$block" | head -1 | cut -d: -f1)"
recreate="$(grep -n 'apply -k .* -l app=control-postgres' <<<"$block" | head -1 | cut -d: -f1)"
postgres_ready="$(grep -nE 'wait .*control-postgres|wait .*deploy/control-postgres' <<<"$block" | head -1 | cut -d: -f1)"
converge="$(grep -n 'converge-control-db-after-reset.sh' <<<"$block" | head -1 | cut -d: -f1)"
success="$(grep -n 'DB reset complete' <<<"$block" | tail -1 | cut -d: -f1)"
[[ -n "$reset" && -n "$recreate" && -n "$postgres_ready" && -n "$converge" && -n "$success" ]] && \
  [[ "$reset" -lt "$recreate" && "$recreate" -lt "$postgres_ready" && "$postgres_ready" -lt "$converge" && "$converge" -lt "$success" ]] \
  || fail "$target bypasses safe GFS reset recovery"
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
for required in run-control-api-db-migration.sh provision-control-api-runtime-roles.sh 'scale deployment/control-api --replicas=0' "CONTROL_API_POD_SELECTOR='app=control-api,!clerum.io/component'" 'wait --for=delete pod' 'rollout status deployment/control-api' 'sync-auth-key.sh' '--require-gfs' 'GFS_RESTORE_ACTIVE_NOLOGIN=true' reconcile-gfs-deploy-credentials.sh verify-gfs.sh; do
  [[ "$reset_convergence" == *"$required"* ]] || fail "reset convergence omits $required"
done
migration="$(grep -n 'run-control-api-db-migration.sh' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
roles="$(grep -n 'provision-control-api-runtime-roles.sh' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
control_zero="$(grep -n 'scale deployment/control-api --replicas=0' deploy/scripts/converge-control-db-after-reset.sh | tail -1 | cut -d: -f1)"
control_wait="$(grep -n -- '-l "$CONTROL_API_POD_SELECTOR" --timeout=180s' deploy/scripts/converge-control-db-after-reset.sh | tail -1 | cut -d: -f1)"
control_restore="$(grep -n 'scale deployment/control-api --replicas="\$CONTROL_API_REPLICAS"' deploy/scripts/converge-control-db-after-reset.sh | tail -1 | cut -d: -f1)"
ready="$(grep -n 'rollout status deployment/control-api' deploy/scripts/converge-control-db-after-reset.sh | tail -1 | cut -d: -f1)"
auth_sync="$(grep -n 'sync-auth-key.sh' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
restore="$(grep -n 'GFS_RESTORE_ACTIVE_NOLOGIN=true' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
verify="$(grep -n 'verify-gfs.sh' deploy/scripts/converge-control-db-after-reset.sh | tail -1 | cut -d: -f1)"
success="$(grep -n 'migrations, runtime roles, GFS restore, and verification complete' deploy/scripts/converge-control-db-after-reset.sh | cut -d: -f1)"
[[ "$control_zero" -lt "$control_wait" && "$control_wait" -lt "$migration" && \
   "$migration" -lt "$roles" && "$roles" -lt "$control_restore" && \
   "$control_restore" -lt "$ready" && "$ready" -lt "$auth_sync" && \
   "$auth_sync" -lt "$restore" && \
   "$restore" -lt "$verify" && "$verify" -lt "$success" ]] \
  || fail 'reset convergence ordering is incomplete'
! grep -q '|| true' deploy/scripts/converge-control-db-after-reset.sh || fail 'reset convergence suppresses a critical failure'
for upgrade_path in Makefile scripts/minikube/pre-gate-sync.sh scripts/minikube/full-setup.sh; do
  grep -q 'get secret gfs-controller-db' "$upgrade_path" || fail "$upgrade_path does not distinguish partial bootstrap"
done
assert_minikube_upgrade_classifier() {
  local path="$1" start="$2" end="$3" block block_start dsn classify ready abort reconcile fallback fresh
  block_start="$(grep -nF -- "$start" "$path" | head -1 | cut -d: -f1)"
  [[ -n "$block_start" ]] || fail "$path is missing the upgrade classifier anchor"
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
  classifier_start="$dsn"
  for line_name in dsn classify ready abort reconcile fallback fresh; do
    line_value="${!line_name}"
    if [[ -n "$line_value" ]]; then
      printf -v "$line_name" '%d' "$((block_start + line_value - 1))"
    fi
  done
  if [[ "$path" == *"scripts/minikube/full-setup.sh" ]]; then
    local readiness_probe writer_flag partial_flag fence_call policy_apply migration roles recovery_overlay restore_api post_ready post_reconcile restore_writers
    readiness_probe="$(grep -n 'if control_api_is_ready' <<<"$block" | head -1 | cut -d: -f1)"
    if [[ -n "$readiness_probe" ]]; then
      readiness_probe=$((block_start + readiness_probe - 1))
    fi
    # The durable resume classifier is defined before the executable upgrade
    # branch. Select the first recovery assignment/fence after the writer
    # Secret read so this contract checks mutation order, not helper details.
    writer_flag="$(grep -n 'WRITER_RECOVERY=true' <<<"${block}" | awk -F: -v start="${classifier_start}" '$1 >= start { print $1; exit }')"
    partial_flag="$(grep -n 'PARTIAL_BOOTSTRAP_RECOVERY=true' <<<"${block}" | awk -F: -v start="${classifier_start}" '$1 >= start { print $1; exit }')"
    fence_call="$(grep -nE '^[[:space:]]+fence_partial_bootstrap_writers$' <<<"${block}" | awk -F: -v start="${classifier_start}" '$1 >= start { print $1; exit }')"
    policy_apply="$(grep -nE '^[[:space:]]+apply_refreshed_k8s_api_network_policies$' <<<"${block}" | awk -F: -v start="${classifier_start}" '$1 >= start { print $1; exit }')"
    migration="$(grep -n 'run-control-api-db-migration.sh' "$path" | head -1 | cut -d: -f1)"
    roles="$(grep -n 'provision-control-api-runtime-roles.sh' "$path" | head -1 | cut -d: -f1)"
    restore_api="$(grep -nE '^[[:space:]]+restore_partial_control_api$' "$path" | tail -1 | cut -d: -f1)"
    recovery_overlay="$(grep -nE '^[[:space:]]+apply_fenced_recovery_overlay$' "$path" | tail -1 | cut -d: -f1)"
    post_ready="$(grep -n 'rollout status deployment/control-api.*timeout=180s' "$path" | tail -1 | cut -d: -f1)"
    post_reconcile="$(grep -nE '^[[:space:]]+reconcile_existing_gfs_credentials$' "$path" | tail -1 | cut -d: -f1)"
    restore_writers="$(grep -nE '^[[:space:]]+restore_partial_non_api_writers$' "$path" | tail -1 | cut -d: -f1)"
    for line_name in writer_flag partial_flag fence_call policy_apply; do
      line_value="${!line_name}"
      if [[ -n "$line_value" ]]; then
        printf -v "$line_name" '%d' "$((block_start + line_value - 1))"
      fi
    done
    [[ -n "$dsn" && -n "$classify" && -n "$readiness_probe" && -n "$writer_flag" && \
       -n "$partial_flag" && -n "$fence_call" && -n "$policy_apply" && \
       -n "$fallback" && -n "$fresh" && -n "$migration" && \
       -n "$roles" && -n "$recovery_overlay" && -n "$restore_api" && \
       -n "$post_ready" && -n "$post_reconcile" && -n "$restore_writers" ]] \
      || fail "$path recovery classifier is incomplete"
    [[ "$dsn" -lt "$classify" && "$classify" -lt "$readiness_probe" && \
       "$readiness_probe" -lt "$writer_flag" && "$writer_flag" -lt "$partial_flag" && \
       "$partial_flag" -lt "$fence_call" && "$fence_call" -lt "$policy_apply" && \
       "$partial_flag" -lt "$fallback" && "$fallback" -lt "$fresh" && \
       "$migration" -lt "$roles" && "$roles" -lt "$recovery_overlay" && \
       "$recovery_overlay" -lt "$restore_api" && "$restore_api" -lt "$post_reconcile" && \
       "$post_reconcile" -lt "$restore_writers" && "$post_ready" -lt "$post_reconcile" ]] \
      || fail "$path does not apply a fenced overlay before restoring API, GFS, and the remaining writers"
    grep -Fq 'Existing GFS writer detected but control-api is not Ready; refusing HCC cutover' "$path" \
      || fail "$path no longer retains the fail-closed guard for an unrecognized unready upgrade"
    grep -Fq 'app=control-api,!clerum.io/component' "$path" \
      || fail "$path does not exclude migration Jobs from the control-api writer fence"
    grep -Fq 'WRITER_RECOVERY_MIGRATIONS_COMPLETE=true' "$path" \
      || fail "$path does not mark post-migration recovery as complete"
    grep -Fq 'WRITER_RECOVERY_FENCE_PENDING=true' "$path" \
      || fail "$path does not re-fence every durable post-migration resume"
    grep -Fq 'if writer_recovery_policy_ready && [ "$K8S_API_EGRESS_POLICY_DRIFT" != true ]; then' "$path" \
      || fail "$path can skip a refreshed Kubernetes API egress policy after endpoint drift"
    grep -Fq 'render-fenced-writer-deployments.rb' "$path" \
      || fail "$path does not render a fenced recovery overlay"
    grep -Fq 'writer_recovery_state_phase overlay-applying' "$path" \
      || fail "$path does not persist the overlay-application boundary"
    grep -Fq 'writer_recovery_state_phase api-restoring' "$path" \
      || fail "$path does not persist the control-api restore boundary"
  else
    [[ -n "$dsn" && -n "$classify" && -n "$ready" && -n "$abort" && -n "$reconcile" && -n "$fallback" && -n "$fresh" ]] \
      || fail "$path upgrade classifier is incomplete"
    [[ "$dsn" -lt "$classify" && "$classify" -lt "$ready" && "$ready" -lt "$abort" && \
       "$abort" -lt "$reconcile" && "$reconcile" -lt "$fallback" && "$fallback" -lt "$fresh" ]] \
      || fail "$path does not reconcile ready upgrades, abort unready upgrades, and defer only empty bootstraps"
  fi
}
assert_pre_gate_defers_gfs_reconcile() {
  local block
  block="$({ awk -v start="$1" -v end="$2" '
    index($0, start) { active=1 }
    active { print }
    active && index($0, end) { exit }
  ' "$3"; })"
  local dsn defer reconcile migration serving
  dsn="$(grep -n 'writer_dsn=.*get secret gfs-controller-db' <<<"$block" | head -1 | cut -d: -f1)"
  defer="$(grep -ni 'deferring GFS credential reconciliation until after schema migration' <<<"$block" | head -1 | cut -d: -f1)"
  reconcile="$(grep -n 'reconcile-gfs-deploy-credentials.sh' <<<"$block" | head -1 | cut -d: -f1 || true)"
  migration="$(grep -n 'run-control-api-db-migration.sh' "$3" | head -1 | cut -d: -f1)"
  serving="$(grep -n 'provision_gfs_serving' "$3" | tail -1 | cut -d: -f1)"
  [[ -n "$dsn" && -n "$defer" && -z "$reconcile" ]] \
    || fail "$3 must defer GFS credential reconciliation before migration"
  [[ -n "$migration" && -n "$serving" && "$migration" -lt "$serving" ]] \
    || fail "$3 must provision GFS serving only after schema migration"
}
# The block ends where the overlay apply begins. That apply no longer names a
# fixed overlay: it resolves one from the mode the cluster's images were
# acquired in (scripts/minikube/image-mode.sh), so the resolver call is the
# anchor.
assert_minikube_upgrade_classifier Makefile '# Upgrade path: adopt/validate writer' 'image-mode.sh --render-dir'
assert_minikube_upgrade_classifier scripts/minikube/full-setup.sh '# Upgrade path: stage the additive reader' 'Applying kustomize overlay'
full_setup_identity_line="$(grep -nF 't2_profile_context_identity_check' scripts/minikube/full-setup.sh | tail -1 | cut -d: -f1)"
full_setup_recovery_guard_line="$(grep -nF 'guard_interrupted_writer_recovery || exit 1' scripts/minikube/full-setup.sh | head -1 | cut -d: -f1)"
[[ -n "$full_setup_identity_line" && -n "$full_setup_recovery_guard_line" && \
   "$full_setup_identity_line" -lt "$full_setup_recovery_guard_line" ]] \
  || fail 'full-setup can fence recovery writers before verifying exact context/profile identity'
assert_pre_gate_defers_gfs_reconcile 'apply-gfs-writer-secret.sh' 'incremental_build_images' scripts/minikube/pre-gate-sync.sh
full_setup_classifier="$(sed -n '/# Upgrade path: stage the additive reader/,/Applying kustomize overlay/p' scripts/minikube/full-setup.sh)"
reset_classifier="$(grep -n 'if \[ "$RESET_DB" = true \]; then' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
reset_classifier_defer="$(grep -n 'HCC cutover deferred until post-convergence verification' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
reset_classifier_else="$(awk -v start="$reset_classifier" 'NR > start && /^else$/ { print NR; exit }' <<<"$full_setup_classifier")"
reset_classifier_dsn="$(grep -n 'writer_dsn=.*get secret gfs-controller-db' <<<"$full_setup_classifier" | head -1 | cut -d: -f1)"
[[ -n "$reset_classifier" && -n "$reset_classifier_defer" && -n "$reset_classifier_else" && -n "$reset_classifier_dsn" ]] && \
  [[ "$reset_classifier" -lt "$reset_classifier_defer" && "$reset_classifier_defer" -lt "$reset_classifier_else" && \
     "$reset_classifier_else" -lt "$reset_classifier_dsn" ]] \
  || fail 'full-setup reset still reaches the control-api readiness upgrade classifier'
full_setup_reset="$(sed -n '/# 6a. Optional DB reset/,/# 6c. Re-apply generated service tokens/p' scripts/minikube/full-setup.sh)"
reset_defer="$(grep -n 'HCC cutover deferred until post-convergence verification' <<<"$full_setup_reset" | head -1 | cut -d: -f1)"
reset_postgres_only="$(grep -n 'apply -k .* -l app=control-postgres' <<<"$full_setup_reset" | head -1 | cut -d: -f1)"
reset_converge="$(grep -n 'converge-control-db-after-reset.sh' <<<"$full_setup_reset" | head -1 | cut -d: -f1)"
reset_full_overlay="$(grep -nE '(kubectl|\$KC) kustomize .* \| .* apply -f -' <<<"$full_setup_reset" | tail -1 | cut -d: -f1)"
[[ -n "$reset_defer" && -n "$reset_postgres_only" && -n "$reset_converge" && -n "$reset_full_overlay" ]] && \
  [[ "$reset_defer" -lt "$reset_postgres_only" && "$reset_postgres_only" -lt "$reset_converge" && "$reset_converge" -lt "$reset_full_overlay" ]] \
  || fail 'full-setup reset can require ready control-api or cut over HCC before convergence'
pre_gate_crds="$(grep -n 'make minikube-deploy-crds' scripts/minikube/pre-gate-sync.sh | cut -d: -f1)"
pre_gate_writer="$(grep -n 'apply-gfs-writer-secret.sh' scripts/minikube/pre-gate-sync.sh | head -1 | cut -d: -f1)"
pre_gate_overlay="$(grep -n 'make minikube-deploy-all' scripts/minikube/pre-gate-sync.sh | head -1 | cut -d: -f1)"
pre_gate_migration="$(grep -n 'run-control-api-db-migration.sh' scripts/minikube/pre-gate-sync.sh | head -1 | cut -d: -f1)"
[[ "$(wc -l <<<"$pre_gate_crds" | tr -d ' ')" -eq 1 ]] || fail 'pre-gate must apply CRDs exactly once'
[[ "$pre_gate_crds" -lt "$pre_gate_writer" && "$pre_gate_writer" -lt "$pre_gate_migration" && \
   "$pre_gate_migration" -lt "$pre_gate_overlay" ]] \
  || fail 'pre-gate must apply CRDs, secrets, and schema migration before the consumer overlay'
# The GFS writer Secret must never be applied into a missing namespace. In the
# OSS deploy model, namespaces are applied by the prior deploy-crds/pre-gate step
# (asserted above for pre-gate-sync: CRDs -> writer Secret -> overlay), and
# minikube-deploy-all applies namespaces via the kustomize overlay, not a
# standalone deploy/base/namespaces.yaml line. The ordering guarantee is enforced
# defensively by apply-gfs-writer-secret.sh, which is fail-closed when the gfs
# namespace is absent. Assert that guard directly.
grep -q 'is not declared; apply deploy/base/namespaces.yaml before GFS Secrets' deploy/scripts/apply-gfs-writer-secret.sh \
  || fail 'apply-gfs-writer-secret.sh is not fail-closed on a missing gfs namespace'
bash scripts/tests/test-gfs-credential-lifecycle.sh
bash scripts/tests/test-provision-gfs-runtime.sh
bash scripts/tests/test-gfs-writer-secret-apply.sh
bash scripts/tests/test-gfs-nologin-restore.sh
bash scripts/tests/test-gfs-db-reset-preflight.sh
bash scripts/tests/test-reset-control-db-storage.sh
echo 'PASS: GFS deploy contract (OSS-resident invariants)'
