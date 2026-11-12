#!/usr/bin/env bash
# check-tracked-ignored-files.sh on throwaway repositories, and its required steps in the
# Repo hygiene job.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CHECK="$REPO_ROOT/scripts/ci/check-tracked-ignored-files.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Run inside a git hook, or with GIT_DIR set, git would act on the caller's repository: every
# fixture commit would land there. Drop the variables that point git at a repository, as
# git-sh-setup's clear_local_git_env does. The list is captured first so that a failed
# git rev-parse stops the test instead of unsetting nothing.
git_local_env="$(git rev-parse --local-env-vars)"
# shellcheck disable=SC2086 # One variable name per word.
unset $git_local_env

# Keep the developer's own git configuration (global excludes, hooks) out of every case.
export GIT_CONFIG_GLOBAL="$WORK/empty-gitconfig"
export GIT_CONFIG_NOSYSTEM=1
: >"$GIT_CONFIG_GLOBAL"

TESTS_RUN=0
TESTS_FAILED=0
pass() { TESTS_RUN=$((TESTS_RUN + 1)); }
fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "FAIL: $1" >&2
}

git_q() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

ALLOWED_FILES=(
  deploy/overlays/minikube/secrets/inter-service-tokens.yaml
  deploy/overlays/minikube/secrets/llm-api-keys.yaml
  deploy/overlays/minikube/secrets/search-api-keys.yaml
)

# A repository shaped like this one: the same ignore rules, the three allowlisted files
# force-added, and one ordinary tracked file. Six tracked files in all.
make_repo() { # <dir>
  mkdir -p "$1"
  (
    cd "$1"
    git_q init -q -b dev
    printf '.local-notes/\n' >.gitignore
    mkdir -p deploy src
    printf 'overlays/*/secrets/\n' >deploy/.gitignore
    echo app >src/app.txt
    local file
    for file in "${ALLOWED_FILES[@]}"; do
      mkdir -p "$(dirname "$file")"
      echo fixture >"$file"
    done
    git_q add .gitignore deploy/.gitignore src/app.txt
    git_q add -f "${ALLOWED_FILES[@]}"
    git_q commit -q -m base
  )
}

expect_run() { # <name> <dir> <want-exit> <want-output>
  local name="$1" dir="$2" want_exit="$3" want_output="$4" exit_code=0 output
  output="$(cd "$dir" && bash "$CHECK" 2>&1)" || exit_code=$?
  if [ "$exit_code" -ne "$want_exit" ]; then
    fail "$name: exit $exit_code, want $want_exit: $output"
  elif ! printf '%s' "$output" | grep -qF -- "$want_output"; then
    fail "$name: output lacks '$want_output': $output"
  else
    pass
  fi
}

# 1. Only the allowlisted files are tracked and ignored: pass, and say how much was read.
make_repo "$WORK/clean"
expect_run 'allowlisted files only' "$WORK/clean" 0 \
  'Checked 6 tracked files: 3 match a .gitignore, all allowlisted.'

# 2. A force-added file under an ignored directory, as in 126f1b889.
make_repo "$WORK/force-added"
mkdir -p "$WORK/force-added/.local-notes"
echo handoff >"$WORK/force-added/.local-notes/handoff.md"
git_q -C "$WORK/force-added" add -f .local-notes/handoff.md
expect_run 'force-added file in an ignored directory' "$WORK/force-added" 1 '.local-notes/handoff.md'

# 3. A rule in a nested .gitignore counts as much as the root one.
make_repo "$WORK/nested"
printf 'secret.txt\n' >"$WORK/nested/src/.gitignore"
echo secret >"$WORK/nested/src/secret.txt"
git_q -C "$WORK/nested" add src/.gitignore
git_q -C "$WORK/nested" add -f src/secret.txt
expect_run 'file ignored by a nested .gitignore' "$WORK/nested" 1 'src/secret.txt'

# 4. A path with a space is reported whole.
make_repo "$WORK/space"
mkdir -p "$WORK/space/.local-notes"
echo note >"$WORK/space/.local-notes/my note.md"
git_q -C "$WORK/space" add -f '.local-notes/my note.md'
expect_run 'path with a space' "$WORK/space" 1 '.local-notes/my note.md'

# 5. An allowlisted file that is no longer tracked makes the entry stale.
make_repo "$WORK/untracked-entry"
git_q -C "$WORK/untracked-entry" rm -q --cached deploy/overlays/minikube/secrets/search-api-keys.yaml
expect_run 'allowlisted file no longer tracked' "$WORK/untracked-entry" 1 \
  'Allowlist entries that are no longer both tracked and ignored'
expect_run 'stale entry is named' "$WORK/untracked-entry" 1 \
  'deploy/overlays/minikube/secrets/search-api-keys.yaml'

# 6. An allowlisted file that no rule ignores any more makes the entry stale.
make_repo "$WORK/unignored-entry"
: >"$WORK/unignored-entry/deploy/.gitignore"
expect_run 'allowlisted file no longer ignored' "$WORK/unignored-entry" 1 \
  'deploy/overlays/minikube/secrets/llm-api-keys.yaml'

# 7. A developer's global excludes file and .git/info/exclude do not change the verdict.
make_repo "$WORK/local-excludes"
printf 'app.txt\n' >"$WORK/global-excludes"
git config --file "$GIT_CONFIG_GLOBAL" core.excludesFile "$WORK/global-excludes"
printf 'src/\n' >>"$WORK/local-excludes/.git/info/exclude"
expect_run 'local exclude sources are not read' "$WORK/local-excludes" 0 \
  'Checked 6 tracked files: 3 match a .gitignore, all allowlisted.'
: >"$GIT_CONFIG_GLOBAL"

# 8. core.ignorecase does not change the verdict. git init sets it to true on macOS and the
# CI runner leaves it false; the check matches case-sensitively, as CI does.
make_repo "$WORK/ignorecase"
printf 'SRC/\n' >>"$WORK/ignorecase/.gitignore"
git_q -C "$WORK/ignorecase" commit -q -a -m 'ignore SRC/'
git_q -C "$WORK/ignorecase" config core.ignorecase true
# Witness: with case folded, SRC/ does match the tracked src/app.txt, so the run below can fail.
if git_q -C "$WORK/ignorecase" check-ignore -q --no-index src/app.txt; then
  expect_run 'core.ignorecase=true does not fold case' "$WORK/ignorecase" 0 \
    'Checked 6 tracked files: 3 match a .gitignore, all allowlisted.'
else
  fail 'core.ignorecase fixture: SRC/ does not match src/app.txt with core.ignorecase=true'
fi

# 9. A repository with no tracked files has nothing to inspect: fail.
mkdir -p "$WORK/empty"
git_q -C "$WORK/empty" init -q -b dev
expect_run 'no tracked files' "$WORK/empty" 1 'No tracked files found'

# 10. Outside a git repository the check fails instead of passing on an empty listing.
mkdir -p "$WORK/not-a-repo"
not_repo_exit=0
(cd "$WORK/not-a-repo" && GIT_CEILING_DIRECTORIES="$WORK" bash "$CHECK" >/dev/null 2>&1) || not_repo_exit=$?
if [ "$not_repo_exit" -ne 0 ]; then pass; else fail 'outside a git repository: exit 0'; fi

# 11. The Repo hygiene job runs the check and this test as plain steps: exactly these commands,
# in that job only, once, with no key (if, continue-on-error, shell, env, working-directory)
# that could skip or soften them. The job's own keys and the workflow's top-level defaults and
# env are pinned by scripts/tests/test-validate-release-version-bumps.sh, which runs in this job
# on pull requests into dev.
for step in 'bash scripts/ci/check-tracked-ignored-files.sh' \
  'bash scripts/tests/test-check-tracked-ignored-files.sh'; do
  # shellcheck disable=SC2016 # Ruby source.
  if pin_output="$(RUBYOPT=--disable=gems ruby -ryaml -e '
    command = ARGV.fetch(1)
    jobs = YAML.load_file(ARGV.fetch(0)).fetch("jobs")
    holders = jobs.select { |_, job| job.fetch("steps", []).any? { |s| s["run"] == command } }.keys
    abort("runs in #{holders}, want only repo-hygiene") unless holders == ["repo-hygiene"]
    steps = jobs.fetch("repo-hygiene").fetch("steps").select { |s| s["run"] == command }
    abort("runs in #{steps.size} steps, want 1") unless steps.size == 1
    abort("the step has other keys: #{steps[0].keys}") unless steps[0].keys.sort == %w[name run]
  ' "$REPO_ROOT/.github/workflows/ci-public.yml" "$step" 2>&1)"; then
    pass
  else
    fail "repo-hygiene step '$step': $pin_output"
  fi
done

if [ "$TESTS_RUN" -eq 0 ]; then
  echo 'FAIL: no test ran' >&2
  exit 1
fi
if [ "$TESTS_FAILED" -ne 0 ]; then
  echo "$TESTS_FAILED of $TESTS_RUN checks failed" >&2
  exit 1
fi
echo "check-tracked-ignored-files: $TESTS_RUN checks passed"
