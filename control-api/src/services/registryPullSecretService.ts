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
 *                               NOT the registry's token-issuer (spec §7.9-2)
 *   label clerum.io/managed-by = control-api  (ownership marker; absent ⇒ externally owned)
 */
import type { K8sGateway } from '../k8s.js'
import type { SecretUpsertRequest } from '../types.js'
import { rootLogger } from '../observability/logger.js'
import { config } from '../config.js'
import { isRegistryAuthActive } from './registryConnectionDb.js'
import { resolvePublishScope, mintOrgPullCredential } from './registryClient.js'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  registryHostFromUrl,
} from '../routes/admin/registryImagePullSecret.js'

const logger = rootLogger.child({ module: 'registry-pull-secret' })

const MANAGED_BY_LABEL = 'clerum.io/managed-by'
const MANAGED_BY_VALUE = 'control-api'
const DOCKERCONFIG_KEY = '.dockerconfigjson'

export type EnsurePullSecretResult =
  | 'created'
  | 'repaired'
  | 'exists-ours'
  | 'exists-foreign'
  | 'skipped'

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
 * on its own token-issuer and cannot be trusted here (spec §7.9-2).
 */
function buildDockerconfigjson(host: string, key: string): string {
  const auth = Buffer.from(`_:${key}`).toString('base64')
  const cfg = { auths: { [host]: { username: '_', password: key, auth } } }
  return Buffer.from(JSON.stringify(cfg)).toString('base64')
}

interface SecretView {
  labels: Record<string, string>
  dockerconfig: string | undefined
}

function readSecret(raw: unknown): SecretView {
  const s = (raw ?? {}) as {
    metadata?: { labels?: Record<string, string> }
    data?: Record<string, string>
  }
  return {
    labels: s.metadata?.labels ?? {},
    dockerconfig: s.data?.[DOCKERCONFIG_KEY],
  }
}

function buildSecretReq(targetNs: string, dockerconfigjson: string): SecretUpsertRequest {
  return {
    name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
    namespace: targetNs,
    type: 'kubernetes.io/dockerconfigjson',
    labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
    data: { [DOCKERCONFIG_KEY]: dockerconfigjson },
  }
}

async function mintAndBuild(orgName: string, host: string): Promise<string> {
  const { key } = await mintOrgPullCredential(orgName)
  return buildDockerconfigjson(host, key)
}

// Serialize concurrent ensures for the same (namespace, secret) WITHIN this replica so
// two in-flight installs don't both mint. Cross-replica races are additionally bounded
// by the registry's rotate-on-call (≤1 active pull key/org) plus reactive rotation.
const inflight = new Map<string, Promise<EnsurePullSecretResult>>()

/**
 * Ensure the `evenfire-registry-pull` Secret exists in `targetNs`, minting a fresh
 * pull-only credential only when it is absent or broken. Idempotent and coexistence-safe:
 * a Secret we do not own (no managed-by=control-api label) is left untouched.
 *
 * No-ops (`'skipped'`) outside self-hosted mode, without active registry auth, without a
 * configured registry host, or before the connect flow has resolved our org.
 *
 * THROWS on mint/write failure so the caller can fail the install loudly rather than
 * attach an unresolvable imagePullSecrets reference.
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

async function ensureInner(
  gateway: K8sGateway,
  targetNs: string
): Promise<EnsurePullSecretResult> {
  // ── Gate: only self-hosted, connected, with a resolvable org ──────────────
  if (config.registryConnectionMode !== 'self-hosted') return 'skipped'
  const host = registryHostFromUrl(config.registryUrl)
  if (!host) return 'skipped'
  if (!(await isRegistryAuthActive())) return 'skipped'
  const { orgName } = await resolvePublishScope()
  if (!orgName) {
    logger.warn(
      { targetNs },
      'registry pull secret: org not resolved (connect flow incomplete); skipping'
    )
    return 'skipped'
  }

  // ── Read (getSecret re-throws 404; any other error aborts before minting) ──
  let current: SecretView | null = null
  try {
    current = readSecret(await gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, targetNs))
  } catch (err) {
    if (k8sStatus(err) !== 404) throw err // e.g. 403 = ns outside our RBAC → abort
    current = null // 404 → absent
  }

  if (current) {
    const ours = current.labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE
    const hasCred = !!current.dockerconfig
    if (hasCred && !ours) return 'exists-foreign' // external operator owns it — never touch
    if (hasCred && ours) return 'exists-ours' // reuse; rotation handled reactively
    // Present but missing/empty .dockerconfigjson → repair (mint + replace).
    await gateway.updateSecret(buildSecretReq(targetNs, await mintAndBuild(orgName, host)))
    logger.info({ targetNs, orgName }, 'registry pull secret repaired')
    return 'repaired'
  }

  // ── Absent → mint + create ────────────────────────────────────────────────
  try {
    await gateway.createSecret(buildSecretReq(targetNs, await mintAndBuild(orgName, host)))
  } catch (err) {
    if (k8sStatus(err) === 409) {
      // Lost a concurrent create race. We hold a freshly-minted (now-active) key, so
      // overwrite with it — rotate-on-call means the last minter's key is authoritative.
      await gateway.updateSecret(buildSecretReq(targetNs, await mintAndBuild(orgName, host)))
      logger.info({ targetNs, orgName }, 'registry pull secret reconciled after create race')
      return 'created'
    }
    throw err
  }
  logger.info({ targetNs, orgName }, 'registry pull secret created')
  return 'created'
}
