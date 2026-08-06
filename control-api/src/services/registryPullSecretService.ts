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
 * confined to.
 *
 * MANAGED clusters: VERIFY, never write. control-api provisions nothing there — the
 * platform operator owns the Secret — but WRC still injects the reference, so a namespace
 * the operator has not populated yields a workload that can only ImagePullBackOff, behind
 * a 201. Managed mode therefore runs a read-only presence check over the platform
 * namespaces (`verifyOperatorProvisioned`) and fails the caller BEFORE the CRD is
 * persisted when one it needs has no usable copy (`operator_secret_missing`). This asserts
 * nothing about what any operator does; it only refuses to persist a reference that cannot
 * resolve on THIS cluster right now. The check is scoped by `required` for the same reason
 * everything else here is: today's managed operator populates mcp-server, so McpServer
 * installs must keep working while recipe installs — which land in all three — do not
 * silently half-work.
 *
 * A recipe caller passes the whole platform set and requires all of it, which is stricter
 * than that recipe may strictly need: control-api does not model WRC's per-workload
 * kind→namespace split, so it cannot tell which of the three a given recipe will land in.
 * Requiring all three is the conservative side of that gap — it refuses an install that
 * MIGHT have pulled rather than persisting one that might not.
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
 *
 * Invariant 1 is about a moment, not a name. Ownership is classified once per pass, and the
 * mutations that follow (the wrong-type delete, the credential write) happen later, with a
 * mint in between. `withPullSecretLock` does not help: it serializes control-api replicas
 * against each other, not against an operator, another controller or a `kubectl` replacing
 * the same NAME — and the reconcile cron reopens that window on every tick rather than once
 * per install. So every mutation re-proves ownership immediately before it acts, comparing
 * `metadata.uid` and the ownership marker against what was classified (`recheckOwnership`),
 * and then CARRIES that identity into the write itself as a precondition, so the apiserver
 * refuses a replace or delete against an object that moved in the gap (`mutateOwned`).
 * A namespace that changed hands is recorded (`ownership_changed`) and left alone; one that
 * merely vanished is created, since the mint has already revoked whatever key it held.
 */
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { withTransaction } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import { rootLogger } from '../observability/logger.js'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  registryHostFromUrl,
} from '../routes/admin/registryImagePullSecret.js'
import type { SecretPreconditions, SecretUpsertRequest } from '../types.js'
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

/**
 * This service is a PLATFORM writer, not a user-facing route: it stamps
 * `clerum.io/`-prefixed metadata (the ownership label and the key fingerprint) that
 * `secretConstraints` deliberately blocks by default, so a caller cannot forge platform
 * ownership through `/admin/secrets` or the recipe-secret routes. Every write here opts in
 * explicitly — dropping this makes each write 400, and `MockGateway` (which bypasses
 * `SecretService`) will NOT catch it; see test/services.pullSecretConstraints.test.ts.
 */
const PLATFORM_WRITE = { allowPlatformAnnotations: true } as const

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
    if (!parsed?.auths || !Object.prototype.hasOwnProperty.call(parsed.auths, host)) return false
    return dockerconfigEntryCarriesCredential(parsed.auths[host])
  } catch {
    return false
  }
}

/**
 * Does an `auths[<host>]` entry carry something the kubelet can actually present?
 *
 * Host presence alone is not enough. `{"auths":{"registry.example":{}}}` parses cleanly,
 * matches the host, and is entirely unusable — the kubelet finds no credential to send and
 * the pull goes out anonymous. Accepting it is wrong in BOTH directions:
 *
 *  - for a Secret we own, it classifies an empty copy as healthy instead of repairing it;
 *  - for a FOREIGN copy it is worse, because the all-or-nothing gate reads "usable foreign"
 *    as "somebody's live credential is sealed in here" and refuses to mint at all. Nothing
 *    was ever served through an empty entry, so that is a self-inflicted outage: every
 *    private install fails closed on account of a Secret that could never pull.
 *
 * Accepted forms, all of which the kubelet understands: `auth` (base64 `user:password`, what
 * Docker writes), the split `username`/`password` form some tools emit, and the
 * `identitytoken` / `registrytoken` fields credential helpers use. Any ONE non-empty string
 * suffices — this is a usability check, not a validity check. Whether the credential still
 * WORKS is the registry's answer to give, costs a round trip per install, and belongs to
 * the out-of-band-revocation problem, which is tracked separately.
 */
function dockerconfigEntryCarriesCredential(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
  return (
    nonEmpty(e.auth) ||
    nonEmpty(e.password) ||
    nonEmpty(e.identitytoken) ||
    nonEmpty(e.registrytoken)
  )
}

/**
 * Which OBJECT a read saw, as opposed to what was in it.
 *
 * `uid` is the only thing that survives a delete-and-recreate of the same name: labels,
 * annotations and data can all be reproduced by whoever took the name over, and
 * `resourceVersion` only says "something changed", not "this is a different object". It is
 * what lets a mutation prove it is acting on the thing `classify` decided about rather than
 * on whatever now answers to that name (see `recheckOwnership`).
 */
interface SecretIdentity {
  uid: string | undefined
  resourceVersion: string | undefined
}

interface SecretView extends SecretIdentity {
  labels: Record<string, string>
  annotations: Record<string, string>
  type: string | undefined
  dockerconfig: string | undefined
}

function readSecret(raw: unknown): SecretView {
  const s = (raw ?? {}) as {
    metadata?: {
      labels?: Record<string, string>
      annotations?: Record<string, string>
      uid?: string
      resourceVersion?: string
    }
    type?: string
    data?: Record<string, string>
  }
  return {
    labels: s.metadata?.labels ?? {},
    annotations: s.metadata?.annotations ?? {},
    uid: s.metadata?.uid,
    resourceVersion: s.metadata?.resourceVersion,
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
 * `missing`   — MANAGED mode only: a platform namespace with no usable operator-provisioned
 *              copy (`operator_secret_missing`). Fragments ("it does not exist", "it exists
 *              but …"), because the caller-facing sentence names every missing namespace at
 *              once and only `ensureRegistryPullSecrets` knows which ones the caller needs.
 * `taken`    — a namespace we OWNED at classify time whose Secret changed hands before we
 *              could mutate it (`ownership_changed`). Fragments, like `unusable`: the
 *              caller-facing sentence is assembled by `ensureRegistryPullSecrets`.
 *
 * `missing` is mutually exclusive with the rest by mode: it comes from the verification
 * pass, the others from the provisioning pass, and a pass is one or the other.
 */
type EnsurePass = {
  results: Map<string, EnsurePullSecretResult>
  unusable: Map<string, string>
  blocked: Map<string, string>
  missing: Map<string, string>
  taken: Map<string, string>
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
 * reference fails the install loudly instead of persisting an unresolvable one. In managed
 * mode `'skipped'` is now a VERIFIED answer rather than an assumed one: the operator's
 * copies are read first, and a required namespace without a usable one throws too.
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
  const { results, unusable, blocked, missing, taken } = await run

  // A recorded failure is fatal only to a caller that needs THAT namespace. A pass covers
  // the whole platform set (for the mint-once collapse), so an MCP install must not be
  // failed by a squatter in a sandbox namespace it never references — while a recipe
  // install, which does land there, still fails loudly. `required` defaults to every target,
  // so a caller that asks for a set is asserting it needs all of it.
  const required = opts.required ?? targets

  // MANAGED mode: the operator owns the Secret, so the only thing we can do for a caller
  // is refuse to persist a reference that cannot resolve. Report every missing namespace
  // at once — an operator fixing one at a time would otherwise walk the whole set through
  // three failed installs. (Order against the two loops below is not load-bearing: this
  // map and those are populated by different passes; see EnsurePass.)
  const absent = required.filter(ns => missing.has(ns))
  if (absent.length > 0) {
    const host = registryHostFromUrl(config.registryUrl)
    const detail = absent.map(ns => `"${ns}" (${missing.get(ns)})`).join(', ')
    throw new PullSecretProvisionError(
      `the ${EVENFIRE_REGISTRY_PULL_SECRET_NAME} Secret cannot serve an image pull in ${detail}. This cluster runs in "${config.registryConnectionMode}" registry mode, where the platform operator — not control-api — owns that Secret, so control-api will not create it here. Ask the operator to provision ${EVENFIRE_REGISTRY_PULL_SECRET_NAME} (type ${DOCKERCONFIG_TYPE}, with a ${DOCKERCONFIG_KEY} entry for "${host}") in the namespace(s) above, then retry. Proceeding would persist a workload referencing a credential no pod can resolve.`,
      'operator_secret_missing',
      409
    )
  }

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
  // A namespace that changed hands mid-pass. Same scoping as `unusable` — the pass sweeps
  // the whole platform set, so only a caller that references this namespace may be failed by
  // it — and after `unusable`, which names a defect that is there to stay: a takeover is a
  // race, and the retry this message asks for may well find a settled cluster.
  // Order against `blocked` is not load-bearing: `blocked` is recorded on a path that
  // returns before anything is mutated, so the two maps are never both populated.
  for (const ns of required) {
    const why = taken.get(ns)
    if (why) {
      throw new PullSecretProvisionError(
        `the ${EVENFIRE_REGISTRY_PULL_SECRET_NAME} Secret in namespace "${ns}" changed hands while this pass was running: ${why}. control-api classified it as its own, then found a different object under that name before writing, so it wrote nothing — it never touches a Secret it does not own. Retry: the next pass classifies what is actually there, so a usable external copy settles into the normal externally-provisioned case and an unusable one comes back as foreign_secret_unusable, naming the concrete defect.`,
        'ownership_changed',
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

/**
 * Classification of one namespace's current Secret, decided before anything is minted.
 *
 * The two states that lead to a MUTATION carry `observed`: the identity of the object the
 * decision was made about. Everything downstream of `classify` acts on a snapshot — the
 * mint sits between the read and the write — so a mutation has to be able to say which
 * object it meant. `foreign` and `absent` carry none: nothing is ever mutated on a foreign
 * target, and an absent one is created (a create is its own compare-and-swap — it 409s if
 * the name is taken, which `writeCredential` already handles).
 */
type TargetState =
  | { kind: 'foreign'; unusable: string | null }
  | { kind: 'valid'; fingerprint: string; observed: SecretIdentity }
  | { kind: 'absent' }
  | { kind: 'broken'; wrongType: boolean; observed: SecretIdentity }

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
    // Two different repairs, so name which one it is: a missing entry is usually the wrong
    // registry host, an empty one is usually a half-written or template-generated Secret.
    return `its ${DOCKERCONFIG_KEY} carries no usable credential for "${host}" (the entry is absent, or present but carries no auth/password/token), so the kubelet will never select it`
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
  const observed: SecretIdentity = {
    uid: current.uid,
    resourceVersion: current.resourceVersion,
  }
  const wrongType = current.type !== DOCKERCONFIG_TYPE
  // Presence alone is not enough: a blob keyed on a previous registry host can never be
  // selected by the kubelet, and a copy with no fingerprint cannot be compared across
  // namespaces.
  const fingerprint = current.annotations[FINGERPRINT_ANNOTATION]
  if (wrongType || !dockerconfigMatchesHost(current.dockerconfig, host) || !fingerprint) {
    return { kind: 'broken', wrongType, observed }
  }
  return { kind: 'valid', fingerprint, observed }
}

/**
 * What a pre-mutation re-read concluded about the object still sitting under that name.
 *
 * `same` carries the identity THAT READ saw, not the one `classify` saw: it is what the
 * following mutation binds itself to, so the API server can reject the write if anything
 * moves in between (see `mutateOwned`). Passing the older identity would pin the write to a
 * version the object may legitimately have left behind.
 */
type OwnershipRecheck =
  | { verdict: 'same'; current: SecretIdentity }
  | { verdict: 'gone' }
  | { verdict: 'taken'; why: string }

/**
 * Re-prove, immediately before mutating `ns`, that the Secret there is still the object
 * `classify` decided about and still carries our ownership marker.
 *
 * WHY IT IS NEEDED. Everything after `classify` acts on a snapshot: the wrong-type delete
 * and the credential write both happen later, with a mint in between. `withPullSecretLock`
 * does not cover this — it serializes control-api replicas against each other, not against
 * an operator, another controller or a `kubectl` replacing the same NAME. And
 * `SecretService.updateSecret` cannot cover it either: it re-reads to pick up the latest
 * `resourceVersion`, which makes it always WIN the write; it never asks whether it is still
 * the same object. Without this check, invariant 1 ("never write a Secret we do not own")
 * only holds for as long as nobody else moves — and the reconcile cron reopens the window
 * every tick rather than once per install.
 *
 * WHAT IT IS — AND IS NOT. On its own this is only half a compare-and-swap: the proof read
 * is a separate API request from the mutation, so a takeover landing between the two would
 * still slip through. It is never called on its own for that reason. `mutateOwned` pairs it
 * with an `If-Match`-style precondition on the write itself — the identity returned here is
 * carried into `metadata.resourceVersion` on the replace and `preconditions.uid` on the
 * delete — so the API server, not this function, is what finally refuses a write to an
 * object that moved. This read still earns its place: it produces the fresh identity the
 * write binds to, and it distinguishes `gone` (create instead) from `taken` (surrender),
 * neither of which a bare 409 can tell apart.
 *
 * WHAT IT COMPARES. `uid` and the ownership label, per the two ways a name changes hands:
 *   - `uid` differs ⇒ deleted and recreated. Data, labels and annotations can all be
 *     reproduced by the new owner; the uid cannot.
 *   - the marker is gone ⇒ adopted in place by an external owner, and `classify` would now
 *     call it `foreign`.
 * `resourceVersion` is deliberately NOT a gate HERE, though it is a precondition on the
 * write. It changes on any edit, including benign ones by something that left our marker in
 * place, and refusing on that basis would be worse than writing: the mint has already
 * revoked the key that copy holds, so declining to overwrite leaves the namespace on a dead
 * credential. That is why `mutateOwned` treats the resulting 409 as "re-read and try again",
 * not as "surrender" — only this function's ownership verdict may end the attempt. Here the
 * version difference is logged, which is where "still ours, but someone edited it" is worth
 * seeing.
 *
 * `uid` is compared only when both reads surfaced one. The API server always sets it; a
 * caller that cannot see it (an older gateway, a fake) falls back to the ownership label,
 * which is exactly the evidence `classify` itself used.
 *
 * A read failure other than 404 propagates, same as everywhere else here. Before the mint
 * that aborts the pass having changed nothing; after it, it leaves the remaining namespaces
 * unwritten — which is the pre-existing behaviour of any post-mint write failure, and the
 * fingerprint divergence check converges it on the next pass.
 */
async function recheckOwnership(
  gateway: K8sGateway,
  ns: string,
  observed: SecretIdentity
): Promise<OwnershipRecheck> {
  const now = await readCurrent(gateway, ns)
  if (!now) return { verdict: 'gone' }
  if (now.labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
    return {
      verdict: 'taken',
      why: `its ${MANAGED_BY_LABEL} label is no longer "${MANAGED_BY_VALUE}", so an external owner has adopted that name`,
    }
  }
  if (observed.uid && now.uid && observed.uid !== now.uid) {
    return {
      verdict: 'taken',
      why: 'it was deleted and recreated by something else (metadata.uid changed), so it is no longer the Secret this pass classified',
    }
  }
  if (observed.resourceVersion && now.resourceVersion !== observed.resourceVersion) {
    logger.info(
      { namespace: ns, from: observed.resourceVersion, to: now.resourceVersion },
      'evenfire-registry-pull Secret was modified between classification and write; still ours, proceeding'
    )
  }
  return { verdict: 'same', current: { uid: now.uid, resourceVersion: now.resourceVersion } }
}

/**
 * How many times an ownership-bound mutation may lose a benign race before we stop.
 *
 * Each attempt is one read plus one write, and the only thing that makes an attempt fail
 * without ending the loop is a 409 from something else writing the same Secret in that gap.
 * Three is chosen to absorb a genuine race, not to wait out a controller that is fighting us
 * for the name: with a persistent writer no number of retries converges, and the honest
 * answer is to stop and report, which is what exhausting these does.
 */
const OWNERSHIP_CAS_ATTEMPTS = 3

/** The outcome of an ownership-bound mutation. `done` means it landed. */
type MutateOutcome = { verdict: 'done' } | { verdict: 'gone' } | { verdict: 'taken'; why: string }

/**
 * Mutate the Secret in `ns` ONLY IF it is still the object this pass classified and still
 * ours — a real compare-and-swap, decided by the API server rather than by a read we hope
 * nothing raced.
 *
 * `recheckOwnership` alone cannot do this: it proves ownership in one request and the
 * mutation happens in the next, so a takeover in that gap is invisible to it. Here the
 * identity it observed is carried INTO the mutation as a precondition (`resourceVersion` on
 * a replace, `preconditions.uid` on a delete), so a write to an object that moved is
 * refused with 409 by the apiserver — the check and the use become one operation.
 *
 * WHY 409 IS NOT AN ANSWER BY ITSELF. It says "this object is not what you thought", which
 * conflates two very different situations: someone took the name over, and someone edited a
 * Secret that is still ours. Surrendering on both would be wrong — the mint upstream has
 * already revoked the key the existing copy holds, so refusing to write over a benign edit
 * strands that namespace on a dead credential, an ImagePullBackOff we caused ourselves. So a
 * 409 sends us back through `recheckOwnership`, which CAN tell the two apart, and only its
 * `taken` verdict ends the loop. That is also why the retry drops the stale
 * `resourceVersion` but keeps the `uid`: the version is expected to have moved, the identity
 * is not.
 *
 * `gone` is returned rather than retried — the object is absent, and what to do about that
 * differs per call site (create the credential, or accept that the delete is already done).
 */
async function mutateOwned(
  gateway: K8sGateway,
  ns: string,
  observed: SecretIdentity,
  mutate: (precondition: SecretPreconditions) => Promise<unknown>
): Promise<MutateOutcome> {
  let expected = observed
  for (let attempt = 1; attempt <= OWNERSHIP_CAS_ATTEMPTS; attempt++) {
    const recheck = await recheckOwnership(gateway, ns, expected)
    if (recheck.verdict !== 'same') return recheck
    try {
      await mutate({
        uid: recheck.current.uid,
        resourceVersion: recheck.current.resourceVersion,
      })
      return { verdict: 'done' }
    } catch (err) {
      if (k8sStatus(err) !== 409) throw err
      logger.info(
        { namespace: ns, attempt },
        'evenfire-registry-pull Secret changed under an ownership-bound write; re-proving ownership before retrying'
      )
      // Keep the identity, drop the version: the next `recheckOwnership` must still catch a
      // delete-and-recreate, but the version it compares against is known to be stale and
      // would only log noise.
      expected = { uid: recheck.current.uid, resourceVersion: undefined }
    }
  }
  return {
    verdict: 'taken',
    why: `something else rewrote it during each of ${OWNERSHIP_CAS_ATTEMPTS} ownership-bound write attempts, so this pass never managed to write it without risking somebody else's object`,
  }
}

/**
 * Serialize the read->mint->write pass ACROSS PROCESSES.
 *
 * The in-process dedupe map only covers one replica, and `replicas: 1` with the default
 * RollingUpdate means two control-api pods coexist on every deploy. Without this, their
 * mints interleave: A mints k1, B mints k2 (revoking k1), and whichever writes last leaves
 * some namespaces holding a revoked key. The fingerprint check makes that self-healing,
 * but only on the NEXT pass — pulls fail until then.
 *
 * `pg_advisory_xact_lock` blocks rather than failing, which is what we want: the second
 * pod waits, then re-reads and finds a valid, agreeing credential, so it returns
 * `exists-ours` without minting at all. The lock auto-releases on commit/rollback, so it
 * cannot leak — the same mechanism the registry uses inside `mintPullKey`, and that
 * `traceMaintenance` uses for cross-replica dedup.
 *
 * The transaction is held across the K8s and registry calls inside `work`. That is
 * deliberate and bounded: the mint carries a timeout and the K8s calls are few.
 */
async function withPullSecretLock<T>(orgName: string, work: () => Promise<T>): Promise<T> {
  return withTransaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `registry-pull-secret:${orgName}`,
    ])
    return work()
  })
}

/** An empty pass, ready to be recorded into. */
function newPass(): EnsurePass {
  return {
    results: new Map(),
    unusable: new Map(),
    blocked: new Map(),
    missing: new Map(),
    taken: new Map(),
  }
}

async function ensureInner(gateway: K8sGateway, targets: string[]): Promise<EnsurePass> {
  // One record-and-decide accumulator threaded through the pass, rather than a growing list
  // of positional Maps: which reason a namespace lands in is the whole output of this
  // service, and every writer needs to reach more than one of them.
  const pass = newPass()

  // ── Legitimate no-ops ─────────────────────────────────────────────────────
  // No registry host: nothing references it, and there is no host to check a blob
  // against either — the pull secret is not in play at all.
  const host = registryHostFromUrl(config.registryUrl)
  if (!host) {
    for (const ns of targets) pass.results.set(ns, 'skipped')
    return pass
  }
  // Managed clusters: the operator owns this Secret; never contend with it — but do check
  // that what the caller is about to reference is actually there.
  if (config.registryConnectionMode !== 'self-hosted') {
    return verifyOperatorProvisioned(gateway, targets, host)
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

  // Everything from here — read, classify, mint, write — must be serialized across
  // replicas, not just within this process (see withPullSecretLock).
  return withPullSecretLock(orgName, () =>
    ensureLocked(gateway, targets, host, orgName as string, pass)
  )
}

/**
 * MANAGED clusters: read-only verification that the operator's Secret is where the caller
 * is about to point a workload at it. Mints nothing, writes nothing, takes no lock, and
 * touches neither Postgres nor the registry — invariant 1 admits no exception here, and
 * "the operator owns it" is precisely why we may only look.
 *
 * Reuses `foreignUsabilityProblem`, the same shape-only test applied to externally-owned
 * Secrets on the self-hosted path: correct type, and a dockerconfig entry for our host. A
 * second notion of "usable" would drift from the one the kubelet actually acts on. Ownership
 * is deliberately NOT consulted — whoever wrote it, all that matters is whether it can serve
 * the pull — and neither is liveness of the sealed key, which would cost a registry
 * round-trip per install.
 *
 * Scoped to `platformWorkloadNamespaces()`: that set is the operator contract. A target
 * outside it stays `'skipped'` rather than becoming a failure, because control-api has no
 * claim about namespaces no operator ever agreed to populate, and failing there would break
 * managed installs that work today.
 */
async function verifyOperatorProvisioned(
  gateway: K8sGateway,
  targets: string[],
  host: string
): Promise<EnsurePass> {
  const pass = newPass()
  const platform = new Set(platformWorkloadNamespaces())
  for (const ns of targets) {
    // Provisioning is genuinely not our job on this cluster, so the result stays 'skipped'
    // whichever way the check goes; the verdict travels in `missing`.
    pass.results.set(ns, 'skipped')
    if (!platform.has(ns)) continue
    const current = await readCurrent(gateway, ns)
    if (!current) {
      pass.missing.set(ns, 'it does not exist')
      continue
    }
    const problem = foreignUsabilityProblem(current, host)
    if (problem) pass.missing.set(ns, `it exists but ${problem}`)
  }
  // Deliberately not logged at warn: this runs on every reconcile tick as well as every
  // install, and on a managed cluster an unpopulated namespace is a normal state until
  // something actually asks for it. The caller that asks gets the loud failure.
  if (pass.missing.size > 0) {
    logger.debug(
      { namespaces: [...pass.missing.keys()] },
      'managed cluster: no usable operator-provisioned evenfire-registry-pull Secret in these namespaces'
    )
  }
  return pass
}

/**
 * The read -> classify -> mint -> write pass. Runs while holding the cross-process lock,
 * so it may assume no other replica is minting for this org concurrently.
 */
async function ensureLocked(
  gateway: K8sGateway,
  targets: string[],
  host: string,
  orgName: string,
  // `pass.missing` is always empty on this path: a namespace with nothing in it is one we
  // PROVISION, not one we report as missing. It rides along so both passes return the same
  // shape.
  pass: EnsurePass
): Promise<EnsurePass> {
  const { results: out, unusable, blocked } = pass
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
  if (ours.length === 0) return pass

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
    return pass
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
    return pass
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
  //
  // A delete acts on a name, not on the object we classified, so re-prove ownership first
  // (`recheckOwnership`). This is the destructive half of the TOCTOU: without it, a Secret
  // replaced between the classify read and here is deleted on the strength of a decision
  // made about something that no longer exists — an external operator's credential removed
  // by a reconcile tick.
  const recreate = new Set<string>()
  const surrendered = new Set<string>()
  for (const ns of ours) {
    const state = states.get(ns)!
    if (state.kind !== 'broken' || !state.wrongType) continue
    const outcome = await mutateOwned(gateway, ns, state.observed, precondition =>
      gateway.deleteSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns, precondition)
    )
    if (outcome.verdict === 'taken') {
      recordTakeover(pass, ns, outcome.why)
      surrendered.add(ns)
      continue
    }
    // 'gone': already deleted by someone else, so there is nothing to delete — but the
    // namespace still needs the credential, and `recreate` is exactly "create, do not
    // update" downstream. Falling through to the update path would 404.
    recreate.add(ns)
  }
  // Namespaces that changed hands are no longer ours to write. Every caller that references
  // one fails on `ownership_changed`; the rest of the pass proceeds for the namespaces we
  // still own, because they need the credential regardless.
  //
  // KNOWN RESIDUAL: a copy that turns up here is NOT fed back into the all-or-nothing mint
  // block above, so if it is a usable foreign Secret the mint below can still revoke the key
  // sealed in it. Closing that would mean re-classifying the whole set and rebuilding the
  // `blocked` messages mid-pass, for a window measured in one round trip — and the same
  // residual already exists for a foreign Secret that appears any time after the classify
  // read, including on the create-race path in `writeCredential`. What is fixed here is the
  // part that is unrecoverable: we no longer DELETE or OVERWRITE somebody else's object.
  const writable = ours.filter(ns => !surrendered.has(ns))
  if (writable.length === 0) return pass

  // ── Mint ONCE, then fan the same credential out to every namespace we own ──
  // Namespaces that were already valid are rewritten too: the mint just revoked the key
  // they were holding.
  const cred = await mintCredential(orgName, host)
  for (const ns of writable) {
    const state = states.get(ns)!
    const outcome = await writeCredential(gateway, ns, state, cred, recreate.has(ns), {
      host,
      pass,
    })
    out.set(ns, outcome)
  }

  auditPullSecret('registry_pull_secret_provisioned', {
    namespaces: writable,
    org: orgName,
    fingerprint: cred.fingerprint,
  })
  logger.info({ namespaces: writable, orgName }, 'registry pull secret provisioned')
  return pass
}

/**
 * Record a namespace whose Secret changed hands between classification and mutation.
 *
 * Recorded, not thrown, for the same reason `unusable` is: the pass spans the whole platform
 * set so the mint can be collapsed across callers, and only a caller that actually
 * references this namespace should be failed by what happens in it.
 *
 * The result is `'exists-foreign'` because that is now literally true — someone else owns
 * that name — and it keeps `results` complete, so a caller that does NOT require this
 * namespace gets a truthful answer instead of falling through the single-namespace
 * wrapper's `?? 'skipped'` (which would claim provisioning was never our job).
 */
function recordTakeover(pass: EnsurePass, ns: string, why: string): void {
  pass.taken.set(ns, why)
  pass.results.set(ns, 'exists-foreign')
  logger.warn(
    { namespace: ns, problem: why },
    'evenfire-registry-pull Secret changed owner between classification and write; leaving it untouched — installs that reference this namespace will fail until the cluster settles'
  )
}

/** Write `cred` into one namespace, choosing create/update/recreate from its prior state. */
async function writeCredential(
  gateway: K8sGateway,
  ns: string,
  state: TargetState,
  cred: MintedCredential,
  alreadyDeleted: boolean,
  // The whole pass, so a foreign Secret discovered on either race path below is recorded
  // exactly as one discovered by `classify` would be — see the comments there.
  ctx: { host: string; pass: EnsurePass }
): Promise<EnsurePullSecretResult> {
  // Wrong-typed Secrets were deleted before the mint (see ensureInner), so they are now
  // absent and must be created, not updated.
  if (alreadyDeleted) {
    await gateway.createSecret(buildSecretReq(ns, cred), PLATFORM_WRITE)
    return 'repaired'
  }
  if (state.kind === 'absent') {
    try {
      await gateway.createSecret(buildSecretReq(ns, cred), PLATFORM_WRITE)
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
        await gateway.createSecret(buildSecretReq(ns, cred), PLATFORM_WRITE)
        return 'created'
      }
      if (winner.labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
        // The all-or-nothing scan in ensureInner ran before this Secret existed, so the
        // mint has already happened and cannot be taken back. What we CAN still do is give
        // this namespace the same verdict the classify path would: a foreign Secret the
        // kubelet will ignore must fail the callers that reference it, not sail past them
        // and leave a CRD pointing at a credential no pod can use.
        const problem = foreignUsabilityProblem(winner, ctx.host)
        if (problem) {
          ctx.pass.unusable.set(ns, problem)
          logger.warn(
            { namespace: ns, problem },
            'lost the create race to an externally-owned evenfire-registry-pull Secret that cannot serve an image pull; leaving it untouched — installs that reference this namespace will fail until it is fixed or removed'
          )
        }
        return 'exists-foreign'
      }
      // The winner is ours, so adopt it — but bind the write to the object we just read.
      // "Read `winner`, then update by name" is the same TOCTOU as everywhere else on this
      // path: the ownership check and the replace are two requests, and `updateSecret`
      // without a precondition re-reads and wins regardless of what landed in between. A
      // create race is precisely when a third writer is known to be active on this name, so
      // this is the LAST place to assume the gap is safe.
      const adopted = await mutateOwned(gateway, ns, winner, precondition =>
        gateway.updateSecret(buildSecretReq(ns, cred), precondition, PLATFORM_WRITE)
      )
      if (adopted.verdict === 'taken') {
        recordTakeover(ctx.pass, ns, adopted.why)
        return 'exists-foreign'
      }
      if (adopted.verdict === 'gone') {
        // Deleted again in the gap. Nobody holds the name and the namespace still needs a
        // credential, so create rather than leaving it empty.
        await gateway.createSecret(buildSecretReq(ns, cred), PLATFORM_WRITE)
      }
      return 'created'
    }
  }
  if (state.kind === 'foreign') {
    // Unreachable: foreign targets are filtered out of `ours` before the write loop. Kept as
    // a typed dead end rather than a cast, so a future caller that forgets the filter cannot
    // turn invariant 1 into a runtime accident.
    return 'exists-foreign'
  }
  // The update path. Left to itself `SecretService.updateSecret` re-reads to pick up the
  // latest `resourceVersion` and therefore ALWAYS wins the write — it proves the object is
  // current, never that it is still ours. `mutateOwned` binds the replace to the identity we
  // classified instead, so the apiserver refuses it if the object moved.
  const outcome = await mutateOwned(gateway, ns, state.observed, precondition =>
    gateway.updateSecret(buildSecretReq(ns, cred), precondition, PLATFORM_WRITE)
  )
  if (outcome.verdict === 'taken') {
    recordTakeover(ctx.pass, ns, outcome.why)
    return 'exists-foreign'
  }
  if (outcome.verdict === 'gone') {
    // Deleted under us. NOT a takeover — nobody else holds the name — and the mint above has
    // already revoked whatever key that copy carried, so leaving the namespace empty is the
    // one outcome guaranteed to ImagePullBackOff. Create, because an update against an
    // absent Secret 404s.
    await gateway.createSecret(buildSecretReq(ns, cred), PLATFORM_WRITE)
    return 'created'
  }
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
