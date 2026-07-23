/**
 * Pure, reconciler-state-free helpers for the stateless Host lifecycle:
 * image pull-policy resolution (Stage 6, W5), runtime-token JWT metadata
 * inspection, and the Stage 1.2 workspace-layout initContainer.
 */
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { HostCondition } from './types'

/**
 * Condition surfacing a refused CONTEXT_MAPPER_STATELESS_IMAGE_PULL_POLICY
 * (Stage 6, W5). Mirrors the StatelessEnableRejected pattern: durable,
 * operator-visible, True only while the misconfiguration persists.
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
 * Idempotent workspace-layout migration run before mcp-host starts on
 * STATELESS Hosts only (Stage 1.2). The initContainer mounts the workspace
 * PVC at its root and reorganizes it into the dual-subPath layout:
 *   workspace/ → agent workspace (mounted at the workspace path)
 *   state/     → durable session state (mounted at /var/lib/clerum/state)
 * Legacy content at the PVC root moves into workspace/; legacy SQLite files
 * (state.db + WAL/SHM) move into state/. Every move is a same-filesystem
 * rename and `sync` flushes the directory updates.
 *
 * Round-trip resolution (Addendum 6 item 6): a stateful<->stateless round-trip
 * on the shared PVC can leave BOTH a root state.db (the freshest data, from the
 * stateful life the operator just left) AND an earlier stateless life's
 * state/state.db. Newest-source-wins: the older destination is preserved (never
 * deleted) as state/<db>.pre-<timestamp>.bak, the fresher root source then
 * migrates in via the normal path, and the resolution is logged loudly. This is
 * genuinely idempotent across round-trips — a post-migration run (no source) is
 * a no-op, and each later collision backs up under a NEW unique suffix.
 *
 * Genuinely ambiguous states still fail before the first move, preserving every
 * source for operator recovery: SQLite sources SPLIT across root and workspace,
 * a workspace SQLite source colliding with the durable destination, duplicate
 * non-SQLite entries, symlinks, and non-directory managed paths.
 * lost+found stays put: it is root-owned on ext4 volumes and never user data.
 * No chown/chmod — the container runs as the same uid/fsGroup (1001) that owns
 * the PVC content.
 */
export function buildWorkspaceLayoutInitScript(root = WORKSPACE_PVC_ROOT_MOUNT_PATH): string {
  return `set -eu
root=${shellSingleQuote(root)}
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
  while [ -e "$root/state/state.db.pre-$bak_suffix.bak" ] \
    || [ -e "$root/state/state.db-wal.pre-$bak_suffix.bak" ] \
    || [ -e "$root/state/state.db-shm.pre-$bak_suffix.bak" ]; do
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
 * Durable condition for the stateless pull-policy guard (Stage 6, W5): True
 * (MutableImageReference) while IfNotPresent is refused for a mutable image,
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
 * Stage 1.2 initContainer for STATELESS Hosts: mounts the workspace PVC at
 * its root and runs the idempotent layout migration (see
 * WORKSPACE_LAYOUT_INIT_SCRIPT). Runs as the same non-root identity as the
 * mcp-host container (uid/gid 1001, fsGroup 1001) so renames need no
 * chown/chmod.
 */
export function buildWorkspaceLayoutInitContainer(
  image: string,
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
): k8s.V1Container {
  return {
    name: 'workspace-layout-init',
    image,
    imagePullPolicy,
    command: ['/bin/sh', '-c', buildWorkspaceLayoutInitScript()],
    volumeMounts: [{ name: 'workspace', mountPath: WORKSPACE_PVC_ROOT_MOUNT_PATH }],
    resources: {
      requests: { memory: '32Mi', cpu: '10m' },
      limits: { memory: '64Mi', cpu: '200m' },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 1001,
      runAsGroup: 1001,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    },
  }
}
