#!/bin/sh
# Verbatim render of buildWorkspaceLayoutInitScript() at 87f962fb9 (base of
# issue #825), with the PVC root taken from "$1". Used only by tests to
# reproduce the split layout and the rollback round trip.
set -eu
root="$1"
fail_layout() {
  echo "workspace layout migration unsafe: $1" >&2
  exit 1
}
canonical_dir() {
  (CDPATH= cd -P "$1" 2>/dev/null && pwd -P)
}
assert_managed_dir() {
  path="$1"
  label="$2"
  [ ! -L "$path" ] || fail_layout "$label directory is a symlink: $path"
  [ -d "$path" ] || fail_layout "$label path is not a directory: $path"
  resolved="$(canonical_dir "$path")" || fail_layout "cannot resolve $label directory: $path"
  case "$resolved" in
    "$root_real"/*) ;;
    *) fail_layout "$label directory escapes the workspace PVC root: $path" ;;
  esac
}

[ ! -L "$root" ] || fail_layout "workspace PVC root is a symlink: $root"
[ -d "$root" ] || fail_layout "workspace PVC root is not a directory: $root"
root_real="$(canonical_dir "$root")" || fail_layout "cannot resolve workspace PVC root: $root"
[ "$root_real" != "/" ] || fail_layout "workspace PVC root resolves to /"

# Validate both managed paths before creating either one. A symlink or regular
# file must never redirect a migration outside the mounted PVC.
for dir in workspace state; do
  path="$root/$dir"
  [ ! -L "$path" ] || fail_layout "$dir directory is a symlink: $path"
  if [ -e "$path" ] && [ ! -d "$path" ]; then
    fail_layout "$dir path is not a directory: $path"
  fi
done
for dir in workspace state; do
  path="$root/$dir"
  [ -d "$path" ] || mkdir "$path"
  assert_managed_dir "$path" "$dir"
done
# Validate every destination before the first rename: a later SQLite collision
# must not leave earlier root entries moved into a partial layout.
for entry in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  base="$(basename "$entry")"
  case "$base" in
    workspace|state|lost+found) continue ;;
  esac
  [ ! -L "$entry" ] || fail_layout "legacy source is a symlink: $entry"
  case "$base" in
    state.db|state.db-wal|state.db-shm) continue ;;
  esac
  if [ -e "$root/workspace/$base" ] || [ -L "$root/workspace/$base" ]; then
    echo "workspace layout migration collision: destination exists: $root/workspace/$base" >&2
    exit 1
  fi
done
root_sqlite_source=0
workspace_sqlite_source=0
for db in state.db state.db-wal state.db-shm; do
  [ ! -L "$root/$db" ] || fail_layout "legacy SQLite source is a symlink: $root/$db"
  [ ! -L "$root/workspace/$db" ] || fail_layout "workspace SQLite source is a symlink: $root/workspace/$db"
  [ ! -L "$root/state/$db" ] || fail_layout "durable SQLite destination is a symlink: $root/state/$db"
  if [ -e "$root/$db" ] || [ -L "$root/$db" ]; then root_sqlite_source=1; fi
  if [ -e "$root/workspace/$db" ] || [ -L "$root/workspace/$db" ]; then workspace_sqlite_source=1; fi
done
if [ "$root_sqlite_source" -eq 1 ] && [ "$workspace_sqlite_source" -eq 1 ]; then
  echo "workspace layout migration collision: SQLite artifacts are split across root and workspace" >&2
  exit 1
fi
# Newest-source-wins round-trip resolution (Addendum 6 item 6). A confirmed ROOT
# SQLite source colliding with an existing durable state/ destination is a
# stateful<->stateless round-trip: the operator just left the stateful life
# (root state.db is the freshest data) over an earlier stateless life's
# state/state.db. Preserve the older destination as state/<db>.pre-<ts>.bak
# (NOTHING is ever deleted), then let the fresher root source migrate in via the
# normal path below. The destination is proven non-symlink above.
# WHY positional implies temporal: every stateless boot MOVES the SQLite set out
# of root into state/ (the mv loops below), so root is left with no state.db. A
# root state.db can therefore only have been (re)created by a STATEFUL life that
# ran strictly AFTER the last stateless life — which is what makes "root source"
# equivalent to "newer source" here, with no timestamp read required.
root_dest_collision=0
if [ "$root_sqlite_source" -eq 1 ]; then
  for db in state.db state.db-wal state.db-shm; do
    if [ -e "$root/state/$db" ] || [ -L "$root/state/$db" ]; then root_dest_collision=1; fi
  done
fi
if [ "$root_dest_collision" -eq 1 ]; then
  # One timestamped backup namespace per collision; guard uniqueness so two
  # round-trips within the same second (or a re-collision) never overwrite an
  # existing backup.
  bak_ts="$(date -u +%Y%m%d%H%M%S)"
  bak_suffix="$bak_ts"
  bak_seq=0
  while [ -e "$root/state/state.db.pre-$bak_suffix.bak" ]     || [ -e "$root/state/state.db-wal.pre-$bak_suffix.bak" ]     || [ -e "$root/state/state.db-shm.pre-$bak_suffix.bak" ]; do
    bak_seq=$((bak_seq + 1))
    bak_suffix="$bak_ts-$bak_seq"
  done
  backed_up=""
  for db in state.db state.db-wal state.db-shm; do
    if [ -e "$root/state/$db" ]; then
      mv "$root/state/$db" "$root/state/$db.pre-$bak_suffix.bak"
      backed_up="$backed_up $db"
    fi
  done
  echo "workspace layout migration: newest-source-wins round-trip resolution -- backed up prior destination(s)$backed_up under state/*.pre-$bak_suffix.bak; migrating the fresher root SQLite source into state/" >&2
fi
# A WORKSPACE SQLite source colliding with the durable destination is a genuinely
# ambiguous partial-migration state (not a clean round-trip): fail loud,
# preserving every source for operator recovery.
for db in state.db state.db-wal state.db-shm; do
  if [ -e "$root/workspace/$db" ] || [ -L "$root/workspace/$db" ]; then
    if [ -e "$root/state/$db" ] || [ -L "$root/state/$db" ]; then
      echo "workspace layout migration collision: destination exists: $root/state/$db" >&2
      exit 1
    fi
  fi
done
for entry in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  base="$(basename "$entry")"
  case "$base" in
    workspace|state|lost+found) continue ;;
  esac
  assert_managed_dir "$root/workspace" workspace
  [ ! -L "$entry" ] || fail_layout "legacy source became a symlink: $entry"
  mv "$entry" "$root/workspace/$base"
done
for db in state.db state.db-wal state.db-shm; do
  if [ -e "$root/workspace/$db" ]; then
    assert_managed_dir "$root/workspace" workspace
    assert_managed_dir "$root/state" state
    [ ! -L "$root/workspace/$db" ] || fail_layout "workspace SQLite source became a symlink: $root/workspace/$db"
    mv "$root/workspace/$db" "$root/state/$db"
  fi
done
sync
