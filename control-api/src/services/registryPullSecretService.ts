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
  type: string | undefined
  dockerconfig: string | undefined
}

function readSecret(raw: unknown): SecretView {
  const s = (raw ?? {}) as {
    metadata?: { labels?: Record<string, string> }
    type?: string
    data?: Record<string, string>
  }
  return {
    labels: s.metadata?.labels ?? {},
    type: s.type,
    dockerconfig: s.data?.[DOCKERCONFIG_KEY],
  }
}

function buildSecretReq(targetNs: string, dockerconfigjson: string): SecretUpsertRequest {
  return {
    name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
    namespace: targetNs,
    type: DOCKERCONFIG_TYPE,
    labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
    data: { [DOCKERCONFIG_KEY]: dockerconfigjson },
  }
}

async function mintAndBuild(orgName: string, host: string): Promise<string> {
  const { key } = await mintOrgPullCredential(orgName)
  return buildDockerconfigjson(host, key)
}

// Collapse concurrent ensures for the same (namespace, secret) WITHIN this replica so two
// in-flight installs cannot both mint. Cross-replica races are bounded by the registry's
// rotate-on-call (<=1 active pull key per org) plus the read-before-mint discipline below:
// the loser of a create race re-reads and adopts the winner's Secret instead of minting.
const inflight = new Map<string, Promise<EnsurePullSecretResult>>()

/**
 * Ensure the `evenfire-registry-pull` Secret exists in `targetNs`, minting a fresh
 * pull-only credential only when it is absent or verifiably broken.
 *
 * Returns `'skipped'` ONLY when provisioning is legitimately not our job (managed mode,
 * where the operator owns the Secret) or when no registry host is configured. Every other
 * "cannot provision" condition THROWS `PullSecretProvisionError` so the caller fails the
 * install loudly instead of attaching an unresolvable imagePullSecrets reference.
 */
export function ensureRegistryPullSecret(
  gateway: K8sGateway,
  targetNs: string
): Promise<EnsurePullSecretResult> {
  const dedupeKey = `${targetNs}/${EVENFIRE_REGISTRY_PULL_SECRET_NAME}`
  const existing = inflight.get(dedupeKey)
  if (existing) return existing
  const run = ensureInner(gateway, targetNs).finally(() => inflight.delete(dedupeKey))
  inflight.set(dedupeKey, run)
  return run
}

async function ensureInner(gateway: K8sGateway, targetNs: string): Promise<EnsurePullSecretResult> {
  // ── Legitimate no-ops ─────────────────────────────────────────────────────
  // Managed clusters: the operator owns this Secret; never contend with it.
  if (config.registryConnectionMode !== 'self-hosted') return 'skipped'
  const host = registryHostFromUrl(config.registryUrl)
  if (!host) return 'skipped' // no registry configured; the attach predicate is false too

  // ── Hard preconditions: from here on we MUST provision or fail loudly ─────
  // The pull Secret is a registry credential. Confine writes to the namespace this
  // deployment actually serves so a caller-supplied `body.namespace` cannot plant it
  // in an unrelated namespace (and cannot rotate the org key as a side effect).
  if (targetNs !== config.mcpServersNamespace) {
    throw new PullSecretProvisionError(
      `refusing to provision the registry pull secret outside the configured plugin namespace (got "${targetNs}", expected "${config.mcpServersNamespace}")`,
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

  // ── Read (getSecret re-throws 404; any other error aborts before minting) ──
  const current = await readCurrent(gateway, targetNs)

  if (current) {
    const ours = current.labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE
    // INVARIANT 1: never write a Secret we do not own — even a broken one. Adopting it
    // would seize an external operator's credential; repairing it in place would rotate
    // the org key out from under them.
    if (!ours) {
      if (!dockerconfigMatchesHost(current.dockerconfig, host)) {
        logger.warn(
          { targetNs, host },
          'externally-owned evenfire-registry-pull Secret is missing or mis-keyed; leaving it untouched (remove it to let control-api provision one)'
        )
      }
      return 'exists-foreign'
    }
    // Ours and genuinely usable → reuse. Presence alone is not enough: a blob keyed on a
    // previous registry host can never be selected by the kubelet.
    if (current.type === DOCKERCONFIG_TYPE && dockerconfigMatchesHost(current.dockerconfig, host)) {
      return 'exists-ours'
    }
    // Ours but broken. `Secret.type` is immutable, so a wrong-typed Secret must be
    // recreated. Delete FIRST so a failed delete cannot strand a freshly-minted key.
    if (current.type !== DOCKERCONFIG_TYPE) {
      await gateway.deleteSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, targetNs)
      await gateway.createSecret(buildSecretReq(targetNs, await mintAndBuild(orgName, host)))
    } else {
      await gateway.updateSecret(buildSecretReq(targetNs, await mintAndBuild(orgName, host)))
    }
    logger.info({ targetNs, orgName }, 'registry pull secret repaired')
    auditPullSecret('registry_pull_secret_provisioned', {
      namespace: targetNs,
      org: orgName,
      outcome: 'repaired',
    })
    return 'repaired'
  }

  // ── Absent → mint + create ────────────────────────────────────────────────
  try {
    await gateway.createSecret(buildSecretReq(targetNs, await mintAndBuild(orgName, host)))
  } catch (err) {
    if (k8sStatus(err) !== 409) throw err
    // Lost a concurrent create race. Do NOT mint again — a second mint would revoke the
    // key the winner just stored. Re-read and adopt whatever is now there.
    const winner = await readCurrent(gateway, targetNs)
    if (!winner) throw err // vanished again; surface rather than loop
    const winnerOurs = winner.labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE
    if (!winnerOurs) return 'exists-foreign'
    logger.info({ targetNs, orgName }, 'registry pull secret already created concurrently')
    return 'exists-ours'
  }
  logger.info({ targetNs, orgName }, 'registry pull secret created')
  auditPullSecret('registry_pull_secret_provisioned', {
    namespace: targetNs,
    org: orgName,
    outcome: 'created',
  })
  return 'created'
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
