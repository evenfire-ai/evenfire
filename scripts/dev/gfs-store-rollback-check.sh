#!/usr/bin/env bash
# Runs the real GFS download store of the pre-#1028 image (dev 74e0d81d9) next
# to the #1028 store of this checkout, locally, with no cluster:
#
#   1. legacy-crash    the dev store writes completed, missing and transferring
#                      records plus an expired and a live processing lease, and
#                      its process is killed                    -> snapshot "crashed"
#   2. legacy-restart  the dev Host startup (bootstrapGfsRuntime) reopens that
#                      volume: every record quarantined, the store unavailable
#                      (#1019), then a clean stop               -> snapshot "restarted"
#   3. new-state       the #1028 store starts on "restarted", leaves a retired dev
#                      store and a .gfs-downloads.trash-* (one injected rm failure
#                      each), a published download and an incomplete transfer,
#                      and its process is killed
#   4. old-on-new      rollback: the dev Host starts on that state, completes a
#                      download into the same caller root and runs its sweep;
#                      every entry the #1028 store left must be byte-identical after
#   5. roll-forward    the #1028 store starts on the post-rollback volume
#
# Usage (from anywhere in the checkout; Node 24 on PATH):
#   scripts/dev/gfs-store-rollback-check.sh                  # checks only
#   scripts/dev/gfs-store-rollback-check.sh --write-fixture  # also rewrites
#       mcp-host/src/__tests__/fixtures/dev-gfs-store-74e0d81d9/{crashed,restarted,generation.json}
#
# Exit 0 only when every phase exited as expected and reported at least one
# assertion and no failure. Logs and results stay in the printed work directory.
set -euo pipefail

OLD_COMMIT=74e0d81d9
WRITE_FIXTURE=false
case "${1:-}" in
  '') ;;
  --write-fixture) WRITE_FIXTURE=true ;;
  *) echo "usage: $0 [--write-fixture]" >&2; exit 2 ;;
esac

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" != "24" ]; then
  echo "FAIL: Node 24 is required, found $(node -v)" >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
DRIVER="$ROOT/scripts/dev/gfs-store-rollback-check.driver.cjs"
FIXTURE="$ROOT/mcp-host/src/__tests__/fixtures/dev-gfs-store-${OLD_COMMIT}"
WORK=$(mktemp -d /tmp/gfs-store-rollback.XXXXXX)
mkdir -p "$WORK/old" "$WORK/logs" "$WORK/results"
echo "WORK=$WORK"

# Runs one command, log to $WORK/logs/<name>.log, and fails unless its exit
# code is the expected one.
step() {
  local name=$1 expected=$2
  shift 2
  set +e
  "$@" > "$WORK/logs/$name.log" 2>&1
  local rc=$?
  set -e
  echo "STEP $name EXIT=$rc (expected $expected)"
  if [ "$rc" != "$expected" ]; then
    echo "FAIL: $name; last log lines:" >&2
    tail -n 40 "$WORK/logs/$name.log" >&2
    exit 1
  fi
}

# A phase result must report assertions > 0 and failed == 0.
verify() {
  local name=$1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    if (!(r.assertions > 0) || r.failed !== 0) {
      console.error(`FAIL: ${process.argv[2]} assertions=${r.assertions} failed=${r.failed}`)
      process.exit(1)
    }
    console.log(`PHASE ${process.argv[2]} assertions=${r.assertions} failed=0`)
  ' "$WORK/results/$name.json" "$name"
}

phase() {
  local name=$1 expected=$2
  shift 2
  step "$name" "$expected" node "$DRIVER" "$name" "$@"
  verify "$name"
}

new_phase() {
  local name=$1 expected=$2
  shift 2
  step "$name" "$expected" env NODE_PATH="$NEW_NODE_PATH" node "$DRIVER" "$name" "$@"
  verify "$name"
}

# The dev store, exactly as committed at 74e0d81d9, built the way its
# mcp-host/Dockerfile builds it: the file: dependencies in packages/ sit next
# to mcp-host/, then npm ci and tsc -p tsconfig.build.json.
git -C "$ROOT" archive "$OLD_COMMIT" mcp-host packages | tar -x -C "$WORK/old"
OLD="$WORK/old/mcp-host"
# npm ci runs from the package directory (a subshell keeps this script's cwd):
# with --prefix, npm 11 reads the lockfile as if mcp-host were a dependency.
old_npm_ci() ( cd "$OLD" && npm ci --no-audit --no-fund )
step old-npm-ci 0 old_npm_ci
step old-sqlite-loads 0 node -e "new (require('$OLD/node_modules/better-sqlite3'))(':memory:').close()"
step old-build 0 "$OLD/node_modules/.bin/tsc" -p "$OLD/tsconfig.build.json"

# The #1028 store from this working tree, compiled outside the checkout.
NEW_DIST="$WORK/new-dist"
step new-build 0 "$ROOT/mcp-host/node_modules/.bin/tsc" -p "$ROOT/mcp-host/tsconfig.build.json" --outDir "$NEW_DIST"
# The compiled #1028 store resolves its packages from this checkout.
NEW_NODE_PATH="$ROOT/mcp-host/node_modules"

LEGACY="$WORK/legacy-host"
R="$WORK/results"
# 137 = SIGKILL: the crash phases kill their own process after writing results.
phase legacy-crash 137 "$OLD/dist" "$LEGACY" "$R/legacy-crash.json"
cp -Rp "$LEGACY" "$WORK/snapshot-crashed"
phase legacy-restart 0 "$OLD/dist" "$LEGACY" "$R/legacy-restart.json"
cp -Rp "$LEGACY" "$WORK/snapshot-restarted"

HOST="$WORK/rollback-host"
cp -Rp "$WORK/snapshot-restarted" "$HOST"
new_phase new-state 137 "$NEW_DIST" "$HOST" "$R/new-state.json"
step manifest-before 0 node "$DRIVER" manifest "$HOST" "$R/manifest-before.json"
verify manifest-before
phase old-on-new 0 "$OLD/dist" "$HOST" "$R/old-on-new.json" "$R/new-state.json"
step manifest-after 0 node "$DRIVER" manifest "$HOST" "$R/manifest-after.json"
verify manifest-after
phase compare 0 "$R/manifest-before.json" "$R/manifest-after.json" "$R/compare.json"
new_phase roll-forward 0 "$NEW_DIST" "$HOST" "$R/roll-forward.json"

node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  console.log(`ROLLBACK added_by_dev_store=${r.added.length}: ${r.added.join(" ")}`)
' "$R/compare.json"

if [ "$WRITE_FIXTURE" = true ]; then
  mkdir -p "$FIXTURE"
  step write-fixture 0 node "$DRIVER" write-fixture "$WORK/snapshot-crashed" \
    "$WORK/snapshot-restarted" "$R/legacy-crash.json" "$R/legacy-restart.json" \
    "$(git -C "$ROOT" rev-parse "$OLD_COMMIT")" "$FIXTURE" "$R/write-fixture.json"
  verify write-fixture
  echo "FIXTURE=$FIXTURE"
fi

echo "GFS_STORE_ROLLBACK_CHECK_PASS"
