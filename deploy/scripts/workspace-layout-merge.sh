# shellcheck shell=sh
set -eu
root='/mnt/workspace-root'
fail_merge() {
  echo "workspace layout merge refused: $1" >&2
  exit 1
}
present() {
  [ -e "$1" ] || [ -L "$1" ]
}
canonical_dir() {
  (CDPATH= cd -P "$1" 2>/dev/null && pwd -P)
}
assert_managed_dir() {
  path="$1"
  label="$2"
  [ ! -L "$path" ] || fail_merge "$label directory is a symlink: $path"
  [ -d "$path" ] || fail_merge "$label path is not a directory: $path"
  resolved="$(canonical_dir "$path")" || fail_merge "cannot resolve $label directory: $path"
  case "$resolved" in
    "$root_real"/*) ;;
    *) fail_merge "$label directory escapes the workspace PVC root: $path" ;;
  esac
}
is_empty_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  listing="$(ls -A "$1" 2>/dev/null)" || fail_merge "cannot list directory: $1"
  [ -z "$listing" ]
}
has_main() {
  present "$1/state.db"
}
has_journal() {
  present "$1/state.db-wal" || present "$1/state.db-shm"
}

[ ! -L "$root" ] || fail_merge "workspace PVC root is a symlink: $root"
[ -d "$root" ] || fail_merge "workspace PVC root is not a directory: $root"
root_real="$(canonical_dir "$root")" || fail_merge "cannot resolve workspace PVC root: $root"
[ "$root_real" != "/" ] || fail_merge "workspace PVC root resolves to /"

# Split-layout signature: real state/ and workspace/ directories, and a
# database entry under state/.
[ ! -L "$root/state" ] && [ -d "$root/state" ] || exit 0
[ ! -L "$root/workspace" ] && [ -d "$root/workspace" ] || exit 0
# The globs cannot see the entries of a state/ they cannot list or search.
[ -r "$root/state" ] && [ -x "$root/state" ] ||
  fail_merge "state directory is not readable and searchable: $root/state"
# Only the names the earlier init writes count: the database, its journals
# and the .pre-<ts>.bak copy it keeps of each of them from an older source.
signature=0
for entry in "$root/state"/state.db "$root/state"/state.db-wal "$root/state"/state.db-shm \
  "$root/state"/state.db.pre-*.bak "$root/state"/state.db-wal.pre-*.bak "$root/state"/state.db-shm.pre-*.bak; do
  if present "$entry"; then signature=1; fi
done
[ "$signature" -eq 1 ] || exit 0

# F1
assert_managed_dir "$root/state" state
assert_managed_dir "$root/workspace" workspace
# The move globs cannot see the entries of a workspace/ they cannot list.
[ -r "$root/workspace" ] && [ -x "$root/workspace" ] ||
  fail_merge "workspace directory is not readable and searchable: $root/workspace"
for dir in "$root" "$root/state" "$root/workspace"; do
  for entry in "$dir"/state.db "$dir"/state.db-wal "$dir"/state.db-shm \
    "$dir"/state.db.pre-*.bak "$dir"/state.db-wal.pre-*.bak "$dir"/state.db-shm.pre-*.bak; do
    present "$entry" || continue
    [ ! -L "$entry" ] || fail_merge "SQLite file is a symlink: $entry"
    [ -f "$entry" ] || fail_merge "SQLite file is not a regular file: $entry"
  done
done

# Superseded split (T5): a stateless start moves the root database into
# state/, so a root state.db comes from a stateful run after the last
# stateless run and state/ holds the older history. Renaming state/ removes
# the signature, so later starts exit 0.
if has_main "$root" && { has_main "$root/state" || has_journal "$root/state"; } &&
  ! has_main "$root/workspace" && ! has_journal "$root/workspace"; then
  [ -w "$root" ] || fail_merge "not writable by uid $(id -u): $root"
  superseded="$root/state.db.superseded-$(date -u +%Y%m%dT%H%M%SZ)"
  ! present "$superseded" || fail_merge "destination exists: $superseded"
  mv "$root/state" "$superseded"
  sync
  exit 0
fi

# F2
live=0
root_live=0
workspace_live=0
if has_main "$root" || has_journal "$root"; then root_live=1; live=$((live + 1)); fi
if has_main "$root/state" || has_journal "$root/state"; then live=$((live + 1)); fi
if has_main "$root/workspace" || has_journal "$root/workspace"; then
  workspace_live=1
  live=$((live + 1))
fi
resume=0
if [ "$root_live" -eq 1 ] && ! has_main "$root" && has_main "$root/state" && [ "$workspace_live" -eq 0 ]; then
  resume=1
fi
if [ "$live" -gt 1 ] && [ "$resume" -eq 0 ]; then
  fail_merge "more than one live SQLite database across $root, $root/state and $root/workspace"
fi

# F3
! present "$root/workspace/lost+found" || fail_merge "workspace/lost+found would remain: $root/workspace/lost+found"
for entry in "$root/workspace"/* "$root/workspace"/.[!.]* "$root/workspace"/..?*; do
  present "$entry" || continue
  base="${entry##*/}"
  if present "$root/$base"; then
    if is_empty_dir "$entry" && [ -d "$root/$base" ] && [ ! -L "$root/$base" ]; then continue; fi
    fail_merge "destination exists: $root/$base"
  fi
done
for entry in "$root/state"/* "$root/state"/.[!.]* "$root/state"/..?*; do
  present "$entry" || continue
  base="${entry##*/}"
  if present "$root/$base"; then
    if is_empty_dir "$entry" && [ -d "$root/$base" ] && [ ! -L "$root/$base" ]; then continue; fi
    fail_merge "destination exists: $root/$base"
  fi
  if present "$root/workspace/$base"; then
    fail_merge "$base exists under both state/ and workspace/"
  fi
done

# F4
for dir in "$root" "$root/state" "$root/workspace"; do
  [ -w "$dir" ] || fail_merge "not writable by uid $(id -u): $dir"
done
# Renaming a directory to a new parent rewrites its .. entry, which needs
# write permission on the directory itself.
for entry in "$root/workspace"/* "$root/workspace"/.[!.]* "$root/workspace"/..?* \
  "$root/state"/* "$root/state"/.[!.]* "$root/state"/..?*; do
  [ -d "$entry" ] && [ ! -L "$entry" ] || continue
  ! present "$root/${entry##*/}" || continue
  [ -w "$entry" ] || fail_merge "not writable by uid $(id -u): $entry"
done

move_to_root() {
  entry="$1"
  base="${entry##*/}"
  assert_managed_dir "$root/state" state
  assert_managed_dir "$root/workspace" workspace
  if present "$root/$base"; then
    rmdir "$entry"
  else
    mv "$entry" "$root/$base"
  fi
}
for entry in "$root/workspace"/* "$root/workspace"/.[!.]* "$root/workspace"/..?*; do
  present "$entry" || continue
  move_to_root "$entry"
done
for entry in "$root/state"/* "$root/state"/.[!.]* "$root/state"/..?*; do
  present "$entry" || continue
  [ "${entry##*/}" != state.db ] || continue
  move_to_root "$entry"
done
if present "$root/state/state.db"; then move_to_root "$root/state/state.db"; fi
rmdir "$root/workspace"
rmdir "$root/state"
sync
