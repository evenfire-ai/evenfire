#!/usr/bin/env bash
# check-tracked-ignored-files.sh on throwaway repositories, and its required step in the
# Repo hygiene job.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CHECK="$REPO_ROOT/scripts/ci/check-tracked-ignored-files.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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
  tests/e2e/test-results/.gitignore
)

# A repository shaped like this one: the same ignore rules, the four allowlisted files
# force-added, and one ordinary tracked file. Seven tracked files in all.
make_repo() { # <dir>
  mkdir -p "$1"
  (
    cd "$1"
    git_q init -q -b dev
    printf '**/test-results/\n.local-notes/\n' >.gitignore
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
  'Checked 7 tracked files: 4 match a .gitignore, all allowlisted.'

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
  'Checked 7 tracked files: 4 match a .gitignore, all allowlisted.'
: >"$GIT_CONFIG_GLOBAL"

# 8. A repository with no tracked files has nothing to inspect: fail.
mkdir -p "$WORK/empty"
git_q -C "$WORK/empty" init -q -b dev
expect_run 'no tracked files' "$WORK/empty" 1 'No tracked files found'

# 9. Outside a git repository the check fails instead of passing on an empty listing.
mkdir -p "$WORK/not-a-repo"
not_repo_exit=0
(cd "$WORK/not-a-repo" && GIT_CEILING_DIRECTORIES="$WORK" bash "$CHECK" >/dev/null 2>&1) || not_repo_exit=$?
if [ "$not_repo_exit" -ne 0 ]; then pass; else fail 'outside a git repository: exit 0'; fi

# 10. The Repo hygiene job runs the check and this test.
hygiene_job="$(awk '/^  repo-hygiene:/{in_job=1; next} in_job && /^  [A-Za-z0-9_-]+:/{exit} in_job' \
  "$REPO_ROOT/.github/workflows/ci-public.yml")"
for step in 'run: bash scripts/ci/check-tracked-ignored-files.sh' \
  'run: bash scripts/tests/test-check-tracked-ignored-files.sh'; do
  if printf '%s\n' "$hygiene_job" | grep -qF -- "$step"; then
    pass
  else
    fail "repo-hygiene job lacks '$step'"
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
