#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run_case() {
  local mode="$1" expected="$2" fake log rc
  fake="$(mktemp -d)"
  log="$fake/calls"
  cat >"$fake/kubectl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
  case " $* " in
  *' get secret gfs-controller-db '*)
    case "$FAKE_MODE" in
      existing) printf 'secret/gfs-controller-db\n'; exit 0 ;;
      absent) printf 'Error from server (NotFound): secrets "gfs-controller-db" not found\n' >&2; exit 1 ;;
      forbidden) printf 'Error from server (Forbidden): denied\n' >&2; exit 1 ;;
      namespace-absent) printf 'Error from server (NotFound): namespaces "gfs" not found\n' >&2; exit 1 ;;
      namespace-forbidden) printf 'Error from server (Forbidden): namespaces "gfs" is forbidden\n' >&2; exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
SH
  chmod +x "$fake/kubectl"
  set +e
  PATH="$fake:$PATH" FAKE_LOG="$log" FAKE_MODE="$mode" CONTEXT=fake \
    bash "$ROOT/deploy/scripts/apply-gfs-writer-secret.sh" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq "$expected" ] || fail "$mode returned $rc, expected $expected"
  if [ "$mode" = namespace-absent ]; then
    ! grep -q 'apply -f' "$log" || fail 'fresh namespace bootstrap applied a namespaced Secret too early'
  elif [ "$mode" = namespace-forbidden ]; then
    ! grep -q 'apply -f' "$log" || fail 'namespace API denial reached apply'
  elif [ "$mode" = existing ]; then
    [ "$(grep -n 'apply set-last-applied' "$log" | cut -d: -f1)" -lt \
      "$(grep -n 'apply -f' "$log" | cut -d: -f1)" ] || fail 'legacy ownership was not migrated before apply'
  elif [ "$mode" = absent ]; then
    ! grep -q 'apply set-last-applied' "$log" || fail 'fresh bootstrap attempted legacy migration'
    grep -q 'apply -f' "$log" || fail 'fresh bootstrap did not create Secret'
  else
    ! grep -q 'apply -f' "$log" || fail 'API denial was treated as absence'
  fi
  rm -rf "$fake"
}

run_case existing 0
run_case absent 0
run_case forbidden 1
run_case namespace-absent 1
run_case namespace-forbidden 1
printf 'PASS: GFS writer Secret apply preserves legacy data ownership\n'
