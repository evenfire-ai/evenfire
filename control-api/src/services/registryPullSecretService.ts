/**
 * Self-provisioning of the `evenfire-registry-pull` image-pull Secret.
 *
 * On a self-hosted cluster there is no managed operator to drop the dockerconfigjson
 * Secret that local-mode plugins on the private registry need, so control-api
 * provisions it itself. Design: docs/architecture/registry-pull-secret-self-provisioning.md.
 *
 * Contract (must match what the managed operator writes, so either satisfies the same
 * imagePullSecrets reference):
 *   name  = 'evenfire-registry-pull'         (EVENFIRE_REGISTRY_PULL_SECRET_NAME)
 *   ns    = EVERY platform workload namespace (see below; imagePullSecrets are ns-local)
 *   type  = kubernetes.io/dockerconfigjson
 *   data['.dockerconfigjson'] = base64 payload, keyed on OUR image host (registryUrl),
 *                               NOT the registry's token-issuer
 *   label clerum.io/managed-by = control-api  (ownership marker; absent ⇒ externally owned)
 *
 * Namespaces — the reference is NOT confined to an McpServer's own namespace. WRC injects
 * `imagePullSecrets: [evenfire-registry-pull]` into every workload whose image host equals
 * the configured registry host, wherever CLERUM_REGISTRY_URL is set, and recipe workloads
 * split across all three platform workload namespaces by kind (transport → mcp-server,
 * spec.ui.workloadRef → sandbox-ui, everything else → sandbox-recipes). So the Secret must
 * exist in ALL of them — `platformWorkloadNamespaces()`, the one allowlist writes are
 * confined to. On a MANAGED cluster control-api writes none of them (provisioning
 * short-circuits to 'skipped'), which makes populating all three the external operator's
 * job: a managed cluster that provisions only mcp-server leaves recipe pods in
 * ImagePullBackOff with nothing in the API trail to explain it.
 *
 * Two invariants make this safe to run repeatedly:
 *   1. NEVER write a Secret we do not own. An unlabeled Secret belongs to an external
 *      operator; we return `exists-foreign` and leave it alone. Not owning it does not
 *      mean waving the caller through, though: if it cannot serve an image pull at all we
 *      fail the install (`foreign_secret_unusable`) rather than let a CRD reference it.
 *   2. Mint ONLY when we are already committed to a write we know can succeed. The
 *      registry's pull-credential mint is rotate-on-call — it revokes the org's previous
 *      key — so a mint that is followed by a failed write strands every other namespace's
 *      Secret on a revoked credential.
 *
 * Those two combine into an ALL-OR-NOTHING rule on external pre-provisioning, because the
 * credential is per-ORG while the Secret is per-NAMESPACE. Minting for a namespace we own
 * also revokes the key sealed inside a foreign Secret we deliberately refused to touch —
 * silently: the foreign bytes never change, foreign copies are excluded from the
 * fingerprint set so the divergence check can never see it, and invariant 1 forbids
 * repairing it. So if ANY target in a pass holds a USABLE foreign Secret, the org's pull
 * credential is externally managed and this service mints NOTHING, in any namespace. An
 * operator therefore provisions ALL of `platformWorkloadNamespaces()` or none of them; a
 * half-external cluster fails the installs that need a namespace we cannot fill
 * (`foreign_secret_would_be_revoked`) instead of quietly breaking the ones that work.
 *
 * "Usable" is the gate, not "foreign": an unusable foreign Secret (wrong type, or keyed on
 * another host) is not serving any pull for this registry, so rotating the org key cannot
 * break a working path through it and it does not block the mint. It is still fatal to a
 * caller that references its namespace — via `foreign_secret_unusable`, per invariant 1.
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
// both mint. Keyed on the whole target set, since a pass is atomic over its namespaces —
// which means every caller must pass the SAME set or the dedupe silently does nothing.
// That is why the single-namespace wrapper below delegates to the full platform set: two
// mints against a rotate-on-call registry leave the loser's namespaces on a revoked key,
// and (because the loser rewrites the winner's namespaces too) with FINGERPRINTS THAT
// AGREE — so the divergence check in ensureInner cannot see it and no later pass re-mints.
//
// Correct only at ONE replica (deploy/base/control-plane/control-api.yaml pins
// `replicas: 1`). An in-process Map cannot see another replica's pass, so scaling out
// would require an org-scoped distributed lock around the mint — control-api has Postgres
// available for that. Not implemented: single-replica is the deployed shape today.
//
// The cached value carries the per-namespace FAILURE REASONS alongside the results rather
// than throwing for them inside the pass. Whether an unusable foreign Secret — or a
// namespace we could not fill without revoking a foreign key — is fatal depends on which
// namespaces the CALLER needs, and the dedupe key deliberately does not encode that:
// folding the required set into the key would stop an MCP install and a recipe install from
// collapsing, which is the very race this map exists to prevent. So the pass records, and
// each caller applies its own policy on the shared result.
const inflight = new Map<string, Promise<EnsurePass>>()

/**
 * One pass's outcome: per-namespace results, plus the two per-namespace reasons a caller
 * may have to fail on.
 *
 * `unusable` — a FOREIGN Secret the kubelet cannot use (`foreign_secret_unusable`).
 * `blocked`  — a namespace we OWN that needed a mint we refused to perform, because some
 *              other target in the pass holds a USABLE foreign Secret and the mint would
 *              revoke its key (`foreign_secret_would_be_revoked`). Full caller-facing
 *              sentences, not fragments: the remedy names the foreign namespace, which only
 *              the pass knows. A blocked namespace has NO entry in `results` — nothing
 *              happened to it, and every caller that could observe the gap fails on it
 *              first.
 */
type EnsurePass = {
  results: Map<string, EnsurePullSecretResult>
  unusable: Map<string, string>
  blocked: Map<string, string>
}

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
 * Post-condition: every non-foreign target holds the same, current credential — UNLESS some
 * target holds a USABLE foreign Secret, in which case the pass mints and writes nothing at
 * all (see the all-or-nothing rule in the file header) and every owned target that needed a
 * mint is recorded as blocked instead.
 *
 * Returns `'skipped'` for all targets ONLY when provisioning is legitimately not our job
 * (managed mode, or no registry configured). Every other "cannot provision" condition
 * THROWS `PullSecretProvisionError`, so a caller about to attach an imagePullSecrets
 * reference fails the install loudly instead of persisting an unresolvable one.
 */
export async function ensureRegistryPullSecrets(
  gateway: K8sGateway,
  namespaces: string[],
  opts: { required?: string[] } = {}
): Promise<Map<string, EnsurePullSecretResult>> {
  const targets = [...new Set(namespaces)].sort()
  const dedupeKey = targets.join(',')
  let run = inflight.get(dedupeKey)
  if (!run) {
    run = ensureInner(gateway, targets).finally(() => inflight.delete(dedupeKey))
    inflight.set(dedupeKey, run)
  }
  const { results, unusable, blocked } = await run

  // A recorded failure is fatal only to a caller that needs THAT namespace. A pass covers
  // the whole platform set (for the mint-once collapse), so an MCP install must not be
  // failed by a squatter in a sandbox namespace it never references — while a recipe
  // install, which does land there, still fails loudly. `required` defaults to every target,
  // so a caller that asks for a set is asserting it needs all of it.
  const required = opts.required ?? targets

  // `unusable` first, across the WHOLE required set, before any `blocked`. Both can apply
  // at once (a malformed foreign copy in one namespace, a well-shaped one blocking the mint
  // in another), and `unusable` names a concrete defect in a specific Secret that has to be
  // fixed or removed either way — deleting the copy that blocked the mint would just
  // surface it on the next install. Leading with the defect is the shorter path out.
  for (const ns of required) {
    const why = unusable.get(ns)
    if (why) {
      throw new PullSecretProvisionError(
        `the ${EVENFIRE_REGISTRY_PULL_SECRET_NAME} Secret in namespace "${ns}" is externally owned and cannot serve an image pull: ${why}. Fix it in place, or delete it to let control-api manage that namespace. (A well-shaped foreign Secret is accepted even if its key has since been revoked — checking that would take a registry round-trip.)`,
        'foreign_secret_unusable',
        409
      )
    }
  }
  for (const ns of required) {
    const why = blocked.get(ns)
    if (why) throw new PullSecretProvisionError(why, 'foreign_secret_would_be_revoked', 409)
  }
  return results
}

/**
 * Single-namespace convenience wrapper, for the McpServer install/upgrade paths that
 * provision exactly the namespace their workload lands in.
 *
 * It still runs the FULL platform-namespace pass and then picks its own namespace out of
 * the result, because the inflight dedupe is keyed on the target set: a pass over just
 * `[targetNs]` would never collapse with a concurrent recipe install over all three, and
 * both would mint (see the note on `inflight`). `targetNs` stays in the list so an
 * unsupported namespace is still rejected by ensureInner's allowlist — same reason code,
 * same status, same point in the sequence.
 *
 * Costs two extra Secret reads per MCP install. Buys the mint-once guarantee across route
 * paths, and makes every install a full-set pass, so a diverged cluster converges on
 * whichever install runs next.
 */
export async function ensureRegistryPullSecret(
  gateway: K8sGateway,
  targetNs: string
): Promise<EnsurePullSecretResult> {
  const results = await ensureRegistryPullSecrets(
    gateway,
    [targetNs, ...platformWorkloadNamespaces()],
    // Only this caller's own namespace is load-bearing: the siblings are swept along for
    // the mint-once collapse, so an unusable foreign squatter in one of them must not fail
    // an install that never references it. A USABLE foreign copy in a sibling is different
    // — it forbids the mint outright (see the all-or-nothing rule in the file header), so
    // if `targetNs` needed one it comes back `foreign_secret_would_be_revoked`.
    { required: [targetNs] }
  )
  return results.get(targetNs) ?? 'skipped'
}

/** Classification of one namespace's current Secret, decided before anything is minted. */
type TargetState =
  | { kind: 'foreign'; unusable: string | null }
  | { kind: 'valid'; fingerprint: string }
  | { kind: 'absent' }
  | { kind: 'broken'; wrongType: boolean }

/**
 * Why a Secret we do NOT own cannot serve an image pull, or null when it can.
 *
 * Read-only by construction — the same two checks `classify` applies to our own copies,
 * with no fingerprint requirement (that annotation is ours; an external operator has no
 * reason to write it) and no write of any kind.
 *
 * Deliberately shape-only: a well-formed blob whose key the registry has since revoked
 * still passes here. Proving liveness would take a registry round-trip on every install,
 * which this check does not do.
 */
function foreignUsabilityProblem(current: SecretView, host: string): string | null {
  if (current.type !== DOCKERCONFIG_TYPE) {
    return `its type is "${current.type ?? 'unset'}", not ${DOCKERCONFIG_TYPE} — the kubelet ignores it for image pulls`
  }
  if (!dockerconfigMatchesHost(current.dockerconfig, host)) {
    return `its ${DOCKERCONFIG_KEY} carries no entry for "${host}", so the kubelet will never select it`
  }
  return null
}

function classify(current: SecretView | null, host: string): TargetState {
  if (!current) return { kind: 'absent' }
  // INVARIANT 1: never write a Secret we do not own — even a broken one. Adopting it would
  // seize an external operator's credential; repairing it in place would rotate the org
  // key out from under them. We still inspect it: not-ours decides who WRITES, not whether
  // the caller may attach a reference to it (see ensureInner).
  if (current.labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
    return { kind: 'foreign', unusable: foreignUsabilityProblem(current, host) }
  }
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

async function ensureInner(gateway: K8sGateway, targets: string[]): Promise<EnsurePass> {
  const out = new Map<string, EnsurePullSecretResult>()
  const unusable = new Map<string, string>()
  const blocked = new Map<string, string>()

  // ── Legitimate no-ops ─────────────────────────────────────────────────────
  // Managed clusters: the operator owns this Secret; never contend with it.
  const host = registryHostFromUrl(config.registryUrl)
  if (config.registryConnectionMode !== 'self-hosted' || !host) {
    for (const ns of targets) out.set(ns, 'skipped')
    return { results: out, unusable, blocked }
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

  // ── Foreign targets: hands off, but not a free pass ───────────────────────
  // Every caller of this service is about to attach an `imagePullSecrets` reference to
  // this name and persist a CRD, so a foreign Secret the kubelet cannot use is exactly as
  // fatal as a missing one — and we may not repair it. We RECORD that here rather than
  // throwing: the pass spans the whole platform set for the mint-once collapse, but only a
  // caller that actually references the namespace should be failed by it (see
  // `ensureRegistryPullSecrets`, which raises `foreign_secret_unusable` for its own
  // required set). A well-shaped foreign Secret proceeds untouched either way.
  const foreign = targets.filter(ns => states.get(ns)!.kind === 'foreign')
  const ours = targets.filter(ns => states.get(ns)!.kind !== 'foreign')
  for (const ns of foreign) {
    const state = states.get(ns) as { kind: 'foreign'; unusable: string | null }
    if (state.unusable) {
      unusable.set(ns, state.unusable)
      logger.warn(
        { namespace: ns, problem: state.unusable },
        'externally-owned evenfire-registry-pull Secret cannot serve an image pull; leaving it untouched — installs that reference this namespace will fail until it is fixed or removed'
      )
    } else {
      logger.warn(
        { namespace: ns },
        'externally-owned evenfire-registry-pull Secret present; leaving it untouched (remove it to let control-api manage this namespace)'
      )
    }
    out.set(ns, 'exists-foreign')
  }
  if (ours.length === 0) return { results: out, unusable, blocked }

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
    return { results: out, unusable, blocked }
  }

  // ── All-or-nothing: a USABLE foreign copy anywhere forbids the mint ───────
  // The credential is per-ORG and the mint is rotate-on-call, so minting for a namespace we
  // own would revoke the key inside the foreign Secret we just agreed not to touch. That
  // damage is invisible — the foreign bytes are unchanged, the foreign fingerprint is not
  // in the divergence set above, and invariant 1 forbids repairing it — so the only safe
  // move is to mint nothing and report the namespaces we could not fill. Owned copies that
  // are already current are untouched by this: they needed no mint, so `needsMint` above
  // has already returned them as `exists-ours`.
  //
  // The gate is USABILITY, not foreignness. An UNUSABLE foreign Secret cannot be serving a
  // pull for this registry by construction — the kubelet ignores a wrong `type` outright,
  // and never selects a blob carrying no entry for our host — so rotating the org key
  // cannot break a working path through it. Blocking on it would only fail installs that
  // never reference its namespace, which is the scoping this service already decided
  // against. It stays recorded in `unusable`, so the callers that DO reference it still
  // fail on it (`foreign_secret_unusable`).
  const blocking = foreign.filter(
    ns => (states.get(ns) as { unusable: string | null }).unusable === null
  )
  if (blocking.length > 0) {
    // Under divergence every owned copy needs the rewrite, not just the invalid ones.
    const unfillable = diverged ? ours : ours.filter(ns => states.get(ns)!.kind !== 'valid')
    const externals = blocking.map(n => `"${n}"`).join(', ')
    const all = platformWorkloadNamespaces()
      .map(n => `"${n}"`)
      .join(', ')
    for (const ns of unfillable) {
      blocked.set(
        ns,
        `cannot provision the ${EVENFIRE_REGISTRY_PULL_SECRET_NAME} Secret in namespace "${ns}": an externally-owned copy of it exists in ${externals}, and this organization's pull credential is rotate-on-call — minting one for "${ns}" would revoke the key inside that external Secret and break every pod already pulling with it. Either provision ${EVENFIRE_REGISTRY_PULL_SECRET_NAME} externally in ALL of ${all}, or delete the external copy in ${externals} so control-api can manage every namespace itself.`
      )
    }
    // The owned copies we did NOT block are genuinely current — nothing rotated their key —
    // so report them honestly. Leaving them out would fall through the wrapper's
    // `?? 'skipped'` and claim provisioning was never our job.
    for (const ns of ours) {
      if (!blocked.has(ns)) out.set(ns, 'exists-ours')
    }
    logger.warn(
      { external: blocking, unfillable },
      'usable externally-owned evenfire-registry-pull Secret present; refusing to mint (the mint is org-wide and rotate-on-call, so it would revoke the external key) — installs that need the unfillable namespaces will fail'
    )
    return { results: out, unusable, blocked }
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
    const outcome = await writeCredential(gateway, ns, state, cred, recreate.has(ns), {
      host,
      unusable,
    })
    out.set(ns, outcome)
  }

  auditPullSecret('registry_pull_secret_provisioned', {
    namespaces: ours,
    org: orgName,
    fingerprint: cred.fingerprint,
  })
  logger.info({ namespaces: ours, orgName }, 'registry pull secret provisioned')
  return { results: out, unusable, blocked }
}

/** Write `cred` into one namespace, choosing create/update/recreate from its prior state. */
async function writeCredential(
  gateway: K8sGateway,
  ns: string,
  state: TargetState,
  cred: MintedCredential,
  alreadyDeleted: boolean,
  // The pass's `unusable` map, so a foreign Secret discovered on the race path below is
  // recorded exactly as one discovered by `classify` would be — see the comment there.
  pass: { host: string; unusable: Map<string, string> }
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
      // Lost a create race — but NOT against ourselves: concurrent passes in this replica
      // collapse on the `inflight` key. The winner is therefore another writer (a second
      // replica, which this design does not support, or an out-of-band actor), and which
      // key is live is not knowable here — ours revoked theirs only if we minted last.
      // Write ours anyway, so this pass leaves every namespace it owns on ONE key;
      // adopting the winner's would split this namespace from the rest for a credential we
      // can verify no better. Skip if the winner is foreign — invariant 1 still holds.
      const winner = await readCurrent(gateway, ns)
      if (!winner) {
        // Created and deleted again before this read. The Secret is absent, and an update
        // against an absent Secret 404s — so create, do not fall through.
        await gateway.createSecret(buildSecretReq(ns, cred))
        return 'created'
      }
      if (winner.labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
        // The all-or-nothing scan in ensureInner ran before this Secret existed, so the
        // mint has already happened and cannot be taken back. What we CAN still do is give
        // this namespace the same verdict the classify path would: a foreign Secret the
        // kubelet will ignore must fail the callers that reference it, not sail past them
        // and leave a CRD pointing at a credential no pod can use.
        const problem = foreignUsabilityProblem(winner, pass.host)
        if (problem) {
          pass.unusable.set(ns, problem)
          logger.warn(
            { namespace: ns, problem },
            'lost the create race to an externally-owned evenfire-registry-pull Secret that cannot serve an image pull; leaving it untouched — installs that reference this namespace will fail until it is fixed or removed'
          )
        }
        return 'exists-foreign'
      }
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
