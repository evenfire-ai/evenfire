/**
 * Pure, reconciler-state-free helpers for the stateless Host lifecycle:
 * image pull-policy resolution (Stage 6, W5), runtime-token JWT metadata
 * inspection, and the workspace-layout merge initContainer every Host runs.
 */
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { HostCondition } from './types'

/**
 * Advisory condition for CONTEXT_MAPPER_STATELESS_IMAGE_PULL_POLICY (Stage 6,
 * W5): True while IfNotPresent is applied to a mutable image reference. The
 * policy is not overridden. Durable and operator-visible like
 * StatelessEnableRejected, True only while the configuration persists.
 */
export const STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE = 'StatelessPullPolicyRejected'
/** Immutable CI image tag shape (sha-<gitsha>), as pushed by deploy-dev. */
const IMMUTABLE_IMAGE_TAG_PATTERN = /^sha-[0-9a-f]{7,}$/
/** Where the workspace-layout initContainer mounts the workspace PVC ROOT. */
const WORKSPACE_PVC_ROOT_MOUNT_PATH = '/mnt/workspace-root'

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
/**
 * Init script run before mcp-host on every Host (issue #825). Every Host now
 * mounts the workspace PVC root at its workspace path and keeps the
 * conversation database at `<root>/state.db`. A PVC that a stateless Host
 * split with the earlier `workspace-layout-init` (agent files in
 * `workspace/`, the database in `state/`) is merged back to that layout.
 *
 * The merge runs only on the signature the earlier init leaves: `state/`
 * and `workspace/` are both real directories and `state/` holds a file the
 * init writes (`state.db`, `state.db-wal`, `state.db-shm` or a `.pre-*.bak`
 * copy of one of those three). Any other tree exits 0 untouched: stateful,
 * desktop, empty, a user folder named `state/` or `workspace/`, a `state/`
 * holding other `state.db*` names, and a `state` or `workspace` that is a
 * symlink or not a directory (an agent can create those on a stateful Host,
 * so they must not stop it).
 *
 * A tree with a root `state.db` main file, a database under `state/` and
 * none under `workspace/` belongs to a Host that went back to stateful after
 * its last stateless run (T5). The root database is the current one; the
 * whole `state/` directory is renamed to `state.db.superseded-<UTC ts>` in
 * one step, `workspace/` stays where it is, and the script exits 0. The
 * renamed directory starts with `state.db`, so the workspace file guards
 * deny it to agent tools.
 *
 * Every refusal prints one line and exits 1 before the first move:
 *   F1 `state/` or `workspace/` cannot be listed and searched, or a database
 *      entry is a symlink or not a regular file;
 *   F2 more than one live database (a `state.db` main file or its journals)
 *      across the root, `state/` and `workspace/`, except the root journals
 *      a stopped merge leaves next to the remaining `state/state.db`;
 *   F3 a name to move already exists at the root, or exists under both
 *      `state/` and `workspace/` (an empty source directory is removed
 *      instead), a directory that decides such a collision cannot be listed,
 *      or `workspace/lost+found` would keep `workspace/` alive;
 *   F4 the root, `state/`, `workspace/`, or a directory to be moved out of
 *      them is not writable (renaming a directory rewrites its `..`).
 * Moves: `workspace/*`, then `state/*` except `state.db`, then
 * `state/state.db` last, so a stopped merge keeps the signature and the
 * next start finishes it. Symlinks are renamed, never followed. The script
 * never opens the database and deletes nothing but the emptied directories.
 */
export function buildWorkspaceLayoutMergeScript(root = WORKSPACE_PVC_ROOT_MOUNT_PATH): string {
  return `set -eu
root=${shellSingleQuote(root)}
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
for entry in "$root/state"/state.db "$root/state"/state.db-wal "$root/state"/state.db-shm \\
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
  for entry in "$dir"/state.db "$dir"/state.db-wal "$dir"/state.db-shm \\
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
  base="\${entry##*/}"
  if present "$root/$base"; then
    if is_empty_dir "$entry" && [ -d "$root/$base" ] && [ ! -L "$root/$base" ]; then continue; fi
    fail_merge "destination exists: $root/$base"
  fi
done
for entry in "$root/state"/* "$root/state"/.[!.]* "$root/state"/..?*; do
  present "$entry" || continue
  base="\${entry##*/}"
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
for entry in "$root/workspace"/* "$root/workspace"/.[!.]* "$root/workspace"/..?* \\
  "$root/state"/* "$root/state"/.[!.]* "$root/state"/..?*; do
  [ -d "$entry" ] && [ ! -L "$entry" ] || continue
  ! present "$root/\${entry##*/}" || continue
  [ -w "$entry" ] || fail_merge "not writable by uid $(id -u): $entry"
done

move_to_root() {
  entry="$1"
  base="\${entry##*/}"
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
  [ "\${entry##*/}" != state.db ] || continue
  move_to_root "$entry"
done
if present "$root/state/state.db"; then move_to_root "$root/state/state.db"; fi
rmdir "$root/workspace"
rmdir "$root/state"
sync
`
}

/**
 * True when an image reference cannot change contents under the same name:
 * digest-pinned (…@sha256:<hex>) or tagged with the immutable CI tag shape
 * (sha-<gitsha>). Everything else (semver tags, latest, tagless) is mutable —
 * the same reference can point at different bytes over time.
 */
function isImmutableImageRef(image: string): boolean {
  if (image.includes('@sha256:')) {
    return true
  }
  const lastColon = image.lastIndexOf(':')
  if (lastColon === -1 || image.lastIndexOf('/') > lastColon) {
    // No tag (implicit :latest), or the only colon belongs to a registry
    // port (registry:5000/img) — both are tagless, hence mutable.
    return false
  }
  return IMMUTABLE_IMAGE_TAG_PATTERN.test(image.slice(lastColon + 1))
}

export interface StatelessPullPolicyResolution {
  policy: 'Always' | 'IfNotPresent' | 'Never'
  /** Set (to the image ref) when IfNotPresent is used with a MUTABLE image —
   *  an advisory stale-cached-image-on-wake risk, NOT a rejection. */
  mutableImageRisk?: string
}

/**
 * Resolve the pull policy applied to STATELESS host pods (Stage 6, W5).
 * CONTEXT_MAPPER_STATELESS_IMAGE_PULL_POLICY empty = inherit the global
 * hostImagePullPolicy. Image-skew ADVISORY: IfNotPresent on a MUTABLE image
 * reference lets a node serve whatever bytes it has cached, so a wake may run
 * stale code. We do NOT override the operator's policy to Always: for a
 * node-local image (the platform's own :test convention on minikube, and any
 * preloaded image) Always is unpullable and bricks the pod — strictly worse
 * than the stale-cache risk. Instead the risk is surfaced as an operator-
 * visible condition + a once-per-(host,image) warning; the operator pins an
 * immutable ref (@sha256: / sha-<gitsha>) to eliminate it.
 */
export function resolveStatelessImagePullPolicy(image: string): StatelessPullPolicyResolution {
  // Empty override = inherit the global policy (the documented default).
  const configured = config.statelessImagePullPolicy || config.hostImagePullPolicy
  const mutableImageRisk =
    configured === 'IfNotPresent' && !isImmutableImageRef(image) ? image : undefined
  return { policy: configured, mutableImageRisk }
}

/**
 * Durable advisory condition for the stateless pull policy (Stage 6, W5): True
 * (MutableImageReference) while IfNotPresent is applied to a mutable image,
 * False (StatelessPullPolicyAccepted) otherwise. The message states the
 * enforced outcome so the operator sees what the pod actually runs with.
 */
export function statelessPullPolicyCondition(
  image: string
): Omit<HostCondition, 'lastTransitionTime'> {
  const resolution = resolveStatelessImagePullPolicy(image)
  if (resolution.mutableImageRisk !== undefined) {
    return {
      type: STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE,
      status: 'True',
      reason: 'MutableImageReference',
      message: `stateless imagePullPolicy is ${resolution.policy} and "${resolution.mutableImageRisk}" is not immutable (no @sha256: digest, tag not sha-<gitsha>): a node with a stale cached image serves old code on wake. Pin a digest or sha-<gitsha> tag to eliminate the risk (the pod still runs — Always is not enforced because a node-local image would be unpullable).`,
    }
  }
  return {
    type: STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE,
    status: 'False',
    reason: 'StatelessPullPolicyAccepted',
    message: `stateless imagePullPolicy resolves to ${resolution.policy}`,
  }
}

/** Pull-policy condition for Hosts whose stateless lifecycle is off/rejected. */
export function pullPolicyNotApplicableCondition(): Omit<HostCondition, 'lastTransitionTime'> {
  return {
    type: STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE,
    status: 'False',
    reason: 'NotApplicable',
    message: 'stateless lifecycle is not in effect',
  }
}

/**
 * Decode the `exp` claim from a JWT payload WITHOUT verifying the signature.
 * HCC must never VERIFY third-party tokens (verification is control-api's
 * job); parsing `exp` to schedule Secret rotation is metadata inspection,
 * not verification. Returns the expiry in epoch milliseconds, or null when
 * the value is not a parsable JWT with a numeric `exp`.
 */
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null
  } catch {
    // Not parsable -> caller re-issues (fail toward a fresh token, loudly).
    return null
  }
}

/**
 * Margin (ms) before the refresh token's real `exp` at which HCC rotates
 * the bootstrap Secret (CONTEXT_MAPPER_RUNTIME_TOKEN_ROTATE_BEFORE_S,
 * default 24h). Clamped to half the token's observed lifetime so
 * short-lived tokens (tests, dev issuers) cannot oscillate into an
 * issue-on-every-reconcile loop.
 */
export function effectiveRotateBeforeMs(expMs: number, issuedAtMs: number | null): number {
  const configuredMs = Math.max(0, config.runtimeTokenRotateBeforeSec ?? 0) * 1000
  if (issuedAtMs === null || !Number.isFinite(issuedAtMs) || issuedAtMs >= expMs) {
    return configuredMs
  }
  return Math.min(configuredMs, Math.floor((expMs - issuedAtMs) / 2))
}

/**
 * InitContainer that runs buildWorkspaceLayoutMergeScript() on the workspace
 * PVC root, on every Host and at every start. It uses the Host image and the
 * mcp-host container's securityContext, so it owns the files it renames
 * exactly as the main container does.
 */
export function buildWorkspaceLayoutMergeContainer(
  image: string,
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never',
  securityContext: k8s.V1SecurityContext
): k8s.V1Container {
  return {
    name: 'workspace-layout-merge',
    image,
    imagePullPolicy,
    command: ['/bin/sh', '-c', buildWorkspaceLayoutMergeScript()],
    volumeMounts: [{ name: 'workspace', mountPath: WORKSPACE_PVC_ROOT_MOUNT_PATH }],
    resources: {
      requests: { memory: '32Mi', cpu: '10m' },
      limits: { memory: '64Mi', cpu: '200m' },
    },
    securityContext,
  }
}
