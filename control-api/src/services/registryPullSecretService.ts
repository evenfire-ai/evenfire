/**
 * Self-provisioning of the `evenfire-registry-pull` image-pull Secret.
 *
 * On a self-hosted cluster there is no managed operator to drop the dockerconfigjson
 * Secret that local-mode plugins on the private registry need, so control-api
 * provisions it itself. Design: docs/architecture/registry-pull-secret-self-provisioning.md.
 *
 * Contract (must match what the managed operator writes, so either satisfies the same
 * McpServer.spec.imagePullSecrets reference):
 *   name  = 'evenfire-registry-pull'         (EVENFIRE_REGISTRY_PULL_SECRET_NAME)
 *   ns    = the McpServer's own namespace    (imagePullSecrets are namespace-local)
 *   type  = kubernetes.io/dockerconfigjson
 *   data['.dockerconfigjson'] = base64 payload, keyed on OUR image host (registryUrl),
 *                               NOT the registry's token-issuer
 *   label clerum.io/managed-by = control-api  (ownership marker; absent ⇒ externally owned)
 *
 * Two invariants make this safe to run repeatedly:
 *   1. NEVER write a Secret we do not own. An unlabeled Secret belongs to an external
 *      operator; we return `exists-foreign` and leave it alone even if it looks broken.
 *   2. Mint ONLY when we are already committed to a write we know can succeed. The
 *      registry's pull-credential mint is rotate-on-call — it revokes the org's previous
 *      key — so a mint that is followed by a failed write strands every other namespace's
 *      Secret on a revoked credential.
 */
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import type { K8sGateway } from '../k8s.js'
import { rootLogger } from '../observability/logger.js'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  registryHostFromUrl,
} from '../routes/admin/registryImagePullSecret.js'
import type { SecretUpsertRequest } from '../types.js'
import { mintOrgPullCredential, resolvePublishScope } from './registryClient.js'
import { isRegistryAuthActive } from './registryConnectionDb.js'

const logger = rootLogger.child({ module: 'registry-pull-secret' })

/**
 * Audit trail for minting + writing a registry credential, matching the `[AUDIT]` shape
 * the admin registry routes emit. NEVER include the key or the dockerconfigjson payload.
 */
function auditPullSecret(action: string, details: Record<string, unknown>): void {
  console.log(
    `[AUDIT] ${JSON.stringify({ timestamp: new Date().toISOString(), action, ...details })}`
  )
}

const MANAGED_BY_LABEL = 'clerum.io/managed-by'
const MANAGED_BY_VALUE = 'control-api'
const DOCKERCONFIG_KEY = '.dockerconfigjson'
const DOCKERCONFIG_TYPE = 'kubernetes.io/dockerconfigjson'
const FINGERPRINT_ANNOTATION = 'clerum.io/pull-key-fingerprint'

export type EnsurePullSecretResult =
  | 'created'
  | 'repaired'
  | 'exists-ours'
  | 'exists-foreign'
  | 'skipped'

/**
 * Raised when the pull Secret cannot be provisioned but the caller is about to attach a
 * reference to it. The caller MUST fail the install rather than persist an McpServer
 * whose imagePullSecrets can never resolve — that is the silent ImagePullBackOff this
 * whole mechanism exists to remove.
 */
export class PullSecretProvisionError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly status: number = 500
  ) {
    super(message)
    this.name = 'PullSecretProvisionError'
  }
}

/** Extract an HTTP-ish status from a K8s client error (mirrors extractK8sError). */
function k8sStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const e = err as { code?: number; statusCode?: number; httpStatus?: number }
    const s = e.code ?? e.statusCode ?? e.httpStatus
    if (typeof s === 'number') return s
  }
  return null
}

/**
 * Build a kubernetes.io/dockerconfigjson payload (base64) for `key` against `host`.
 * Keyed on OUR configured registry host (= the image host, per the attach invariant)
 * so the kubelet selects this credential — the registry's server-built blob is keyed
 * on its own token-issuer and cannot be trusted here.
 */
function buildDockerconfigjson(host: string, key: string): string {
  const auth = Buffer.from(`_:${key}`).toString('base64')
  const cfg = { auths: { [host]: { username: '_', password: key, auth } } }
  return Buffer.from(JSON.stringify(cfg)).toString('base64')
}

/**
 * True when the stored blob actually carries an entry for `host`. Presence alone is not
 * enough: a Secret minted before CLERUM_REGISTRY_URL changed is keyed on the old host and
 * the kubelet will never select it. Unparseable ⇒ false (treat as broken, repair it).
 */
function dockerconfigMatchesHost(blob: string | undefined, host: string): boolean {
  if (!blob) return false
  try {
    const parsed = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
      auths?: Record<string, unknown>
    }
    return !!parsed?.auths && Object.prototype.hasOwnProperty.call(parsed.auths, host)
  } catch {
    return false
  }
}

interface SecretView {
  labels: Record<string, string>
  annotations: Record<string, string>
  type: string | undefined
  dockerconfig: string | undefined
}

function readSecret(raw: unknown): SecretView {
  const s = (raw ?? {}) as {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
    type?: string
    data?: Record<string, string>
  }
  return {
    labels: s.metadata?.labels ?? {},
    annotations: s.metadata?.annotations ?? {},
    type: s.type,
    dockerconfig: s.data?.[DOCKERCONFIG_KEY],
  }
}

function buildSecretReq(targetNs: string, cred: MintedCredential): SecretUpsertRequest {
  return {
    name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
    namespace: targetNs,
    type: DOCKERCONFIG_TYPE,
    labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
    annotations: { [FINGERPRINT_ANNOTATION]: cred.fingerprint },
    data: { [DOCKERCONFIG_KEY]: cred.dockerconfigjson },
  }
}

interface MintedCredential {
  dockerconfigjson: string
  /** Short digest of the key, so copies in different namespaces can be compared. */
  fingerprint: string
}

/**
 * Mint ONE credential. Call this at most once per ensure pass: the registry's mint is
 * rotate-on-call, so a second mint revokes the first and would strand any namespace
 * already written with it.
 */
async function mintCredential(orgName: string, host: string): Promise<MintedCredential> {
  const { key } = await mintOrgPullCredential(orgName)
  return {
    dockerconfigjson: buildDockerconfigjson(host, key),
    fingerprint: createHash('sha256').update(key).digest('hex').slice(0, 12),
  }
}

// Collapse concurrent ensure passes WITHIN this replica so two in-flight installs cannot
// both mint. Keyed on the whole target set, since a pass is atomic over its namespaces.
const inflight = new Map<string, Promise<Map<string, EnsurePullSecretResult>>>()

/** The platform workload namespaces a pull credential may legitimately be written into. */
export function platformWorkloadNamespaces(): string[] {
  return [
    ...new Set([config.mcpServersNamespace, config.sandboxNamespace, config.sandboxUiNamespace]),
  ]
}

/**
 * Ensure the `evenfire-registry-pull` Secret exists, and is current, in EVERY given
 * namespace — minting at most ONE credential for the whole pass.
 *
 * The credential is per-ORG but the Secret is per-NAMESPACE, and the registry's mint is
 * rotate-on-call (it revokes the org's previous key). Minting per namespace would
 * therefore have each mint invalidate the namespaces already written. So: read all, mint
 * once if any target needs it, then write that single credential to every target we own.
 *
 * Post-condition: every non-foreign target holds the same, current credential.
 *
 * Returns `'skipped'` for all targets ONLY when provisioning is legitimately not our job
 * (managed mode, or no registry configured). Every other "cannot provision" condition
 * THROWS `PullSecretProvisionError`, so a caller about to attach an imagePullSecrets
 * reference fails the install loudly instead of persisting an unresolvable one.
 */
export function ensureRegistryPullSecrets(
  gateway: K8sGateway,
  namespaces: string[]
): Promise<Map<string, EnsurePullSecretResult>> {
  const targets = [...new Set(namespaces)].sort()
  const dedupeKey = targets.join(',')
  const existing = inflight.get(dedupeKey)
  if (existing) return existing
  const run = ensureInner(gateway, targets).finally(() => inflight.delete(dedupeKey))
  inflight.set(dedupeKey, run)
  return run
}

/**
 * Single-namespace convenience wrapper, for the McpServer install/upgrade paths that
 * provision exactly the namespace their workload lands in.
 */
export async function ensureRegistryPullSecret(
  gateway: K8sGateway,
  targetNs: string
): Promise<EnsurePullSecretResult> {
  const results = await ensureRegistryPullSecrets(gateway, [targetNs])
  return results.get(targetNs) ?? 'skipped'
}

/** Classification of one namespace's current Secret, decided before anything is minted. */
type TargetState =
  | { kind: 'foreign' }
  | { kind: 'valid'; fingerprint: string }
  | { kind: 'absent' }
  | { kind: 'broken'; wrongType: boolean }

function classify(current: SecretView | null, host: string): TargetState {
  if (!current) return { kind: 'absent' }
  // INVARIANT 1: never write a Secret we do not own — even a broken one. Adopting it would
  // seize an external operator's credential; repairing it in place would rotate the org
  // key out from under them.
  if (current.labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) return { kind: 'foreign' }
  const wrongType = current.type !== DOCKERCONFIG_TYPE
  // Presence alone is not enough: a blob keyed on a previous registry host can never be
  // selected by the kubelet, and a copy with no fingerprint cannot be compared across
  // namespaces.
  const fingerprint = current.annotations[FINGERPRINT_ANNOTATION]
  if (wrongType || !dockerconfigMatchesHost(current.dockerconfig, host) || !fingerprint) {
    return { kind: 'broken', wrongType }
  }
  return { kind: 'valid', fingerprint }
}

async function ensureInner(
  gateway: K8sGateway,
  targets: string[]
): Promise<Map<string, EnsurePullSecretResult>> {
  const out = new Map<string, EnsurePullSecretResult>()

  // ── Legitimate no-ops ─────────────────────────────────────────────────────
  // Managed clusters: the operator owns this Secret; never contend with it.
  const host = registryHostFromUrl(config.registryUrl)
  if (config.registryConnectionMode !== 'self-hosted' || !host) {
    for (const ns of targets) out.set(ns, 'skipped')
    return out
  }

  // ── Hard preconditions: from here on we MUST provision or fail loudly ─────
  // The pull Secret is a registry credential. Confine writes to the platform workload
  // namespaces so a caller-supplied `body.namespace` can never plant it elsewhere (and
  // can never rotate the org key as a side effect).
  const allowed = new Set(platformWorkloadNamespaces())
  const rogue = targets.filter(ns => !allowed.has(ns))
  if (rogue.length > 0) {
    throw new PullSecretProvisionError(
      `refusing to provision the registry pull secret outside the platform workload namespaces (got ${rogue.map(n => `"${n}"`).join(', ')}, allowed ${[...allowed].map(n => `"${n}"`).join(', ')})`,
      'unsupported_namespace',
      400
    )
  }
  if (!(await isRegistryAuthActive())) {
    throw new PullSecretProvisionError(
      'registry connection is not active; complete the registry connect flow before installing a private plugin',
      'registry_not_connected',
      409
    )
  }
  // A cold-started control-api can cache a null org from before the registry bound this
  // client. Force one refresh before failing, mirroring the self-service key routes.
  let { orgName } = await resolvePublishScope()
  if (!orgName) ({ orgName } = await resolvePublishScope({ force: true }))
  if (!orgName) {
    throw new PullSecretProvisionError(
      'registry has not bound this deployment to an organization yet; cannot mint an image-pull credential',
      'org_unresolved',
      409
    )
  }

  // ── Read + classify every target BEFORE minting anything ──────────────────
  const states = new Map<string, TargetState>()
  for (const ns of targets) {
    states.set(ns, classify(await readCurrent(gateway, ns), host))
  }

  const ours = targets.filter(ns => states.get(ns)!.kind !== 'foreign')
  for (const ns of targets) {
    if (states.get(ns)!.kind === 'foreign') {
      logger.warn(
        { namespace: ns },
        'externally-owned evenfire-registry-pull Secret present; leaving it untouched (remove it to let control-api manage this namespace)'
      )
      out.set(ns, 'exists-foreign')
    }
  }
  if (ours.length === 0) return out

  // A mint is needed when any namespace we own lacks a usable credential, OR when the
  // copies have diverged — divergence means an earlier pass wrote some namespaces and
  // failed on others, and we cannot recover the live key from a fingerprint.
  const valid = ours.filter(ns => states.get(ns)!.kind === 'valid')
  const fingerprints = new Set(
    valid.map(ns => (states.get(ns) as { fingerprint: string }).fingerprint)
  )
  const diverged = fingerprints.size > 1
  const needsMint = valid.length !== ours.length || diverged

  if (!needsMint) {
    for (const ns of ours) out.set(ns, 'exists-ours')
    return out
  }
  if (diverged) {
    logger.warn(
      { namespaces: ours },
      'registry pull secret copies diverged across namespaces; re-minting to converge'
    )
  }

  // `Secret.type` is immutable, so a wrong-typed Secret must be deleted and recreated.
  // Do every delete BEFORE minting: a delete that fails must not leave us holding a
  // freshly-minted key that has already revoked the credential the cluster was using.
  const recreate = new Set<string>()
  for (const ns of ours) {
    const state = states.get(ns)!
    if (state.kind === 'broken' && state.wrongType) {
      await gateway.deleteSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)
      recreate.add(ns)
    }
  }

  // ── Mint ONCE, then fan the same credential out to every namespace we own ──
  // Namespaces that were already valid are rewritten too: the mint just revoked the key
  // they were holding.
  const cred = await mintCredential(orgName, host)
  for (const ns of ours) {
    const state = states.get(ns)!
    const outcome = await writeCredential(gateway, ns, state, cred, recreate.has(ns))
    out.set(ns, outcome)
  }

  auditPullSecret('registry_pull_secret_provisioned', {
    namespaces: ours,
    org: orgName,
    fingerprint: cred.fingerprint,
  })
  logger.info({ namespaces: ours, orgName }, 'registry pull secret provisioned')
  return out
}

/** Write `cred` into one namespace, choosing create/update/recreate from its prior state. */
async function writeCredential(
  gateway: K8sGateway,
  ns: string,
  state: TargetState,
  cred: MintedCredential,
  alreadyDeleted: boolean
): Promise<EnsurePullSecretResult> {
  // Wrong-typed Secrets were deleted before the mint (see ensureInner), so they are now
  // absent and must be created, not updated.
  if (alreadyDeleted) {
    await gateway.createSecret(buildSecretReq(ns, cred))
    return 'repaired'
  }
  if (state.kind === 'absent') {
    try {
      await gateway.createSecret(buildSecretReq(ns, cred))
      return 'created'
    } catch (err) {
      if (k8sStatus(err) !== 409) throw err
      // Lost a create race. The winner's Secret is authoritative for its own content, but
      // OUR mint has already revoked whatever key it holds — so overwrite it with ours
      // rather than adopting a now-dead credential. Skip if the winner is foreign.
      const winner = await readCurrent(gateway, ns)
      if (winner && winner.labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) return 'exists-foreign'
      await gateway.updateSecret(buildSecretReq(ns, cred))
      return 'created'
    }
  }
  await gateway.updateSecret(buildSecretReq(ns, cred))
  return state.kind === 'valid' ? 'exists-ours' : 'repaired'
}

/** Read the Secret, mapping 404 to null. Any other error propagates (e.g. 403 = wrong ns). */
async function readCurrent(gateway: K8sGateway, targetNs: string): Promise<SecretView | null> {
  try {
    return readSecret(await gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, targetNs))
  } catch (err) {
    if (k8sStatus(err) === 404) return null
    throw err
  }
}
