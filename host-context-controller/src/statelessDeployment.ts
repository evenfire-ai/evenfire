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
/**
 * Idempotent workspace-layout migration run before mcp-host starts on
 * STATELESS Hosts only (Stage 1.2). The initContainer mounts the workspace
 * PVC at its root and reorganizes it into the dual-subPath layout:
 *   workspace/ → agent workspace (mounted at the workspace path)
 *   state/     → durable session state (mounted at /var/lib/clerum/state)
 * Legacy content at the PVC root moves into workspace/; legacy SQLite files
 * (state.db + WAL/SHM) move into state/. Every move is a same-filesystem
 * rename and `sync` flushes the directory updates, so a crash mid-migration
 * never loses data and a re-run is a no-op. lost+found stays put: it is
 * root-owned on ext4 volumes and never user data. No chown/chmod — the
 * container runs as the same uid/fsGroup (1001) that owns the PVC content.
 */
const WORKSPACE_LAYOUT_INIT_SCRIPT = `set -eu
root=${WORKSPACE_PVC_ROOT_MOUNT_PATH}
mkdir -p "$root/workspace" "$root/state"
for entry in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  base="$(basename "$entry")"
  case "$base" in
    workspace|state|lost+found) continue ;;
  esac
  mv "$entry" "$root/workspace/$base"
done
for db in state.db state.db-wal state.db-shm; do
  if [ -e "$root/workspace/$db" ]; then
    mv "$root/workspace/$db" "$root/state/$db"
  fi
done
sync
`

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
    command: ['/bin/sh', '-c', WORKSPACE_LAYOUT_INIT_SCRIPT],
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
