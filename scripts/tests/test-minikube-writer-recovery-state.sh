#!/usr/bin/env bash
# Durable writer recovery state must be atomic, private, identity-bound, and
# safe to resume without sourcing shell-controlled content.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HELPER="$ROOT/scripts/minikube/writer-recovery-state.py"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-writer-state.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT
STATE="$TMP_DIR/recovery.json"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
pass() {
  printf 'PASS: %s\n' "$1"
}

identity=(
  --path "$STATE"
  --profile profile-state
  --context profile-state
  --worktree "$TMP_DIR"
  --branch fix/state
  --head 0123456789abcdef
)

python3 "$HELPER" write "${identity[@]}" --phase planned --hcc 1 --workflow 1 --trace 1 --control-api 1
mode="$(stat -f '%Lp' "$STATE" 2>/dev/null || stat -c '%a' "$STATE")"
[[ "$mode" == 600 ]] || fail "state mode is $mode, expected 600"
python3 "$HELPER" read "${identity[@]}" | grep -Fxq 'planned|1|1|1|1' ||
  fail 'planned state did not round-trip with exact replicas'
pass 'writer recovery state is private and round-trips atomically'

python3 "$HELPER" write "${identity[@]}" --phase api-fencing --hcc 1 --workflow 2 --trace 1 --control-api 1
python3 "$HELPER" read "${identity[@]}" | grep -Fxq 'api-fencing|1|2|1|1' ||
  fail 'fencing phase did not preserve original replicas'
for phase in api-restoring overlay-applying; do
  python3 "$HELPER" write "${identity[@]}" --phase "$phase" --hcc 1 --workflow 2 --trace 1 --control-api 1
  python3 "$HELPER" read "${identity[@]}" | grep -Fxq "${phase}|1|2|1|1" ||
    fail "${phase} phase did not round-trip"
done
python3 "$HELPER" read "${identity[@]}" --head fedcba9876543210 | grep -Fxq 'overlay-applying|1|2|1|1' ||
  fail 'state did not resume under a different HEAD on the same owned lane'
[[ -s "$STATE" ]] || fail 'identity mismatch destroyed durable state'
pass 'writer recovery state preserves lane identity while retaining historical HEAD'

python3 "$HELPER" clear "${identity[@]}"
[[ ! -e "$STATE" ]] || fail 'clear left durable writer recovery state behind'
pass 'writer recovery state clears only after the recovery boundary completes'

printf 'PASS: Minikube writer recovery state contract\n'
