#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAIL=0

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$REPO_ROOT"; then
  pass 'current workflow graph has compatible reusable contracts'
else
  fail 'current workflow graph has compatible reusable contracts'
fi

copy_workflows() {
  local target=$1
  mkdir -p "$target/.github"
  cp -R "$REPO_ROOT/.github/workflows" "$target/.github/"
}

assert_terminal_mutation_rejected() {
  local label=$1 root=$2
  if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$root" \
      >"$TEST_ROOT/terminal.out" 2>&1; then
    fail "$label"
  elif grep -q 'terminal truth table expected' "$TEST_ROOT/terminal.out"; then
    pass "$label"
  else
    sed -n '1,120p' "$TEST_ROOT/terminal.out" >&2
    fail "$label reports the terminal truth-table violation"
  fi
}

assert_contract_mutation_rejected() {
  local label=$1 root=$2 expected=$3 output=$4
  if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$root" \
      >"$output" 2>&1; then
    fail "$label"
  elif grep -Fq "$expected" "$output"; then
    pass "$label"
  else
    sed -n '1,120p' "$output" >&2
    fail "$label reports the semantic contract violation"
  fi
}

mismatch_root="$TEST_ROOT/permission-mismatch"
copy_workflows "$mismatch_root"
perl -0pi -e 's/(name: Prettier \(incoming files\).*?permissions:\n)(\s+contents: read)/$1      actions: read\n$2/s' \
  "$mismatch_root/.github/workflows/prettier-source-preflight.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$mismatch_root" \
    >"$TEST_ROOT/mismatch.out" 2>&1; then
  fail 'permission-ceiling mutation is rejected'
elif grep -Eq 'prettier-source-preflight.*actions permission|requests actions: read' \
    "$TEST_ROOT/mismatch.out"; then
  pass 'permission-ceiling mutation is rejected'
else
  sed -n '1,120p' "$TEST_ROOT/mismatch.out" >&2
  fail 'permission-ceiling mutation reports the incompatible permission'
fi

input_root="$TEST_ROOT/undeclared-input"
copy_workflows "$input_root"
perl -0pi -e 's/(mode: \$\{\{ github\.event_name == .+?\}\}\n)/$1      undeclared_input: rejected\n/' \
  "$input_root/.github/workflows/ci-public.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$input_root" \
    >"$TEST_ROOT/input.out" 2>&1; then
  fail 'undeclared-input mutation is rejected'
elif grep -q 'supplies undeclared input undeclared_input' "$TEST_ROOT/input.out"; then
  pass 'undeclared-input mutation is rejected'
else
  sed -n '1,120p' "$TEST_ROOT/input.out" >&2
  fail 'undeclared-input mutation reports the contract violation'
fi

helper_root="$TEST_ROOT/missing-provenance-helper"
copy_workflows "$helper_root"
perl -0pi -e 's/\n      - name: Require successful CI push run for exact SHA.*?(?=\n  conclude:)//s' \
  "$helper_root/.github/workflows/exact-ci-provenance.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$helper_root" \
    >"$TEST_ROOT/helper.out" 2>&1; then
  fail 'missing-provenance-helper mutation is rejected'
elif grep -q 'must contain exactly trusted checkout followed by the helper' "$TEST_ROOT/helper.out"; then
  pass 'missing-provenance-helper mutation is rejected'
else
  sed -n '1,120p' "$TEST_ROOT/helper.out" >&2
  fail 'missing-provenance-helper mutation reports the contract violation'
fi

candidate_first_root="$TEST_ROOT/candidate-first-checkout"
copy_workflows "$candidate_first_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event.inputs.ref || github.workflow_sha || 'refs\/heads\/main'/" \
  "$candidate_first_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'candidate-first release checkout mutation is rejected' \
  "$candidate_first_root" \
  'release executable checkout must ignore selected refs' \
  "$TEST_ROOT/candidate-first.out"

candidate_only_root="$TEST_ROOT/candidate-only-checkout"
copy_workflows "$candidate_only_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event.inputs.ref/" \
  "$candidate_only_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'candidate-only release checkout mutation is rejected' \
  "$candidate_only_root" \
  'release executable checkout must ignore selected refs' \
  "$TEST_ROOT/candidate-only.out"

candidate_alias_root="$TEST_ROOT/candidate-alias-checkout"
copy_workflows "$candidate_alias_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event_name == 'workflow_dispatch' \&\& (inputs.ref || github.workflow_sha) || 'refs\/heads\/main'/" \
  "$candidate_alias_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'inputs.ref candidate alias mutation is rejected' \
  "$candidate_alias_root" \
  'release executable checkout must ignore selected refs' \
  "$TEST_ROOT/candidate-alias.out"

conditional_candidate_root="$TEST_ROOT/conditional-candidate-checkout"
copy_workflows "$conditional_candidate_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event_name == 'workflow_dispatch' \&\& (github.event.inputs.ref == 'special-candidate' \&\& github.event.inputs.ref || github.workflow_sha) || 'refs\/heads\/main'/" \
  "$conditional_candidate_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'conditional selected-ref checkout mutation is rejected' \
  "$conditional_candidate_root" \
  'release executable checkout must ignore selected refs' \
  "$TEST_ROOT/conditional-candidate.out"

conditional_sha_root="$TEST_ROOT/conditional-workflow-sha-checkout"
copy_workflows "$conditional_sha_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event_name == 'workflow_dispatch' \&\& (github.workflow_sha == 'cccccccccccccccccccccccccccccccccccccccc' \&\& 'malicious-candidate' || github.workflow_sha) || 'refs\/heads\/main'/" \
  "$conditional_sha_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'conditional workflow-SHA checkout mutation is rejected' \
  "$conditional_sha_root" \
  'choose workflow SHA or trusted main' \
  "$TEST_ROOT/conditional-sha.out"

equivalent_checkout_root="$TEST_ROOT/equivalent-trusted-checkout"
copy_workflows "$equivalent_checkout_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/(github.event_name == 'workflow_dispatch' && github.workflow_sha) || 'refs\/heads\/main'/" \
  "$equivalent_checkout_root/.github/workflows/release-images.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$equivalent_checkout_root"; then
  pass 'equivalent parenthesized trusted checkout expression is accepted'
else
  fail 'equivalent parenthesized trusted checkout expression is accepted'
fi

case_equivalent_root="$TEST_ROOT/case-equivalent-trusted-checkout"
copy_workflows "$case_equivalent_root"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event_name == 'WORKFLOW_DISPATCH' \&\& github.workflow_sha || 'refs\/heads\/main'/" \
  "$case_equivalent_root/.github/workflows/release-images.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$case_equivalent_root"; then
  pass 'case-equivalent trusted checkout expression is accepted'
else
  fail 'case-equivalent trusted checkout expression is accepted'
fi

masked_true_root="$TEST_ROOT/masked-provenance-true"
copy_workflows "$masked_true_root"
perl -0pi -e 's/(--branches "\$ALLOWED_BRANCHES")/$1 || true/' \
  "$masked_true_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance failure masked with true is rejected' \
  "$masked_true_root" \
  'must be the exact variable-derived command without wrappers' \
  "$TEST_ROOT/masked-true.out"

masked_colon_root="$TEST_ROOT/masked-provenance-colon"
copy_workflows "$masked_colon_root"
perl -0pi -e 's/(--branches "\$ALLOWED_BRANCHES")/$1 || :/' \
  "$masked_colon_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance failure masked with colon is rejected' \
  "$masked_colon_root" \
  'must be the exact variable-derived command without wrappers' \
  "$TEST_ROOT/masked-colon.out"

masked_pipeline_root="$TEST_ROOT/masked-provenance-pipeline"
copy_workflows "$masked_pipeline_root"
perl -0pi -e 's/(--branches "\$ALLOWED_BRANCHES")/$1 | \/bin\/cat/' \
  "$masked_pipeline_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance failure masked by a pipeline is rejected' \
  "$masked_pipeline_root" \
  'must be the exact variable-derived command without wrappers' \
  "$TEST_ROOT/masked-pipeline.out"

side_effect_root="$TEST_ROOT/provenance-side-effect-command"
side_effect_marker="$TEST_ROOT/unsafe-command-executed"
copy_workflows "$side_effect_root"
SIDE_EFFECT_MARKER="$side_effect_marker" perl -0pi -e \
  's#run: >-\n          node scripts/ci/require-successful-ci-run\.mjs\n          --sha "\$SOURCE_SHA"\n          --branches "\$ALLOWED_BRANCHES"#run: /usr/bin/touch $ENV{SIDE_EFFECT_MARKER}#' \
  "$side_effect_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'untrusted provenance command is rejected without execution' \
  "$side_effect_root" \
  'must be the exact variable-derived command without wrappers' \
  "$TEST_ROOT/side-effect.out"
if [ -e "$side_effect_marker" ]; then
  fail 'untrusted provenance command leaves no side-effect marker'
else
  pass 'untrusted provenance command leaves no side-effect marker'
fi

hardcoded_branch_root="$TEST_ROOT/hardcoded-provenance-branch"
copy_workflows "$hardcoded_branch_root"
perl -0pi -e 's/--branches "\$ALLOWED_BRANCHES"/--branches main/' \
  "$hardcoded_branch_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'hard-coded provenance branch mutation is rejected' \
  "$hardcoded_branch_root" \
  'must be the exact variable-derived command without wrappers' \
  "$TEST_ROOT/hardcoded-branch.out"

hardcoded_sha_root="$TEST_ROOT/hardcoded-provenance-sha"
copy_workflows "$hardcoded_sha_root"
perl -0pi -e 's/--sha "\$SOURCE_SHA"/--sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$hardcoded_sha_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'hard-coded provenance SHA mutation is rejected' \
  "$hardcoded_sha_root" \
  'must be the exact variable-derived command without wrappers' \
  "$TEST_ROOT/hardcoded-sha.out"

hardcoded_env_root="$TEST_ROOT/hardcoded-provenance-environment"
copy_workflows "$hardcoded_env_root"
perl -0pi -e \
  's/SOURCE_SHA: \$\{\{ inputs\.head_sha \}\}/SOURCE_SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$hardcoded_env_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'hard-coded provenance environment mutation is rejected' \
  "$hardcoded_env_root" \
  'helper environment must use the exact provenance inputs and token' \
  "$TEST_ROOT/hardcoded-environment.out"

continue_on_error_root="$TEST_ROOT/provenance-continue-on-error"
copy_workflows "$continue_on_error_root"
perl -0pi -e 's/(- name: Require successful CI push run for exact SHA)/$1\n        continue-on-error: true/' \
  "$continue_on_error_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance continue-on-error mutation is rejected' \
  "$continue_on_error_root" \
  'helper step must not set continue-on-error' \
  "$TEST_ROOT/continue-on-error.out"

skipped_helper_root="$TEST_ROOT/provenance-skipped-helper"
copy_workflows "$skipped_helper_root"
perl -0pi -e 's/(- name: Require successful CI push run for exact SHA)/$1\n        if: \$\{\{ false \}\}/' \
  "$skipped_helper_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'conditionally skipped provenance helper mutation is rejected' \
  "$skipped_helper_root" \
  'helper step must not set if' \
  "$TEST_ROOT/skipped-helper.out"

custom_shell_root="$TEST_ROOT/provenance-custom-shell"
copy_workflows "$custom_shell_root"
perl -0pi -e 's/(- name: Require successful CI push run for exact SHA)/$1\n        shell: sh/' \
  "$custom_shell_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance custom-shell mutation is rejected' \
  "$custom_shell_root" \
  'helper step must not set shell' \
  "$TEST_ROOT/custom-shell.out"

working_directory_root="$TEST_ROOT/provenance-working-directory"
copy_workflows "$working_directory_root"
perl -0pi -e 's/(- name: Require successful CI push run for exact SHA)/$1\n        working-directory: candidate-source/' \
  "$working_directory_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance working-directory mutation is rejected' \
  "$working_directory_root" \
  'helper step must not set working-directory' \
  "$TEST_ROOT/working-directory.out"

job_continue_root="$TEST_ROOT/provenance-job-continue-on-error"
copy_workflows "$job_continue_root"
perl -0pi -e 's/(  provenance:.*?    runs-on: ubuntu-latest)/$1\n    continue-on-error: true/s' \
  "$job_continue_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance job continue-on-error mutation is rejected' \
  "$job_continue_root" \
  'job must not set continue-on-error' \
  "$TEST_ROOT/job-continue-on-error.out"

job_env_root="$TEST_ROOT/provenance-job-environment"
copy_workflows "$job_env_root"
perl -0pi -e 's/(  provenance:.*?    runs-on: ubuntu-latest)/$1\n    env:\n      BASH_ENV: candidate-source\/env.sh/s' \
  "$job_env_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance job environment mutation is rejected' \
  "$job_env_root" \
  'must not inherit workflow or job environment overrides' \
  "$TEST_ROOT/job-environment.out"

workflow_defaults_root="$TEST_ROOT/provenance-workflow-defaults"
copy_workflows "$workflow_defaults_root"
perl -0pi -e 's/\njobs:/\ndefaults:\n  run:\n    shell: sh\n\njobs:/' \
  "$workflow_defaults_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance workflow defaults mutation is rejected' \
  "$workflow_defaults_root" \
  'must not use workflow or job run defaults' \
  "$TEST_ROOT/workflow-defaults.out"

container_root="$TEST_ROOT/provenance-container"
copy_workflows "$container_root"
perl -0pi -e 's/(  provenance:.*?    runs-on: ubuntu-latest)/$1\n    container: attacker.invalid\/candidate-node:latest/s' \
  "$container_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'provenance container mutation is rejected' \
  "$container_root" \
  'must not use container or service execution overrides' \
  "$TEST_ROOT/container.out"

diagnostic_step_root="$TEST_ROOT/provenance-diagnostic-step"
copy_workflows "$diagnostic_step_root"
perl -0pi -e 's/(      - name: Require successful CI push run for exact SHA)/      - name: Harmless provenance diagnostic\n        run: echo provenance-check\n\n$1/' \
  "$diagnostic_step_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'pre-helper provenance step mutation is rejected' \
  "$diagnostic_step_root" \
  'must contain exactly trusted checkout followed by the helper' \
  "$TEST_ROOT/diagnostic-step.out"

candidate_overwrite_root="$TEST_ROOT/provenance-candidate-overwrite"
copy_workflows "$candidate_overwrite_root"
perl -0pi -e 's/(      - name: Require successful CI push run for exact SHA)/      - name: Replace verifier from candidate data\n        run: git show "\$SOURCE_SHA:scripts\/ci\/require-successful-ci-run.mjs" > scripts\/ci\/require-successful-ci-run.mjs\n\n$1/' \
  "$candidate_overwrite_root/.github/workflows/exact-ci-provenance.yml"
assert_contract_mutation_rejected \
  'candidate verifier overwrite step mutation is rejected' \
  "$candidate_overwrite_root" \
  'must contain exactly trusted checkout followed by the helper' \
  "$TEST_ROOT/candidate-overwrite.out"

promotion_overwrite_root="$TEST_ROOT/promotion-candidate-overwrite"
copy_workflows "$promotion_overwrite_root"
perl -0pi -e 's/(      - name: Fetch the selected release commit as data)/      - name: Replace promoter from selected data\n        env:\n          TAG_SHA: \$\{\{ needs.resolve-release-ref.outputs.sha \}\}\n        run: git show "\$TAG_SHA:scripts\/release\/promote-release-images.sh" > scripts\/release\/promote-release-images.sh\n\n$1/' \
  "$promotion_overwrite_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'candidate promotion overwrite step mutation is rejected' \
  "$promotion_overwrite_root" \
  'must keep the trusted five-step execution topology' \
  "$TEST_ROOT/promotion-overwrite.out"

resolver_rebind_root="$TEST_ROOT/resolver-trusted-sha-rebind"
copy_workflows "$resolver_rebind_root"
perl -0pi -e 's/(echo "sha=\$sha" >> "\$GITHUB_OUTPUT"\n)/$1          trusted_sha="\$RELEASE_REF"\n/' \
  "$resolver_rebind_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'selected ref cannot rebind the trusted executable SHA' \
  "$resolver_rebind_root" \
  'bind trusted SHA to checkout HEAD' \
  "$TEST_ROOT/resolver-rebind.out"

crane_alias_root="$TEST_ROOT/crane-selected-sha-alias"
copy_workflows "$crane_alias_root"
perl -0pi -e 's/(- name: Install crane\n)(        run:)/$1        env:\n          CANDIDATE_SHA: \$\{\{ needs.resolve-release-ref.outputs.sha \}\}\n$2/; s/(          crane version)/          git show "\$CANDIDATE_SHA:scripts\/release\/promote-release-images.sh" > scripts\/release\/promote-release-images.sh\n$1/' \
  "$crane_alias_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'crane setup cannot alias selected data into the promoter' \
  "$crane_alias_root" \
  'retain the trusted crane installation step' \
  "$TEST_ROOT/crane-alias.out"

release_defaults_root="$TEST_ROOT/release-workflow-defaults"
copy_workflows "$release_defaults_root"
perl -0pi -e 's/\njobs:/\ndefaults:\n  run:\n    working-directory: candidate-source\n\njobs:/' \
  "$release_defaults_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'release workflow working-directory defaults are rejected' \
  "$release_defaults_root" \
  'must not use execution-environment overrides' \
  "$TEST_ROOT/release-defaults.out"

release_guard_root="$TEST_ROOT/release-trust-guard-mask"
copy_workflows "$release_guard_root"
perl -0pi -e 's/(github\.workflow_sha == github\.sha\)\))/\1 || true/g' \
  "$release_guard_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'release trust guards masked with true are rejected' \
  "$release_guard_root" \
  'release resolver event guard violates trust table' \
  "$TEST_ROOT/release-guard.out"

release_special_branch_root="$TEST_ROOT/release-special-branch-guard"
copy_workflows "$release_special_branch_root"
perl -0pi -e \
  "s/(github\.workflow_sha == github\.sha\)\))/\1 || github.ref == 'refs\/heads\/pwn'/g" \
  "$release_special_branch_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'release guard for one specially named branch is rejected' \
  "$release_special_branch_root" \
  'release resolver event guard violates trust table' \
  "$TEST_ROOT/release-special-branch.out"

release_trigger_root="$TEST_ROOT/release-branch-trigger"
copy_workflows "$release_trigger_root"
perl -0pi -e "s/tags: \['v\*'\]/branches: ['main']/" \
  "$release_trigger_root/.github/workflows/release-images.yml"
assert_contract_mutation_rejected \
  'release branch-push trigger mutation is rejected' \
  "$release_trigger_root" \
  'release workflow must trigger only on v* tags' \
  "$TEST_ROOT/release-trigger.out"

formatter_root="$TEST_ROOT/formatter-terminal"
copy_workflows "$formatter_root"
perl -0pi -e 's/\[ "\$PRETTIER_RESULT" = success \]/printf "prettier=%%s\\n" "\$PRETTIER_RESULT"/' \
  "$formatter_root/.github/workflows/prettier-source-preflight.yml"
assert_terminal_mutation_rejected \
  'formatter terminal comparison mutation is rejected' \
  "$formatter_root"

provenance_root="$TEST_ROOT/provenance-terminal"
copy_workflows "$provenance_root"
perl -0pi -e 's/\[ "\$PROVENANCE_RESULT" = success \]/printf "provenance=%%s\\n" "\$PROVENANCE_RESULT"/' \
  "$provenance_root/.github/workflows/exact-ci-provenance.yml"
assert_terminal_mutation_rejected \
  'exact-provenance terminal comparison mutation is rejected' \
  "$provenance_root"

push_root="$TEST_ROOT/push-terminal"
copy_workflows "$push_root"
perl -0pi -e 's/\[ "\$DIFF_RESULT" = success \] && \[ "\$PROVENANCE_RESULT" = skipped \]/printf "push=%%s,%%s\\n" "\$DIFF_RESULT" "\$PROVENANCE_RESULT"/' \
  "$push_root/.github/workflows/build-publish.yml"
assert_terminal_mutation_rejected \
  'push publication terminal comparison mutation is rejected' \
  "$push_root"

dispatch_root="$TEST_ROOT/dispatch-terminal"
copy_workflows "$dispatch_root"
perl -0pi -e 's/\[ "\$PROVENANCE_RESULT" = success \]/printf "dispatch=%%s,%%s\\n" "\$DIFF_RESULT" "\$PROVENANCE_RESULT"/' \
  "$dispatch_root/.github/workflows/build-publish.yml"
assert_terminal_mutation_rejected \
  'workflow-dispatch terminal comparison mutation is rejected' \
  "$dispatch_root"

exit "$FAIL"
