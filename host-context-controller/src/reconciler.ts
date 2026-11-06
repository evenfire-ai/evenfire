/**
 * McpServer Reconciler - manages Kubernetes Deployments and Services
 * based on McpServer CRD state.
 *
 * Responsibilities:
 * - Create Deployment + Service when a new McpServer CRD appears
 * - Update Deployment when an McpServer CRD is modified
 * - Delete Deployment + Service when an McpServer CRD is removed
 * - Validate that referenced secrets exist before creating deployments
 * - Full reconciliation on startup (sync desired vs actual state)
 */
import * as k8s from '@kubernetes/client-node'
import { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { createHash } from 'crypto'
import { classifyPluginImage } from '@clerum/image-policy'
import {
  NETWORK_READY_ANNOTATION,
  NETWORK_READY_GENERATION_ANNOTATION,
  PRE_DEPLOY_ANNOTATION,
} from '@clerum/network-policy-core'
import { isWorkflowRecipeDefaultAllowedCapability } from '@clerum/workflow-recipe-capability-policy'
import { config } from './config'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, MCPSERVER_LABEL } from './constants'
import { isQueryValueAllowed, isQuotedValueAllowed } from './egressProxyValueClass'
import { hccLogger } from './logger'
import {
  confirmAuthoritativeMcpServerAbsence,
  sameMcpServerDesiredRevision,
  shouldFailClosedForSecretFailure,
} from './mcpServerSafety'
import { createsTotal, mcpserverMissingSecret } from './metrics'
import { McpServerCRD, McpServerStatus } from './types'
import {
  canonicalStringify,
  configMapMatchesDesired,
  deploymentMatchesDesired,
  ensureResource,
  getErrorCode,
  observeCreate,
  observeExistenceRead,
  preserveDeploymentAnnotations,
  preserveObjectAnnotations,
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
  serviceMatchesDesired,
} from './utils'

/**
 * Result of validating an envSecret reference. When `ok` is false, `reason`
 * classifies the failure so the caller can surface it via status conditions.
 */
export type SecretValidationResult =
  | {
      ok: true
      /**
       * sha256 of the validated Secret's content (issue #223). Empty when the
       * McpServer has no envSecret. Travels into the pod template as the
       * credentials-revision annotation, which is what makes a credential
       * rotation roll the pod: env vars come from `secretKeyRef` and Kubernetes
       * only injects those when the container starts.
       *
       * It is derived from the very Secret this validation read, so the digest
       * can never describe a different revision than the one that was checked.
       */
      revision: string
      /**
       * The base64 `data` object of the very Secret this validation read and
       * hashed, so the egress-proxy preflight (reconciler.ts,
       * EgressProxyValuesValid) judges the exact version whose digest goes on
       * the PodTemplate. It stays base64: only the preflight decodes it, key by
       * key, into the bytes the kubelet places in the container env. Empty when
       * the McpServer has no envSecret.
       */
      secretData: Record<string, string>
    }
  | {
      ok: false
      reason: 'SecretNotFound' | 'SecretMissingKey' | 'SecretAccessDenied' | 'ReadError'
      message: string
    }

/**
 * Condition written to `status.conditions[]` on an McpServer CRD.
 * `status` is the K8s-standard string tri-state, NOT a boolean.
 */
export interface McpServerCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason: string
  message: string
  lastTransitionTime: string
  observedGeneration?: number
}

type McpServerReconcilerDeps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  customApi?: k8s.CustomObjectsApi
  /**
   * TEST-ONLY escape hatch. When the inventory-authority fence is not wired
   * (setInventoryAuthority / setResolveCurrentServer never called), mutation
   * fences fail CLOSED by default. Unit tests that exercise the reconciler
   * without a watcher opt in to the legacy assume-current behavior here.
   * Production construction (k8sClient) must never set this.
   */
  assumeInventoryAuthorityWhenUnconfigured?: boolean
}

export type McpServerInventoryAuthoritySnapshot = {
  known: boolean
  generation: number
}

export type McpServerFullReconcileOptions = {
  runEffect?: (serverName: string, work: () => Promise<void>) => Promise<void>
  maxConcurrency?: number
  // Restrict create/update and orphan cleanup to these names. desiredServers
  // must still be the whole inventory so out-of-scope servers are never
  // mistaken for orphans.
  scope?: ReadonlySet<string>
}

export type McpServerMutationOptions = {
  isCurrent?: () => boolean
}

/**
 * One reason the egress-proxy value preflight refuses a value.
 * Only names, sources and contexts travel here: never a value byte, a value
 * length or an offending character.
 */
type EgressProxyValueViolation = {
  context: 'query' | 'quoted' | 'collision'
  placeholder: string
  source: string
  header?: string
  kind: 'class' | 'dependent-env'
}

type EgressProxyValueVerdict =
  | { ok: true }
  | { ok: false; violations: EgressProxyValueViolation[]; message: string }

/** At most this many violations are spelled out in the status message. */
const MAX_EGRESS_PROXY_VALUE_ENTRIES = 10

// G2: Pre-deploy handshake constants — imported from @clerum/network-policy-core
// (single source of truth shared with WRC; a divergence is a compile error rather
// than a silent 30s fail-open timeout). clerum.io/network-ready-observed-generation
// (Issue #408) is the generation HCC stamps when acking, so WRC can reject a stale ack.

// Issue #223: sha256 of the envSecret content, carried on the POD TEMPLATE (not
// the Deployment object) so that changing it changes the pod template hash and
// Kubernetes performs a rolling restart on its own. Same mechanism the per-Host
// channel-readers use in hostReconciler.ts.
const CREDENTIALS_REVISION_ANNOTATION = 'clerum.io/credentials-revision'
// Remote NGINX templates are rendered once at container start. Carrying the
// template digest on the PodTemplate makes a ConfigMap-only URL change roll the
// container instead of leaving the already-running NGINX process stale.
const NGINX_CONFIG_REVISION_ANNOTATION = 'clerum.io/nginx-config-revision'

// Codex P0 fix (PR #101): sanitization constants for remote.authHeaders.
// Only standard HTTP header token chars — letters, digits, and '-'. Rejecting
// anything else prevents smuggling headers like `X: foo\r\nAuthorization`.
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/
// Bound the value length so a pathological CRD cannot blow up the ConfigMap.
const MAX_AUTH_HEADER_VALUE_LENGTH = 2048
// Env refs envsubst resolves in an authHeader value: braced `${NAME}` or bare
// `$NAME`, exact case like envsubst. Extracted only to reject names the CRD
// does not control; the value itself is never logged.
export const AUTH_HEADER_ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
// Query placeholders are expanded by the image entrypoint after HCC has built
// the ConfigMap. Restrict them to environment-variable names; a name must also
// be declared by the CRD and survive into the proxy container (see
// buildNginxConfigMap), so an unresolved name cannot become an arbitrary NGINX
// variable. envsubst and Kubernetes env names are case-sensitive and accept
// lowercase.
const QUERY_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
// The URL parser lowercases ASCII hostnames and converts IDNs to punycode, but
// it keeps `;`, `$` and braces. The hostname is rendered unquoted into NGINX
// directives, so it must stay within the CRD schema's host character class.
const REMOTE_HOSTNAME_RE = /^[a-z0-9._-]+$/
// CRD-supplied env names that could hijack the runtime (loader, interpreter or
// cluster-access knobs). sanitizeCrdSpec strips them from spec.env.
// Exported so that the SC-1 drift test can compare this set with the operator
// script's FORBIDDEN_NAMES line; the export changes no behavior.
export const FORBIDDEN_CRD_ENV_NAMES = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'JAVA_TOOL_OPTIONS',
  'KUBECONFIG',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
])
// Read by the image's 20-envsubst-on-templates.sh. egress-proxy-entrypoint
// assigns all six before it checks and renders the templates, and HCC strips
// them from every CRD env source of a remote server, so a CRD value never
// reaches envsubst.
export const ENVSUBST_PINNED_PROXY_ENV = new Set([
  'NGINX_ENVSUBST_TEMPLATE_DIR',
  'NGINX_ENVSUBST_TEMPLATE_SUFFIX',
  'NGINX_ENVSUBST_OUTPUT_DIR',
  'NGINX_ENVSUBST_STREAM_TEMPLATE_SUFFIX',
  'NGINX_ENVSUBST_STREAM_OUTPUT_DIR',
  'NGINX_ENVSUBST_FILTER',
])
// The image's 15-local-resolvers.envsh exports NGINX_LOCAL_RESOLVERS when
// NGINX_ENTRYPOINT_LOCAL_RESOLVERS is set. It runs after the template check, so
// a placeholder naming either variable would be filled with an unchecked value.
// HCC strips both names from every CRD env source of a remote server and
// appends its own NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1: a CRD value was never
// effective (the envsh overwrites it), and a retained NGINX_LOCAL_RESOLVERS
// entry would make the template check refuse the template's own resolver
// line, the one rendered reference to the pair.
export const RESOLVER_RESERVED_PROXY_ENV = new Set([
  'NGINX_ENTRYPOINT_LOCAL_RESOLVERS',
  'NGINX_LOCAL_RESOLVERS',
])
// Every egress-proxy env name a CRD may not own: a value the image sets after
// the check (the resolver pair) or a value the image pins (the six envsubst
// knobs). A placeholder naming one of them would resolve to that value and be
// sent upstream. Exported for the SC-1 drift test, like FORBIDDEN_CRD_ENV_NAMES.
export const RESERVED_PROXY_ENV = new Set([
  ...ENVSUBST_PINNED_PROXY_ENV,
  ...RESOLVER_RESERVED_PROXY_ENV,
])
// The reserved names plus LC_ALL, which the pinned image's
// 15-local-resolvers.envsh assigns (LC_ALL=C) before envsubst runs, so a CRD
// value never reaches the template. LC_ALL lives only here, never in the
// enumerated sets above; the KUBERNETES_* family lives only in
// isPlatformOwnedTemplateName below.
const PLATFORM_OWNED_PROXY_ENV = new Set([...RESERVED_PROXY_ENV, 'LC_ALL'])

function withoutForbiddenCrdEnv<T extends { name: string }>(
  env: T[],
  onStripped: (name: string) => void = () => {}
): T[] {
  return env.filter(e => {
    if (!FORBIDDEN_CRD_ENV_NAMES.has(e.name.toUpperCase())) return true
    onStripped(e.name)
    return false
  })
}
const WRC_OWNED_RUNTIME_READY_REASON = 'WrcOwnedRuntimeRegistered'
// Keep fleet admission aligned with the external-egress convergence lane:
// enough parallelism for independent servers without allocating one pending
// effect promise per fleet member.
const DEFAULT_FULL_RECONCILE_MAX_CONCURRENCY = 10
// Status is a read/merge/write transaction shared with other controllers.
// Bound optimistic-conflict retries so a hot object cannot stall reconciliation.
const STATUS_CONDITION_WRITE_MAX_ATTEMPTS = 3
/** Types HCC no longer writes and strips from every status write (#606). A future writer must not reuse `NetworkReady`; remove the entry first. */
const RETIRED_STATUS_CONDITION_TYPES = ['NetworkReady'] as const
export const RUNTIME_NOT_DESIRED_DISABLED_MESSAGE =
  'McpServer is disabled; HCC does not run its runtime'
export const RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE =
  'Env Secret validation failed; HCC does not run its runtime'

function isRetiredStatusConditionType(type: string): boolean {
  return (RETIRED_STATUS_CONDITION_TYPES as readonly string[]).includes(type)
}

/**
 * True when NAME is a container env name the platform owns, compared exactly.
 * envsubst, Kubernetes env names and Linux all treat case as significant, so a
 * distinct-case spelling (`Path`, `kubernetes_service_host`) names a different
 * variable and is not platform-owned. An exact-case `KUBERNETES_` prefix is
 * platform-owned as a family: it is the prefix kubelet uses for injected
 * service env (`KUBERNETES_SERVICE_HOST`, `KUBERNETES_PORT_443_TCP_ADDR`,
 * ...), so no rendered template may reference such a name directly, whatever
 * declares it. The prefix lives only in this predicate, never enumerated in
 * the sets above. A name that merely contains the prefix
 * (`MY_KUBERNETES_PORT`) or spells it in a different case is ordinary here.
 *
 * The `spec.env` strip in sanitizeCrdSpec keeps its own uppercase comparison
 * against the enumerated set; callers that mirror that strip compare in
 * uppercase separately and do not go through this helper. The two rules are
 * deliberately asymmetric: a `spec.env` entry spelled `Path` is stripped by
 * the uppercase strip even though `Path` is an ordinary template name here,
 * so only an `envSecret` declaration can fill `${Path}` (otherwise the
 * backfill defines it empty); conversely a `KUBERNETES_*` name outside the
 * enumerated set survives the strip but still may not be referenced.
 */
function isPlatformOwnedTemplateName(name: string): boolean {
  return (
    name.startsWith('KUBERNETES_') ||
    FORBIDDEN_CRD_ENV_NAMES.has(name) ||
    PLATFORM_OWNED_PROXY_ENV.has(name)
  )
}

type StatusWriteDecline = 'record-obligation' | 'silent'
type StatusWriteDeclineArg = () => StatusWriteDecline
type StatusWriteOutcome = 'wrote' | 'unchanged' | 'declined'
type RuntimeWithdrawKind = 'disabled' | 'fail-closed'
type DeploymentDeleteOutcome = 'gone' | 'denied' | 'foreign'

type RetractManagedRuntimeResult = {
  retracted: boolean
  cleanupComplete: boolean
  foreignRuntime: boolean
  runtimeGone: boolean
}

function shouldStopAfterIncompleteRetract(
  retract: RetractManagedRuntimeResult,
  isCurrent: () => boolean
): boolean {
  if (retract.retracted || retract.foreignRuntime) return false
  return !(retract.runtimeGone && isCurrent())
}

function runtimeNotDesiredMessage(kind: RuntimeWithdrawKind): string {
  switch (kind) {
    case 'disabled':
      return RUNTIME_NOT_DESIRED_DISABLED_MESSAGE
    case 'fail-closed':
      return RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

async function mapSettledWithConcurrency<T, TResult>(
  items: readonly T[],
  maxConcurrency: number,
  work: (item: T, index: number) => Promise<TResult>
): Promise<Array<PromiseSettledResult<TResult>>> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError('maxConcurrency must be a positive integer')
  }

  const results = new Array<PromiseSettledResult<TResult>>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = {
          status: 'fulfilled',
          value: await work(items[index], index),
        }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.min(maxConcurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/**
 * State of the readiness poll window for one McpServer (issue #223).
 *
 * A "window" is one bounded observation of a single Deployment rollout:
 * maxAttempts ticks of intervalMs each. The window survives repeated
 * reconciles — see `readinessPolls` below for why that is load-bearing.
 */
interface ReadinessPollState {
  /**
   * Timer for the next tick; undefined while a tick is executing its awaits
   * (the handle is consumed the moment the callback fires) and once the
   * window reached a terminal verdict.
   */
  timer: ReturnType<typeof setTimeout> | undefined
  /**
   * True while a tick is executing. `timer` alone cannot distinguish "tick
   * running RIGHT NOW" from "window ended", and the difference is
   * load-bearing for pollReadiness() re-entrancy (see `recheckRequested`).
   */
  ticking: boolean
  /**
   * Set by pollReadiness() when it is called while a tick is in flight. The
   * caller (a reconcile) may have JUST rewritten the Deployment — e.g. a
   * corrected credential rotation bumping the generation — and the in-flight
   * tick's read, started earlier, cannot have seen that write. While this
   * flag is set the tick must NOT commit a terminal verdict (ready or
   * exhausted): it defers one interval so the next read, which starts after
   * that Deployment write, observes the new generation and resets the
   * window. Without this, the exhausting tick could publish RolloutIncomplete
   * with the SUPERSEDED generation's numbers and — since McpServer has no
   * periodic resync or Deployment watch — nothing would ever re-arm the poll
   * for the new rollout (issue #223).
   */
  recheckRequested: boolean
  /**
   * Deployment generation the current window is watching; null until the
   * first tick reads it. A change means a NEW rollout (e.g. another
   * credential rotation), which resets the window so the new rollout gets
   * its own full budget.
   */
  generation: number | null
  /** Ticks consumed by the current window. */
  attempts: number
  /** True once the terminal RolloutIncomplete verdict was written for `generation`. */
  exhausted: boolean
  /**
   * Rollout numbers from the exhausting tick. reconcile() re-writes them so
   * the terminal condition stays sticky instead of being downgraded to
   * WaitingForReplicas by the very reconcile the terminal write triggers.
   */
  detail: string
  /**
   * Mutation fence and CRD object of the LATEST reconcile that owns this
   * window. pollReadiness() REBINDS both on every call that finds the window
   * live: a superseding reconcile (e.g. the fullReconcile after a routine
   * McpServer watch recovery bumps the inventory-authority generation) becomes
   * the window's owner, so the next tick evaluates the CURRENT fence instead of
   * the arming reconcile's stale closure. Without the rebind the stale fence
   * self-terminates the window with no re-arm and — status-only MODIFIED events
   * being suppressed, with no periodic McpServer resync — DeploymentReady=False
   * sticks forever for a healthy rollout (the #223 rotation-timeout symptom,
   * reintroduced under a routine reconnect).
   *
   * Two ORTHOGONAL supersession guards protect this window; do not assume one
   * covers the other (that assumption is exactly how the F1 race was born):
   *   - Identity retirement: beginStatusTracking()/clearStatus() retire the
   *     window on any CRD uid or CRD-generation change (spec edit, recreate),
   *     so a surviving window always has the caller's status identity — a
   *     rebind can never adopt a recreate or a superseded desired revision.
   *   - In-tick generation reset + recheckRequested: a credential rotation
   *     bumps neither CRD uid nor CRD generation (it changes the Deployment's
   *     metadata.generation only), so identity retirement does NOT fire; the
   *     rotation is instead guarded by the tick's live Deployment read (a new
   *     generation resets attempts/exhausted) and by recheckRequested deferring
   *     a mid-flight tick's terminal verdict past the rotation's write.
   * A rebind never touches the budget fields (generation/attempts/exhausted/
   * detail) above.
   */
  isCurrent: () => boolean
  server: McpServerCRD
  /**
   * Snapshot of `readinessRetirements` at window create time (#606). A later
   * retirement increments the name's counter; the tick must not publish after
   * that, even if this state was already deleted from `readinessPolls`.
   */
  retirementEpoch: number
}

/**
 * Count env references that sit in the fixed template text, positionally.
 *
 * A reference is fixed when its offset in the rendered template falls
 * outside every dynamic span: every verbatim occurrence of the parsed
 * query (`parsedSearch`, rendered once in `proxy_pass` and once in
 * `proxy_redirect`) and the quoted value of every rendered
 * `proxy_set_header` line of a kept authHeader (located in order with a
 * cursor, so identical lines each claim their own span). Subtracting
 * per-name totals cannot express this once a placeholder renders twice.
 * Exported so the template golden test classifies references with the
 * same spans instead of a second copy of the rule.
 */
export function countFixedTemplateReferences(
  template: string,
  parsedSearch: string,
  authHeaders: ReadonlyArray<{ header: string; valueTemplate: string }>
): Map<string, number> {
  const spans: Array<readonly [number, number]> = []
  if (parsedSearch.length > 0) {
    let from = 0
    for (;;) {
      const start = template.indexOf(parsedSearch, from)
      if (start === -1) break
      spans.push([start, start + parsedSearch.length])
      from = start + parsedSearch.length
    }
  }
  let cursor = 0
  for (const authHeader of authHeaders) {
    const line = `        proxy_set_header ${authHeader.header} ` + `"${authHeader.valueTemplate}";`
    const start = template.indexOf(line, cursor)
    if (start === -1) continue
    const valueStart = start + line.indexOf('"') + 1
    spans.push([valueStart, valueStart + authHeader.valueTemplate.length])
    cursor = start + line.length
  }
  const counts = new Map<string, number>()
  const pattern = new RegExp(AUTH_HEADER_ENV_REF_RE.source, 'g')
  for (const match of template.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? ''
    if (name === '') continue
    const index = match.index ?? 0
    if (spans.some(([start, end]) => index >= start && index < end)) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export class McpServerReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly customApi: k8s.CustomObjectsApi

  /**
   * Snapshot the McpServer LIST→WATCH authority owned by McpServerWatcher.
   * The fail-closed default prevents orphan cleanup until the watcher wires
   * the real authority source.
   */
  private inventoryAuthority: () => McpServerInventoryAuthoritySnapshot = () => ({
    known: false,
    generation: 0,
  })
  private inventoryAuthorityConfigured = false
  private resolveCurrentServer?: (name: string) => McpServerCRD | undefined
  /** See McpServerReconcilerDeps: test-only opt-in to assume-current when the
   * inventory-authority fence is unwired. Production leaves it false. */
  private readonly assumeInventoryAuthorityWhenUnconfigured: boolean
  private warnedUnconfiguredAuthority = false

  /** Tracks the deployment status of each managed McpServer. */
  private readonly statusMap: Map<string, McpServerStatus> = new Map()
  private readonly statusIdentities: Map<string, Pick<McpServerCRD, 'uid' | 'generation'>> =
    new Map()

  /** G7: Tracks the initial `managed` value per McpServer to enforce immutability. */
  private readonly managedSnapshot: Map<string, boolean> = new Map()

  /**
   * Readiness poll state per server name (issue #223, E2 status-update-loop).
   *
   * Entries outlive individual reconciles ON PURPOSE. Every status write this
   * reconciler makes fires a MODIFIED watch event on the McpServer, which
   * fires another reconcile, which calls pollReadiness() again. When that
   * call cancelled and re-armed the poll (the pre-fix behavior), the attempt
   * budget restarted on every status write, so a rollout that never converges
   * NEVER exhausted its budget and the terminal RolloutIncomplete verdict was
   * never written to the CRD. This map lets pollReadiness() detect a live
   * window and leave it alone, and lets reconcile() keep an exhausted verdict
   * sticky for the same Deployment generation.
   */
  private readonly readinessPolls: Map<string, ReadinessPollState> = new Map()
  /**
   * Retirement epoch per server name (#606). Incremented when a disabled or
   * fail-closed reconcile retracts the readiness window. `clearStatus` does
   * not delete entries: a recreated name keeps the counter so stale ticks fail
   * the epoch check in addition to the uid fence.
   */
  private readonly readinessRetirements = new Map<string, number>()

  /**
   * Tail promise of the in-flight reconcile chain per server name. Serializes
   * concurrent reconcile() calls for the same McpServer so the CRD watch and
   * SecretInformer can't race to replaceNamespacedDeployment() and produce
   * spurious 409 "object has been modified" errors.
   */
  private readonly inFlight: Map<string, Promise<void>> = new Map()

  // A fulfilled reconcile promise can mean an authority guard retired work or
  // a resource API error was reported through status. Keep that distinction
  // independently of discovery readiness and the per-name promise queue.
  private readonly pendingReconciliations = new Map<string, { namespace: string }>()

  hasIncompleteReconciliation(): boolean {
    return this.pendingReconciliations.size > 0
  }

  incompleteReconciliationNames(): string[] {
    return [...this.pendingReconciliations.keys()]
  }

  hasPendingReconciliation(): boolean {
    return (
      this.hasIncompleteReconciliation() ||
      this.inFlight.size > 0 ||
      [...this.readinessPolls.values()].some(
        poll => (poll.timer !== undefined || poll.ticking) && this.readinessPollStillDesired(poll)
      )
    )
  }

  private readinessPollStillDesired(poll: ReadinessPollState): boolean {
    const current = this.resolveCurrentServer?.(poll.server.name)
    return (
      this.resolveCurrentServer === undefined ||
      (current !== undefined && sameMcpServerDesiredRevision(poll.server, current))
    )
  }

  private retainRetiredReadinessPoll(poll: ReadinessPollState): void {
    if (this.readinessPollStillDesired(poll)) {
      this.pendingReconciliations.set(poll.server.name, { namespace: poll.server.namespace })
    }
  }

  /**
   * Retract the live readiness window for a name that will no longer run a
   * runtime (#606). Increments the retirement epoch first so an in-flight tick
   * that already deleted its map entry still fails `retiredNow()`. Clears any
   * pending timer. Does not record an incomplete-publication obligation. Poll
   * ticks pass an `onDecline` factory evaluated at decline time: silent only
   * when `retiredNow()` is true, otherwise the revision fence still records
   * an obligation.
   */
  private retireReadinessWindow(name: string): void {
    this.readinessRetirements.set(name, (this.readinessRetirements.get(name) ?? 0) + 1)
    const poll = this.readinessPolls.get(name)
    if (poll === undefined) return
    if (poll.timer !== undefined) {
      clearTimeout(poll.timer)
      poll.timer = undefined
    }
    this.readinessPolls.delete(name)
  }

  constructor(kc: k8s.KubeConfig, deps?: McpServerReconcilerDeps) {
    this.appsApi = deps?.appsApi ?? kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = deps?.coreApi ?? kc.makeApiClient(k8s.CoreV1Api)
    this.customApi = deps?.customApi ?? kc.makeApiClient(k8s.CustomObjectsApi)
    this.assumeInventoryAuthorityWhenUnconfigured =
      deps?.assumeInventoryAuthorityWhenUnconfigured ?? false
  }

  /**
   * Late-bound authority source for destructive full-reconcile cleanup.
   * A full pass may finish reconciling desired servers, but it may delete an
   * orphan only while the same authoritative inventory generation remains
   * active from pass start through delete admission.
   */
  setInventoryAuthority(fn: () => McpServerInventoryAuthoritySnapshot): void {
    this.inventoryAuthority = fn
    this.inventoryAuthorityConfigured = true
  }

  /**
   * Resolve current cache membership at effect admission. Full-reconcile
   * snapshots select candidates only; they must never overwrite or delete a
   * same-name CRD accepted by the continuing watch.
   */
  setResolveCurrentServer(fn: (name: string) => McpServerCRD | undefined): void {
    this.resolveCurrentServer = fn
  }

  /**
   * Verdict for a mutation fence evaluated while the inventory authority is NOT
   * wired. Fail closed (deny) unless a test explicitly opted in; deny loudly
   * once, because an unconfigured fence in a running controller is a
   * construction bug, never a runtime condition.
   */
  private currentWhenUnconfigured(): boolean {
    if (this.assumeInventoryAuthorityWhenUnconfigured) return true
    if (!this.warnedUnconfiguredAuthority) {
      this.warnedUnconfiguredAuthority = true
      hccLogger.error(
        'inventory authority not configured — mutation fences fail closed. ' +
          'Wire setInventoryAuthority() and setResolveCurrentServer() before reconciling.',
        { scope: '[Reconciler]' }
      )
    }
    return false
  }

  // ─── Status ────────────────────────────────────────────────────────

  /**
   * Get deployment status for an McpServer.
   * Returns current in-memory status when this process has reconciled the
   * server. After a controller restart, a generation-matched persisted Ready
   * condition is the only safe fallback: a legacy condition without
   * observedGeneration, or a condition for an older spec generation, cannot
   * prove that the current desired runtime is ready.
   */
  getStatus(serverOrName: string | McpServerCRD): McpServerStatus {
    const name = typeof serverOrName === 'string' ? serverOrName : serverOrName.name
    const current = this.statusMap.get(name)
    if (current && (typeof serverOrName === 'string' || this.statusIdentityMatches(serverOrName))) {
      return typeof serverOrName === 'string' ? current : { ...current, authoritative: true }
    }

    if (typeof serverOrName !== 'string' && serverOrName.generation !== undefined) {
      const readyConditions =
        serverOrName.status?.conditions?.filter(condition => condition.type === 'Ready') ?? []
      const persistedReady =
        readyConditions.length === 1 &&
        readyConditions[0].observedGeneration === serverOrName.generation
          ? readyConditions[0]
          : undefined
      if (persistedReady) {
        const ready = persistedReady.status === 'True'
        return {
          deployed: ready,
          ready,
          message: persistedReady.message,
          authoritative: true,
        }
      }
    }

    return {
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
      authoritative: false,
    }
  }

  private statusIdentityMatches(server: McpServerCRD): boolean {
    const identity = this.statusIdentities.get(server.name)
    return (
      identity !== undefined &&
      identity.uid === server.uid &&
      identity.generation === server.generation
    )
  }

  private beginStatusTracking(server: McpServerCRD): void {
    const previousIdentity = this.statusIdentities.get(server.name)
    if (!this.statusIdentityMatches(server)) {
      this.statusMap.delete(server.name)
      // A new CRD identity (uid/generation) retires any poll window armed for
      // the previous desired revision: its verdicts would describe a rollout
      // that no longer represents the desired state. The reconcile for the
      // new identity arms its own window after its Deployment write.
      const poll = this.readinessPolls.get(server.name)
      if (poll) {
        if (poll.timer !== undefined) clearTimeout(poll.timer)
        this.readinessPolls.delete(server.name)
      }
      if (previousIdentity !== undefined && previousIdentity.uid !== server.uid) {
        this.managedSnapshot.delete(server.name)
      }
    }
    this.statusIdentities.set(server.name, {
      uid: server.uid,
      generation: server.generation,
    })
  }

  /**
   * Update the status of an McpServer after reconciliation.
   */
  private setStatus(name: string, status: McpServerStatus): void {
    this.statusMap.set(name, status)
  }

  /**
   * Remove status tracking for a deleted McpServer.
   */
  private clearStatus(name: string): void {
    this.statusMap.delete(name)
    this.statusIdentities.delete(name)
    this.managedSnapshot.delete(name)
    const poll = this.readinessPolls.get(name)
    if (poll) {
      if (poll.timer !== undefined) clearTimeout(poll.timer)
      this.readinessPolls.delete(name)
    }
  }

  /**
   * Read a Deployment's rollout state, generation-aware.
   *
   * `readyReplicas > 0` is NOT enough (issue #223): during a rolling update the
   * OLD pod is still Ready, so a new pod that never starts would be reported as
   * healthy. A rollout has actually converged only when the controller has
   * observed the current generation AND every replica is updated, ready, and
   * available.
   *
   * `totalReplicas === updatedReplicas` is the part that catches a FAILED
   * rollout of a credential rotation (issue #223, E2): with replicas=1 and the
   * default RollingUpdate (maxSurge=1, maxUnavailable=0), a new pod that
   * crash-loops on a bad credential never becomes Ready, so Kubernetes keeps
   * the OLD pod. That old pod holds readyReplicas=1 and availableReplicas=1, so
   * unavailableReplicas stays 0 and updatedReplicas reaches 1 — every other
   * signal looks converged. Only `status.replicas` (total managed pods) reveals
   * the leftover: it stays at 2 while the new pod crash-loops, and drops to 1
   * only once the rollout truly completes. Without this check the poll would
   * report a failed rotation as healthy and never write RolloutIncomplete.
   *
   * `detail` carries the numbers into status conditions so a stuck rollout says
   * what is stuck instead of just "not ready".
   *
   * `generation` is the Deployment's `metadata.generation`, exposed so the
   * readiness poll can tell "same rollout, keep counting" apart from "NEW
   * rollout, fresh window" (issue #223, E2). It plays no part in the
   * readiness verdict above. null when the Deployment could not be read.
   */
  private async readDeploymentRollout(
    name: string,
    namespace: string
  ): Promise<{ ready: boolean; detail: string; generation: number | null }> {
    try {
      const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace })
      const desired = deployment.spec?.replicas ?? 1
      const generation = deployment.metadata?.generation ?? 0
      const observedGeneration = deployment.status?.observedGeneration ?? 0
      const updatedReplicas = deployment.status?.updatedReplicas ?? 0
      const readyReplicas = deployment.status?.readyReplicas ?? 0
      const totalReplicas = deployment.status?.replicas ?? 0
      const unavailableReplicas = deployment.status?.unavailableReplicas ?? 0

      const ready =
        observedGeneration >= generation &&
        updatedReplicas === desired &&
        readyReplicas === desired &&
        totalReplicas === updatedReplicas &&
        unavailableReplicas === 0

      return {
        ready,
        generation,
        detail:
          `generation ${observedGeneration}/${generation}, ` +
          `updated ${updatedReplicas}/${desired}, ready ${readyReplicas}/${desired}, ` +
          `total ${totalReplicas}, unavailable ${unavailableReplicas}`,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { ready: false, generation: null, detail: `Deployment read failed: ${message}` }
    }
  }

  /**
   * Poll deployment readiness until ready or maxAttempts reached.
   *
   * Re-entrancy is the whole point (issue #223, E2 status-update-loop):
   * reconcile() runs after every MODIFIED watch event — including the events
   * caused by our OWN status writes — and calls this on every pass where the
   * Deployment is not ready yet. A live window is therefore NEVER cancelled
   * or re-armed here; it keeps counting toward its budget so a rollout that
   * never converges reaches the terminal RolloutIncomplete verdict after
   * maxAttempts × intervalMs. A NEW rollout (bumped Deployment generation,
   * e.g. another credential rotation) is detected inside the poll tick
   * itself, which resets the window so the new rollout gets its own budget.
   *
   * A call that lands while a tick is EXECUTING (mid-await) is not silently
   * dropped either: it flags `recheckRequested` so the tick defers any
   * terminal verdict until a read taken AFTER the caller's Deployment write
   * confirms the generation — otherwise the exhausting tick could seal the
   * window with a superseded generation's numbers and the new rollout would
   * never be observed (see ReadinessPollState.recheckRequested).
   */
  private pollReadiness(
    server: McpServerCRD,
    intervalMs = 5000,
    maxAttempts = 24,
    isCurrent: () => boolean = () => true
  ): void {
    const { name, namespace } = server

    const previous = this.readinessPolls.get(name)
    if (previous !== undefined && (previous.timer !== undefined || previous.ticking)) {
      // A window is already running for this server — leave its TIMER and
      // BUDGET alone (re-arming would reset the attempt budget: the E2
      // status-update-loop). But this caller is now the window's owner: rebind
      // the mutation fence (and the same-identity server object) so the next
      // tick evaluates the CURRENT fence instead of the arming reconcile's
      // stale closure, which would otherwise self-terminate the window with no
      // re-arm after a routine watch-generation bump.
      previous.isCurrent = isCurrent
      previous.server = server
      // If its tick is executing RIGHT NOW, the tick's Deployment read may
      // predate the Deployment write that triggered THIS call (a new
      // generation), so a silent no-op could let the tick end the window on
      // stale data. Record that a re-check is owed; the tick honors it before
      // committing any terminal verdict.
      if (previous.ticking) {
        previous.recheckRequested = true
      }
      return
    }

    // Fresh window. Carry over the generation and terminal verdict of a
    // previous exhausted window: if the Deployment has NOT changed since,
    // the new window must not mistake it for a new rollout, and reconcile()
    // keeps reporting the sticky RolloutIncomplete meanwhile.
    const state: ReadinessPollState = {
      timer: undefined,
      ticking: false,
      recheckRequested: false,
      generation: previous?.generation ?? null,
      attempts: 0,
      exhausted: previous?.exhausted ?? false,
      detail: previous?.detail ?? '',
      isCurrent,
      server,
      retirementEpoch: this.readinessRetirements.get(name) ?? 0,
    }
    this.readinessPolls.set(name, state)

    const poll = async (): Promise<void> => {
      // The timer handle was consumed the moment this callback fired; reflect
      // that, and mark the tick as in flight so a concurrent pollReadiness()
      // can tell "tick running" apart from "window ended" during our awaits.
      state.timer = undefined
      state.ticking = true
      const retiredNow = (): boolean =>
        (this.readinessRetirements.get(name) ?? 0) !== state.retirementEpoch
      const publishIfCurrent = (): boolean => state.isCurrent() && !retiredNow()
      const pollWriteDecline = (): StatusWriteDecline =>
        retiredNow() ? 'silent' : 'record-obligation'
      // Mutation fencing: a superseded reconcile (desired-revision or
      // inventory-authority change) must not keep observing — or writing
      // status — on behalf of a stale desired state. End the window quietly;
      // the current reconcile arms its own window after its Deployment write.
      if (!state.isCurrent()) {
        this.retainRetiredReadinessPoll(state)
        state.ticking = false
        if (this.readinessPolls.get(name) === state) this.readinessPolls.delete(name)
        return
      }
      const rollout = await this.readDeploymentRollout(name, namespace)
      if (!state.isCurrent() || !this.statusIdentityMatches(state.server)) {
        this.retainRetiredReadinessPoll(state)
        state.ticking = false
        if (this.readinessPolls.get(name) === state) this.readinessPolls.delete(name)
        return
      }

      // The McpServer may have been deleted (clearStatus) while we were
      // reading. A cancelled window must not keep ticking or write status
      // for a CRD that is gone.
      if (this.readinessPolls.get(name) !== state) return

      // Generation change ⇒ a NEW rollout: it deserves its own full budget,
      // and any terminal verdict for the old generation no longer applies.
      // A failed read (generation null) never resets the window — otherwise
      // a flapping API server would grant infinite budget.
      if (rollout.generation !== null && rollout.generation !== state.generation) {
        state.generation = rollout.generation
        state.attempts = 0
        state.exhausted = false
        state.detail = ''
      }
      state.attempts++

      // A pollReadiness() call landed while this tick was mid-await: the
      // Deployment may have been rewritten AFTER our read (that reconcile
      // writes the Deployment BEFORE calling pollReadiness()), so a terminal
      // verdict from this tick's data could blame a superseded generation —
      // and nothing else would ever re-arm the poll for the new one. Defer
      // the verdict one interval: the next read starts after that Deployment
      // write, so it MUST observe the new generation and reset the window
      // above. A same-generation echo merely delays the verdict by one tick;
      // the budget is NOT reset, so the E2 status-update-loop stays fixed.
      if (state.recheckRequested) {
        state.recheckRequested = false
        if (rollout.ready || state.attempts >= maxAttempts) {
          state.ticking = false
          state.timer = setTimeout(poll, intervalMs)
          return
        }
      }

      if (rollout.ready) {
        state.ticking = false
        this.setStatus(name, { deployed: true, ready: true, message: 'Running' })
        this.readinessPolls.delete(name)
        hccLogger.info('McpServer is now ready after poll(s)', {
          scope: '[Reconciler]',
          name,
          attempts: state.attempts,
        })
        // The poll MUST write the CRD, not just in-memory status (issue #223).
        // With generation-aware readiness the check right after a replace is
        // always false, so this is the ONLY place a converged rollout is ever
        // recorded — without it every successful credential rotation would sit
        // at DeploymentReady=False forever and the UI would report a timeout.
        if (retiredNow()) return
        await this.updateStatusConditions(
          state.server,
          true,
          undefined,
          publishIfCurrent,
          pollWriteDecline
        )
        // Readiness is decoupled from fleet convergence: the poll also
        // upgrades the persisted, generation-matched Ready condition so a
        // controller restart can trust the recorded readiness (see getStatus).
        if (retiredNow()) return
        await this.writeStatusCondition(
          state.server,
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconcileSuccess',
            message: 'Deployment created',
          },
          publishIfCurrent,
          pollWriteDecline
        )
        return
      }

      if (state.attempts >= maxAttempts) {
        // Terminal verdict for THIS generation. The entry stays in the map
        // (timer undefined since tick start, ticking cleared here — BEFORE
        // the status write below, so a reconcile arriving during that await
        // opens a fresh observation window instead of flagging a re-check
        // this dying tick would never honor) so reconcile() keeps the verdict
        // sticky and a later pollReadiness() call may re-observe.
        state.ticking = false
        state.exhausted = true
        state.detail = rollout.detail
        hccLogger.warn('McpServer not ready after polls — giving up', {
          scope: '[Reconciler]',
          name,
          maxAttempts,
          detail: rollout.detail,
        })
        // Give up loudly, on the CRD: a stuck rollout must be visible to the
        // operator with the numbers that prove it, never left as a stale
        // condition or a silent Unknown.
        if (retiredNow()) return
        await this.updateStatusConditions(
          state.server,
          false,
          rollout.detail,
          publishIfCurrent,
          pollWriteDecline
        )
        return
      }

      // Schedule next poll
      state.ticking = false
      state.timer = setTimeout(poll, intervalMs)
    }

    state.timer = setTimeout(poll, intervalMs)
  }

  // ─── Secret Validation ──────────────────────────────────────────────

  /**
   * Validate that the referenced secret exists and contains all required keys.
   * Returns a discriminated result describing success or the exact failure mode.
   */
  async validateSecret(server: McpServerCRD): Promise<SecretValidationResult> {
    // No envSecret: nothing to hash, and no credentials annotation is written.
    if (!server.spec.envSecret) return { ok: true, revision: '', secretData: {} }

    const secretName = server.spec.envSecret.name

    try {
      const secret = await this.coreApi.readNamespacedSecret({
        name: secretName,
        namespace: server.namespace,
      })

      const data = secret.data || {}
      const revision = createHash('sha256')
        .update(canonicalStringify(data as Record<string, unknown>))
        .digest('hex')

      for (const keyMapping of server.spec.envSecret.keys) {
        if (!(keyMapping.secretKey in data)) {
          const message =
            `Secret "${secretName}" is missing required key "${keyMapping.secretKey}" ` +
            `(needed for env var ${keyMapping.envVar})`
          hccLogger.error('Secret is missing required key (needed for env var) in McpServer', {
            scope: '[Reconciler]',
            resourceName: secretName,
            entryName: keyMapping.secretKey,
            envVar: keyMapping.envVar,
            name: server.name,
          })
          return { ok: false, reason: 'SecretMissingKey', message }
        }
      }

      hccLogger.info('Secret validated for McpServer', {
        scope: '[Reconciler]',
        resourceName: secretName,
        name: server.name,
      })
      return { ok: true, revision, secretData: data as Record<string, string> }
    } catch (error: unknown) {
      const code = getErrorCode(error)
      if (code === 404) {
        const message = `Secret "${secretName}" not found in namespace "${server.namespace}"`
        hccLogger.error(
          'Secret not found in namespace. McpServer will NOT be deployed. Create the secret first.',
          {
            scope: '[Reconciler]',
            resourceName: secretName,
            namespace: server.namespace,
            name: server.name,
          }
        )
        return { ok: false, reason: 'SecretNotFound', message }
      }
      if (code === 401 || code === 403) {
        const message =
          `Access denied reading Secret "${secretName}" in namespace "${server.namespace}" ` +
          `(K8s API ${code})`
        hccLogger.error(
          'Access denied reading Secret in namespace (K8s API). McpServer will be failed closed.',
          {
            scope: '[Reconciler]',
            resourceName: secretName,
            namespace: server.namespace,
            code,
            name: server.name,
          }
        )
        return { ok: false, reason: 'SecretAccessDenied', message }
      }
      const errMsg = error instanceof Error ? error.message : String(error)
      hccLogger.error('Failed to read secret', {
        scope: '[Reconciler]',
        resourceName: secretName,
        err: error,
      })
      return {
        ok: false,
        reason: 'ReadError',
        message: `Failed to read Secret "${secretName}": ${errMsg}`,
      }
    }
  }

  // ─── Resource Builders ──────────────────────────────────────────────

  // ─── Remote Egress Proxy ─────────────────────────────────────────

  /**
   * Check if this McpServer is a remote egress proxy (has spec.remote.baseUrl).
   */
  private isRemote(server: McpServerCRD): boolean {
    return !!server.spec.remote?.baseUrl
  }

  /**
   * Build nginx.conf ConfigMap for a remote MCP egress proxy.
   * Generates an nginx reverse proxy config that forwards to the external baseUrl.
   */
  /**
   * Validate and sanitize remote baseUrl to prevent SSRF and nginx.conf injection.
   * Returns safe URL reconstructed from parsed components.
   */
  private sanitizeRemoteUrl(rawUrl: string): {
    safeUrl: string
    host: string
    hostname: string
    port: string
    path: string
    search: string
  } {
    const parsed = new URL(rawUrl) // throws on malformed — no silent fallback
    if (parsed.protocol !== 'https:') {
      throw new Error(`remote.baseUrl must use HTTPS (got ${parsed.protocol})`)
    }
    // A trailing dot is the DNS root form of the same name: `svc.cluster.local.`
    // resolves exactly like `svc.cluster.local`. Every check below compares
    // strings (`endsWith`, `===`, the private-range prefix test), so the dotted
    // form would otherwise slip past the internal-service and private-range
    // guards. Canonicalize before any check, and write the canonical name back
    // into the parsed URL so `host`, `origin`, `safeUrl` and the rendered
    // `server` / `proxy_ssl_name` / Host header all use it.
    const parsedHostname = parsed.hostname
    const hostWithoutTrailingDots = parsedHostname.replace(/\.+$/, '')
    if (hostWithoutTrailingDots !== parsedHostname && hostWithoutTrailingDots !== '') {
      parsed.hostname = hostWithoutTrailingDots
    }
    // The WHATWG hostname setter re-parses its input: writing a numeric IPv4
    // spelling such as `0x7f.0.0.1` back into the URL can yield `127.0.0.1`.
    // Re-read the hostname after canonicalization so every check and every
    // rendered component use the same final value; the pre-setter string could
    // validate one host while the URL renders another.
    const host = parsed.hostname
    if (host === '') {
      throw new Error('remote.baseUrl must include a hostname')
    }
    // The setter is ignored when the dot-stripped name has a numeric last label
    // that is not a valid IPv4 address (`foo.0x10`, `example.123`): the re-read
    // hostname then still ends in a dot and would render a `server` name NGINX
    // cannot resolve (a 502 at runtime, not a bypass — this class cannot spell
    // `.svc`, `.local` or `kubernetes.default`). Reject it rather than render
    // it. Comparing against the stripped string instead would also fire on the
    // legitimate canonicalization (`0x7f.0.0.1..` reads back as `127.0.0.1`),
    // so the guard is the surviving dot itself. The error does not echo the
    // hostname.
    if (host.endsWith('.')) {
      throw new Error('remote.baseUrl hostname must not end with a trailing dot')
    }
    // Block IP-literal URLs entirely (IPv4 and IPv6) — require DNS hostnames only
    // This prevents IPv6 SSRF bypasses (::1, ::ffff:7f00:1, fd00::, etc.)
    const bareHost = host.replace(/^\[|\]$/g, '')
    if (/^[\d.:[\]]+$/.test(bareHost) || bareHost.includes(':')) {
      throw new Error(`remote.baseUrl must use a DNS hostname, not an IP address: ${host}`)
    }
    // The hostname is rendered unquoted in `server`, `proxy_ssl_name`,
    // `proxy_redirect` and the Host header, where `;` ends the directive and
    // `$name` is an NGINX variable. The CRD schema already limits it to
    // [a-zA-Z0-9._-]; repeat that here so the renderer does not depend on
    // admission. The error does not echo the hostname.
    if (!REMOTE_HOSTNAME_RE.test(host)) {
      throw new Error(
        'remote.baseUrl hostname contains a forbidden character (allowed: a-z, 0-9, ".", "-", "_")'
      )
    }
    // Block internal cluster services (SSRF prevention)
    if (
      host.endsWith('.svc.cluster.local') ||
      host.endsWith('.svc') ||
      host === 'kubernetes.default'
    ) {
      throw new Error(`remote.baseUrl must not point to internal cluster services: ${host}`)
    }
    // Block RFC1918, link-local, loopback (defense in depth for edge cases)
    const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.)/
    if (PRIVATE_IP.test(host)) {
      throw new Error(`remote.baseUrl must not point to private/reserved IP ranges: ${host}`)
    }
    // Defense in depth for the generated NGINX directive: the query is rendered
    // unquoted in `proxy_pass`/`proxy_redirect`, so only complete placeholders
    // with environment-variable names may remain dynamic. The URL parser strips TAB/CR/LF and
    // percent-encodes spaces and other control characters, so in practice this
    // rejects `$`, braces, `\` and `;` outside a complete placeholder; undeclared
    // names are rejected below. The error does not echo the query.
    const queryWithoutPlaceholders = parsed.search.replace(QUERY_PLACEHOLDER_RE, '')
    if (/[\\;{}$\u0000-\u0020]/.test(queryWithoutPlaceholders)) {
      throw new Error(
        'remote.baseUrl query contains an invalid placeholder or forbidden character; ' +
          'query placeholders must use ${NAME} with NAME matching [A-Za-z_][A-Za-z0-9_]*'
      )
    }
    // The path is rendered unquoted in `location`, `proxy_pass` and
    // `proxy_redirect`, where NGINX expands `$name` as a variable and a `;`
    // ends the directive. The URL parser percent-encodes spaces and braces in
    // the path and turns `\` into `/`, so in practice this rejects `$` and `;`;
    // the rest of the class matches the query check. The error does not echo
    // the path.
    if (/[\\;{}$\u0000-\u0020]/.test(parsed.pathname)) {
      throw new Error(
        'remote.baseUrl path contains a forbidden character ($, ;, \\, braces or whitespace)'
      )
    }
    // Reconstruct safe URL from parsed components (strips injected chars like newlines)
    const path = parsed.pathname
    const safeUrl = parsed.origin + path + parsed.search
    return {
      safeUrl,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port || '443',
      path,
      search: parsed.search,
    }
  }

  /**
   * Codex P0 fix (PR #101): sanitize + validate authHeaders from the McpServer CRD
   * before emitting them as nginx `proxy_set_header` lines. Prevents nginx config
   * injection (breakouts from the quoted string) and HTTP header smuggling.
   *
   * Returns a safe { header, valueTemplate } tuple with the valueTemplate already
   * escaped for nginx double-quoted string context, or null if the entry is
   * rejected (a warning is emitted describing why).
   */
  private sanitizeAuthHeader(h: {
    header: string
    valueTemplate: string
  }): { header: string; valueTemplate: string } | null {
    // Validate header name — HTTP token chars only (RFC 7230 subset we allow).
    if (!HEADER_NAME_RE.test(h.header)) {
      hccLogger.warn('Rejecting authHeader with invalid name', {
        scope: '[HCC]',
        header: h.header.slice(0, 32),
      })
      return null
    }
    // Bound the value length so a pathological CRD cannot blow up the ConfigMap.
    if (h.valueTemplate.length > MAX_AUTH_HEADER_VALUE_LENGTH) {
      hccLogger.warn('Rejecting authHeader value too long for header', {
        scope: '[HCC]',
        header: h.header,
      })
      return null
    }
    // CR/LF/NUL allow HTTP request smuggling and nginx directive injection.
    if (/[\r\n\0]/.test(h.valueTemplate)) {
      hccLogger.warn('Rejecting authHeader with CR/LF/NUL in value for header', {
        scope: '[HCC]',
        header: h.header,
      })
      return null
    }
    // A valueTemplate must not read a variable the platform owns.
    // `${NAME}` is resolved by envsubst from the proxy container's own
    // environment and bare `$NAME` is read by NGINX as its own variable, so
    // either form would send the container's PATH or a platform resolver value
    // upstream instead of the operator's Secret. Warn with the header and the
    // placeholder name only: the template value may be the credential.
    for (const match of h.valueTemplate.matchAll(AUTH_HEADER_ENV_REF_RE)) {
      const name = match[1] ?? match[2]
      if (isPlatformOwnedTemplateName(name)) {
        hccLogger.warn('Rejecting authHeader that references a platform-owned variable', {
          scope: '[HCC]',
          header: h.header,
          envVar: name,
        })
        return null
      }
    }
    // Escape backslashes (first, to avoid double-escaping) then double quotes so
    // the value is safe inside nginx's `"..."` string context.
    const escaped = h.valueTemplate.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return { header: h.header, valueTemplate: escaped }
  }

  /**
   * Render the nginx template of a remote server once per reconcile.
   *
   * Returns the ConfigMap that goes to the API server plus the two reference
   * positions of the contract: the parsed query (`parsed.search`, where every
   * `${NAME}` is a query-position placeholder) and the authHeaders that
   * `sanitizeAuthHeader` kept (every `$NAME`/`${NAME}` there is a quoted
   * position). The egress-proxy preflight derives its reference positions from
   * this render, never from a second parser.
   */
  private renderNginxTemplate(server: McpServerCRD): {
    configMap: k8s.V1ConfigMap
    parsedSearch: string
    authHeaders: Array<{ header: string; valueTemplate: string }>
  } {
    const {
      host: upstreamHost,
      hostname: upstreamHostname,
      port: upstreamPort,
      path: upstreamPath,
      search: upstreamSearch,
    } = this.sanitizeRemoteUrl(server.spec.remote!.baseUrl)
    // A declared query placeholder is the only dynamic name envsubst can fill.
    // An undeclared name survives into the rendered config, where NGINX resolves
    // it case-insensitively as one of its own variables (for example
    // ${HTTP_AUTHORIZATION}); reject it here, with an error that never echoes the
    // query. The comparison is exact and case-sensitive, like envsubst's.
    // Declared means present in the env this reconcile gives the egress-proxy
    // container: envMapping, spec.env after the forbidden names are stripped,
    // spec.envSecret and the authHeaders backfill. The KUBERNETES_* family,
    // forbidden names and reserved egress-proxy names are rejected before the
    // declared check: only spec.env is stripped of forbidden names, so such a
    // name declared through another channel would otherwise pass as declared
    // and envsubst would send a runtime value the CRD must never own (a
    // loader, interpreter or cluster-access knob, a kubelet-injected service
    // address) upstream as a query value. Exact-case, like the authHeader
    // guard.
    const declaredEnvNames = this.egressProxyEnvNames(server)
    for (const match of upstreamSearch.matchAll(QUERY_PLACEHOLDER_RE)) {
      // An exact-case KUBERNETES_* name is rejected outright, however it was
      // declared: whether an explicit entry shadows a kubelet-injected value
      // must not decide what envsubst sends upstream. The error names the
      // placeholder only; it never echoes the query.
      if (match[1].startsWith('KUBERNETES_')) {
        throw new Error(
          `remote.baseUrl query placeholder \${${match[1]}} names a reserved Kubernetes service variable`
        )
      }
      if (FORBIDDEN_CRD_ENV_NAMES.has(match[1])) {
        throw new Error(
          `remote.baseUrl query placeholder \${${match[1]}} names a forbidden env var; ` +
            'use another name'
        )
      }
      if (PLATFORM_OWNED_PROXY_ENV.has(match[1])) {
        throw new Error(
          `remote.baseUrl query placeholder \${${match[1]}} names a reserved egress-proxy env var; ` +
            'use another name'
        )
      }
      if (!declaredEnvNames.has(match[1])) {
        throw new Error(
          `remote.baseUrl query placeholder \${${match[1]}} is not declared in the ` +
            'egress-proxy container env, or its env entry was stripped as forbidden'
        )
      }
    }
    const transportPort = server.spec.transport.port || 3000

    // Codex P1 fix (PR #101): forward credential secrets as upstream auth headers.
    // Each authHeader produces a `proxy_set_header` line; ${VAR} placeholders in
    // valueTemplate are resolved at pod startup by Clerum's nginx egress proxy
    // /etc/nginx/templates/ envsubst (env vars from envSecret are already mounted
    // into the egress-proxy container by buildDeployment).
    //
    // Codex P0 fix (PR #101): each entry is sanitized + validated via
    // sanitizeAuthHeader() before emission so an operator-authored CRD cannot
    // break out of the quoted string to inject arbitrary nginx config, and
    // cannot smuggle HTTP headers via CR/LF.
    const sanitizedAuthHeaders = (server.spec.remote!.authHeaders ?? [])
      .map(h => this.sanitizeAuthHeader(h))
      .filter((h): h is { header: string; valueTemplate: string } => h !== null)
    const authHeaderLines = sanitizedAuthHeaders
      .map(h => `        proxy_set_header ${h.header} "${h.valueTemplate}";`)
      .join('\n')

    // ── D-2 Authorization precedence/clearing ──
    // Exactly one Authorization directive is emitted, by precedence, because the
    // security decision here is non-obvious:
    //   oauth (and no static Authorization) → passthrough the per-user Bearer that
    //                                          mcp-host injects ($http_authorization);
    //   authHeaders declares Authorization  → emit nothing here — the operator's
    //                                          static credential (already rendered by
    //                                          authHeaderLines) wins;
    //   otherwise (static remote)           → clear it ("") so a static remote never
    //                                          forwards an incoming Authorization by accident.
    // An oauth server that also statically pins Authorization is a contradiction:
    // the static value would shadow the per-user Bearer. Reject the reconcile.
    //
    // Two different detections on purpose:
    //   - CONFLICT (oauth) is keyed on the RAW authHeaders: an oauth server must not
    //     declare Authorization at all, even a malformed value that sanitization would
    //     drop — otherwise the reject could be bypassed by injecting a bad value.
    //   - The clear-vs-operator-wins decision is keyed on the SANITIZED/EMITTED set:
    //     if the operator's Authorization entry was dropped by sanitizeAuthHeader (bad
    //     name/length/CR-LF-NUL/platform-owned reference), no static line is
    //     rendered, so we must still CLEAR — keying this on the raw list would leave
    //     the incoming Authorization forwarded.
    const isOAuth = server.spec.auth?.type === 'oauth'
    const rawDeclaresAuthorizationHeader = (server.spec.remote!.authHeaders ?? []).some(
      h => h.header.toLowerCase() === 'authorization'
    )
    const emitsAuthorizationHeader = sanitizedAuthHeaders.some(
      h => h.header.toLowerCase() === 'authorization'
    )
    if (isOAuth && rawDeclaresAuthorizationHeader) {
      hccLogger.error(
        'Rejecting remote reconcile: oauth server pins a static Authorization header',
        {
          scope: '[Reconciler]',
          mcpServer: server.name,
          namespace: server.namespace,
        }
      )
      throw new Error(
        `remote MCP server "${server.name}" uses auth.type 'oauth' but also declares a static ` +
          'Authorization header in spec.remote.authHeaders; the per-user Bearer must pass through — ' +
          'remove the Authorization entry'
      )
    }
    const authorizationDirective = isOAuth
      ? '        proxy_set_header Authorization $http_authorization;'
      : emitsAuthorizationHeader
        ? ''
        : '        proxy_set_header Authorization "";'
    const authorizationBlock = authorizationDirective
      ? `\n        # ── Authorization precedence (D-2): ${
          isOAuth
            ? 'passthrough the per-user Bearer'
            : 'clear — a static remote never forwards Authorization'
        } ──\n${authorizationDirective}\n`
      : ''

    const nginxConf = `# Auto-generated by Clerum HCC for remote MCP server: ${server.name}
# Stored as .conf.template; Clerum's nginx egress proxy runs envsubst at startup.
# The resolver name is deliberately bare (unbraced): the image exports
# NGINX_LOCAL_RESOLVERS from 15-local-resolvers.envsh, and envsubst substitutes
# the bare form with the same value.
resolver $NGINX_LOCAL_RESOLVERS ipv6=off;
upstream remote_upstream {
    zone remote_upstream 64k;
    server ${upstreamHostname}:${upstreamPort} resolve;
}

server {
    listen ${transportPort};

    # Mirror the upstream endpoint path locally so nginx URI replacement keeps
    # the remote endpoint path exactly once.
    location ${upstreamPath} {
        proxy_pass https://remote_upstream${upstreamPath}${upstreamSearch};
        proxy_redirect https://${upstreamHost}${upstreamPath}${upstreamSearch} ${upstreamPath};
        proxy_set_header Host ${upstreamHost};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
${authHeaderLines ? '\n        # ── Credential auth headers (envsubst-resolved) ──\n' + authHeaderLines + '\n' : ''}${authorizationBlock}
        # An upstream must not drive internal redirects or charset overrides:
        # NGINX logs the X-Accel-Redirect target and the X-Accel-Charset value
        # it received, outside the messages egress-proxy-log-filter redacts.
        proxy_ignore_headers X-Accel-Redirect X-Accel-Charset;

        # SSE/streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding on;

        # TLS to upstream
        proxy_ssl_verify on;
        proxy_ssl_server_name on;
        proxy_ssl_name ${upstreamHostname};
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        # nginx defaults proxy_ssl_verify_depth to 1, which only admits a chain
        # with a single untrusted intermediate. CAs mid-root-rollover serve a
        # chain that reaches a trusted anchor through a cross-signed root, so the
        # leaf sits two intermediates below the trust store: Let's Encrypt via
        # "Root YE"/"Root YR" (cross-signed by ISRG Root X2/X1) and Microsoft via
        # "Microsoft TLS ECC Root G2" (cross-signed by MS ECC Root 2017). At depth
        # 1 nginx rejects those with "(20:unable to get local issuer certificate)"
        # even though the CA bundle is complete — it looks like a missing root but
        # is purely the depth cap. Raising the depth keeps verification fully on.
        proxy_ssl_verify_depth 3;
    }

    # Health check endpoint
    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}`

    const labels: Record<string, string> = {
      app: server.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [MCPSERVER_LABEL]: server.name,
      'clerum.io/component': 'egress-proxy',
    }

    return {
      configMap: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: `${server.name}-nginx-conf`,
          namespace: server.namespace,
          labels,
          ...(server.uid && {
            ownerReferences: [
              {
                apiVersion: 'clerum.io/v1alpha1',
                kind: 'McpServer',
                name: server.name,
                uid: server.uid,
                controller: true,
                blockOwnerDeletion: true,
              },
            ],
          }),
        },
        data: {
          // Stored as .conf.template so Clerum's nginx egress proxy runs envsubst at
          // startup, resolving ${VAR} placeholders from env (sourced from envSecret).
          'default.conf.template': nginxConf,
        },
      },
      parsedSearch: upstreamSearch,
      authHeaders: sanitizedAuthHeaders,
    }
  }

  /** ConfigMap of a remote server; thin wrapper over renderNginxTemplate. */
  private buildNginxConfigMap(server: McpServerCRD): k8s.V1ConfigMap {
    return this.renderNginxTemplate(server).configMap
  }

  /**
   * Egress-proxy value preflight: every value the rendered
   * template substitutes must be within the class of the NGINX context it lands
   * in. It blocks instead of warning because a write would replace the
   * Deployment, the new pod would refuse to start on the same value, mcp-host
   * would disconnect the server and the rollout would never converge.
   *
   * The positions come from the same render that goes to the ConfigMap: a
   * `${NAME}` in `parsed.search` is query position, a `$NAME`/`${NAME}` in an
   * authHeader that sanitizeAuthHeader kept is quoted position, and a reference
   * whose offset falls outside both dynamic spans sits in the fixed template
   * text (an argument start, where the image refuses any value); see
   * countFixedTemplateReferences. Values are bytes: a Secret key is base64 in the snapshot and a
   * CRD literal is UTF-8, the bytes the kubelet puts in the container env.
   *
   * Never logs or returns a value byte.
   */
  private checkEgressProxyValues(
    server: McpServerCRD,
    rendered: {
      configMap: k8s.V1ConfigMap
      parsedSearch: string
      authHeaders: Array<{ header: string; valueTemplate: string }>
    },
    secretData: Record<string, string>
  ): EgressProxyValueVerdict {
    const template = rendered.configMap.data?.['default.conf.template'] ?? ''
    // Kubernetes keeps the last entry of a duplicated env name.
    const effective = new Map<string, k8s.V1EnvVar>()
    for (const entry of this.buildContainerEnv(server)) effective.set(entry.name, entry)

    const countOccurrences = (text: string, pattern: RegExp): Map<string, number> => {
      const counts = new Map<string, number>()
      for (const match of text.matchAll(pattern)) {
        const name = match[1] ?? match[2] ?? ''
        if (name === '') continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      return counts
    }

    const queryOccurrences = countOccurrences(rendered.parsedSearch, QUERY_PLACEHOLDER_RE)
    const fixedReferenceCounts = countFixedTemplateReferences(
      template,
      rendered.parsedSearch,
      rendered.authHeaders
    )

    // Every (header, name) pair the kept headers reference, so a rejection
    // names the header that would lose its value.
    const headerPairs: Array<{ header: string; name: string }> = []
    const seenHeaderPairs = new Set<string>()
    for (const header of rendered.authHeaders) {
      for (const match of header.valueTemplate.matchAll(AUTH_HEADER_ENV_REF_RE)) {
        const name = match[1] ?? match[2] ?? ''
        if (name === '') continue
        const pair = `${header.header}\u0000${name}`
        if (seenHeaderPairs.has(pair)) continue
        seenHeaderPairs.add(pair)
        headerPairs.push({ header: header.header, name })
      }
    }

    const violations: EgressProxyValueViolation[] = []
    for (const [name, entry] of effective) {
      const source = this.describeEnvSource(entry)
      const fixedOccurrences = fixedReferenceCounts.get(name) ?? 0
      if (fixedOccurrences > 0) {
        violations.push({ context: 'collision', kind: 'class', placeholder: name, source })
        continue
      }
      if (
        queryOccurrences.has(name) &&
        !isQueryValueAllowed(this.effectiveEnvBytes(entry, secretData))
      ) {
        violations.push({
          context: 'query',
          kind: this.isDependentEnvLiteral(entry) ? 'dependent-env' : 'class',
          placeholder: name,
          source,
        })
      }
      for (const pair of headerPairs) {
        if (pair.name !== name) continue
        if (isQuotedValueAllowed(this.effectiveEnvBytes(entry, secretData))) continue
        violations.push({
          context: 'quoted',
          kind: this.isDependentEnvLiteral(entry) ? 'dependent-env' : 'class',
          placeholder: name,
          source,
          header: pair.header,
        })
      }
    }

    if (violations.length === 0) return { ok: true }
    return { ok: false, violations, message: this.formatEgressProxyValueMessage(violations) }
  }

  /** Human-readable source of an env entry: names only, never the value. */
  private describeEnvSource(entry: k8s.V1EnvVar): string {
    const secretKeyRef = entry.valueFrom?.secretKeyRef
    if (secretKeyRef) return `Secret "${secretKeyRef.name}" key "${secretKeyRef.key}"`
    return 'literal value from spec.env or spec.envMapping'
  }

  /** The bytes the kubelet places in the container env for this entry. */
  private effectiveEnvBytes(entry: k8s.V1EnvVar, secretData: Record<string, string>): Uint8Array {
    const secretKeyRef = entry.valueFrom?.secretKeyRef
    if (!secretKeyRef) return Buffer.from(entry.value ?? '', 'utf8')
    const encoded = secretData[secretKeyRef.key]
    if (encoded === undefined) {
      // validateSecret already proved that every envSecret key exists; a missing
      // key here means the snapshot and the env list disagree. Fail loud instead
      // of classifying an empty value as valid.
      throw new Error(
        `egress-proxy preflight: Secret "${secretKeyRef.name}" snapshot has no key ` +
          `"${secretKeyRef.key}"`
      )
    }
    return Buffer.from(encoded, 'base64')
  }

  /**
   * A referenced literal that holds `$(NAME)`: Kubernetes expands dependent
   * environment references at container start, and HCC judges the literal as
   * written, so the value is refused for its `$`. That refusal is by design:
   * HCC never expands the reference itself, so the operator must store the
   * final value instead.
   */
  private isDependentEnvLiteral(entry: k8s.V1EnvVar): boolean {
    return entry.valueFrom === undefined && (entry.value ?? '').includes('$(')
  }

  private formatEgressProxyValueMessage(violations: EgressProxyValueViolation[]): string {
    const compare = (left: string, right: string): number =>
      left < right ? -1 : left > right ? 1 : 0
    const unique = new Map<string, EgressProxyValueViolation>()
    for (const violation of violations) {
      const identity =
        `${violation.context}\u0000${violation.placeholder}\u0000` +
        `${violation.header ?? ''}\u0000${violation.kind}`
      if (!unique.has(identity)) unique.set(identity, violation)
    }
    const sorted = [...unique.values()].sort(
      (left, right) =>
        compare(left.context, right.context) ||
        compare(left.placeholder, right.placeholder) ||
        compare(left.header ?? '', right.header ?? '')
    )
    const entries = sorted.map(violation => this.formatEgressProxyValueEntry(violation))
    const shown = entries.slice(0, MAX_EGRESS_PROXY_VALUE_ENTRIES)
    const hidden = entries.length - shown.length
    const more = hidden > 0 ? `; and ${hidden} more` : ''
    return (
      `${entries.length} value(s) would be refused by the egress-proxy image; ` +
      'the existing ConfigMap and Deployment are unchanged: ' +
      `${shown.join('; ')}${more}. See docs/crds/mcpserver.md "Value classes".`
    )
  }

  private formatEgressProxyValueEntry(violation: EgressProxyValueViolation): string {
    const dependent =
      violation.kind === 'dependent-env'
        ? '; a $(NAME) dependent env reference is not expanded by HCC, store the final value'
        : ''
    switch (violation.context) {
      case 'collision':
        return `env var \${${violation.placeholder}} collides with an NGINX variable the template uses`
      case 'quoted':
        return (
          `authHeader ${violation.header} placeholder \${${violation.placeholder}} ` +
          `(quoted value; ${violation.source}${dependent})`
        )
      case 'query':
        return `query placeholder \${${violation.placeholder}} (${violation.source}${dependent})`
      default: {
        const exhaustive: never = violation.context
        return exhaustive
      }
    }
  }

  /**
   * Block path of the egress-proxy value preflight. Modelled on the
   * ImageNotAllowed block: keep the existing ConfigMap, Service and Deployment
   * (and therefore the running pod), report not ready with a named reason, and
   * write no DeploymentReady.
   */
  private async blockEgressProxyValues(
    server: McpServerCRD,
    verdict: Extract<EgressProxyValueVerdict, { ok: false }>,
    isCurrent: () => boolean
  ): Promise<boolean> {
    // First, before any status write of the block: bump the retirement epoch so
    // a readiness tick that is already in flight cannot publish Ready=True over
    // this block. The clearTimeout + delete that beginStatusTracking uses does
    // not bump it; only the bump makes the resumed tick's retiredNow() true.
    this.retireReadinessWindow(server.name)
    if (server.spec.envSecret) {
      // The Secret exists and has its keys. Without this write a stale
      // SecretResolved=False/SecretNotFound from an earlier state would survive:
      // policies would stay revoked and the operator would see a missing Secret
      // instead of a value outside the class.
      await this.writeStatusCondition(
        server,
        {
          type: 'SecretResolved',
          status: 'True',
          reason: 'SecretFound',
          message: 'Secret resolved and validated',
        },
        isCurrent
      )
    }
    await this.writeStatusCondition(
      server,
      {
        type: 'EgressProxyValuesValid',
        status: 'False',
        reason: 'ValueOutsideClass',
        message: verdict.message,
      },
      isCurrent
    )
    await this.writeStatusCondition(
      server,
      {
        type: 'Ready',
        status: 'False',
        reason: 'EgressProxyValuesInvalid',
        message: verdict.message,
      },
      isCurrent
    )
    if (!isCurrent()) return false
    this.setStatus(server.name, {
      deployed: false,
      ready: false,
      message: `EgressProxyValuesValid=False: ${verdict.message}`,
    })
    // Field names avoid key/secret/token, which hccLogger redacts by name, and
    // each violation holds names only. No value byte reaches a log.
    hccLogger.warn('Blocking egress-proxy update: values outside the egress-proxy value class', {
      scope: '[Reconciler]',
      mcpServer: server.name,
      namespace: server.namespace,
      violations: verdict.violations,
    })
    return isCurrent()
  }

  private nginxConfigRevision(configMap: k8s.V1ConfigMap): string {
    return createHash('sha256')
      .update(configMap.data?.['default.conf.template'] ?? '')
      .digest('hex')
  }

  /**
   * Ensure ConfigMap exists and is up to date (create or replace). When the
   * caller already rendered the template for the preflight, it passes the
   * prebuilt ConfigMap so one reconcile renders the template once.
   */
  private async ensureConfigMap(
    server: McpServerCRD,
    isCurrent: () => boolean = () => true,
    prebuilt?: k8s.V1ConfigMap
  ): Promise<string> {
    const cm = prebuilt ?? this.buildNginxConfigMap(server)
    const name = `${server.name}-nginx-conf`
    const namespace = server.namespace
    await ensureResource({
      mutationAllowed: isCurrent,
      read: () =>
        observeExistenceRead('ConfigMap', () =>
          this.coreApi.readNamespacedConfigMap({ name, namespace })
        ),
      create: async () => {
        await observeCreate('ConfigMap', () =>
          this.coreApi.createNamespacedConfigMap({ namespace, body: cm })
        )
        hccLogger.info('nginx ConfigMap created', {
          scope: '[Reconciler]',
          configMap: name,
          namespace,
        })
      },
      converge: read =>
        replaceWithConflictRetry({
          description: `nginx ConfigMap "${name}"`,
          logPrefix: '[Reconciler]',
          body: cm,
          mergeExisting: preserveObjectAnnotations,
          isUpToDate: configMapMatchesDesired,
          mutationAllowed: isCurrent,
          read,
          replace: body => this.coreApi.replaceNamespacedConfigMap({ name, namespace, body }),
        }),
      onSkipped: () => createsTotal.inc({ kind: 'ConfigMap', outcome: 'skipped' }),
    })

    return this.nginxConfigRevision(cm)
  }

  /**
   * Build a Deployment manifest for an McpServer.
   */
  /**
   * Sanitize CRD spec fields to prevent developer-supplied CRDs from
   * influencing platform-controlled deployment behavior.
   *
   * Policy: the platform ALWAYS wins. CRD fields that could escalate
   * privileges, override security, or DoS the cluster are stripped or
   * overridden with platform defaults.
   */
  private sanitizeCrdSpec(server: McpServerCRD): void {
    // ── CRITICAL: imagePullPolicy — platform decides, not the CRD ──
    // Remove CRD-supplied value; buildDeployment uses config.mcpServerImagePullPolicy
    delete server.spec.imagePullPolicy

    // ── CRITICAL: prevent root execution ──
    if (server.spec.security) {
      if (server.spec.security.runAsUser !== undefined && server.spec.security.runAsUser < 1) {
        hccLogger.warn('McpServer: runAsUser rejected (must be >= 1)', {
          scope: '[Security]',
          name: server.name,
          runAsUser: server.spec.security.runAsUser,
        })
        server.spec.security.runAsUser = 1000
      }
      if (server.spec.security.runAsGroup !== undefined && server.spec.security.runAsGroup < 1) {
        hccLogger.warn('McpServer: runAsGroup rejected (must be >= 1)', {
          scope: '[Security]',
          name: server.name,
          runAsGroup: server.spec.security.runAsGroup,
        })
        server.spec.security.runAsGroup = 1000
      }
      if (server.spec.security.fsGroup !== undefined && server.spec.security.fsGroup < 1) {
        hccLogger.warn('McpServer: fsGroup rejected (must be >= 1)', {
          scope: '[Security]',
          name: server.name,
          fsGroup: server.spec.security.fsGroup,
        })
        server.spec.security.fsGroup = 1000
      }

      // ── CRITICAL: strip dangerous capabilities ──
      if (server.spec.security.addCapabilities) {
        const original = server.spec.security.addCapabilities
        server.spec.security.addCapabilities = original.filter(cap => {
          if (!isWorkflowRecipeDefaultAllowedCapability(cap)) {
            hccLogger.warn('McpServer: capability stripped (forbidden)', {
              scope: '[Security]',
              name: server.name,
              capability: cap,
            })
            return false
          }
          return true
        })
      }
    }

    // ── HIGH: sanitize env vars — block dangerous names ──
    if (server.spec.env) {
      server.spec.env = withoutForbiddenCrdEnv(server.spec.env, name =>
        hccLogger.warn('McpServer: env stripped (forbidden)', {
          scope: '[Security]',
          name: server.name,
          envVar: name,
        })
      )
    }

    // ── MEDIUM: clamp resources to platform limits ──
    if (server.spec.resources) {
      const MAX_CPU = '4000m'
      const MAX_MEM = '8Gi'
      if (server.spec.resources.limits) {
        if (server.spec.resources.limits.cpu && parseInt(server.spec.resources.limits.cpu) > 4000) {
          server.spec.resources.limits.cpu = MAX_CPU
        }
        if (
          server.spec.resources.limits.memory &&
          parseInt(server.spec.resources.limits.memory) > 8192
        ) {
          server.spec.resources.limits.memory = MAX_MEM
        }
      }
    }
  }

  /**
   * Names of the env vars the egress-proxy container of a remote server
   * receives. Derived from buildContainerEnv, the same function buildDeployment
   * uses, so no second copy of those rules exists here. buildContainerEnv strips
   * forbidden and reserved names silently; buildDeployment reports each
   * reserved (name, source) pair once per reconcile, and this lookup must not
   * report it again.
   */
  private egressProxyEnvNames(server: McpServerCRD): Set<string> {
    return new Set(this.buildContainerEnv(server).map(entry => entry.name))
  }

  /**
   * Env for the server's main container (the egress proxy of a remote server):
   * envMapping, spec.env, spec.envSecret, then the reserved-name strip, the
   * remote authHeaders backfill and the empty NGINX_ENVSUBST_FILTER. Forbidden
   * spec.env names are stripped here, silently, so no caller can deploy one;
   * buildDeployment sanitizes first and reports each stripped name once per
   * reconcile. For remote servers the six envsubst knobs the image pins and
   * the resolver pair are stripped too, and `onStripped` receives each removed
   * (name, source) pair.
   */
  private buildContainerEnv(
    server: McpServerCRD,
    onStripped: (
      name: string,
      source: 'spec.env' | 'spec.envSecret' | 'envMapping'
    ) => void = () => {}
  ): k8s.V1EnvVar[] {
    const transportPort = server.spec.transport.port || 3000
    const isRemote = this.isRemote(server)
    const healthCheckPort = server.spec.healthCheck?.port

    // --- Env vars ---
    // The CRD source of every entry is kept until the reserved-name strip, so a
    // stripped name is reported with the channel it came from.
    const assembled: Array<{
      source: 'spec.env' | 'spec.envSecret' | 'envMapping'
      entry: k8s.V1EnvVar
    }> = []

    // Env vars derived from CRD fields via envMapping
    const mapping = server.spec.envMapping
    if (mapping) {
      if (mapping.transport) {
        assembled.push({ source: 'envMapping', entry: { name: mapping.transport, value: 'http' } })
      }
      if (mapping.httpHost) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.httpHost, value: '0.0.0.0' },
        })
      }
      if (mapping.httpPort) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.httpPort, value: String(transportPort) },
        })
      }
      if (mapping.healthCheckHost) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.healthCheckHost, value: '0.0.0.0' },
        })
      }
      if (mapping.healthCheckPort && healthCheckPort) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.healthCheckPort, value: String(healthCheckPort) },
        })
      }

      const sc = server.spec.serverConfig
      if (mapping.readOnly && sc?.readOnly !== undefined) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.readOnly, value: String(sc.readOnly) },
        })
      }
      if (mapping.loggers && sc?.loggers) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.loggers, value: sc.loggers },
        })
      }
      if (mapping.telemetry && sc?.telemetry) {
        assembled.push({
          source: 'envMapping',
          entry: { name: mapping.telemetry, value: sc.telemetry },
        })
      }
    }

    // Additional plain env vars from CRD (server-specific extras). The strip is
    // the last line of defense: a caller that skipped sanitizeCrdSpec still
    // cannot deploy a forbidden name. Order and duplicates are preserved.
    if (server.spec.env) {
      for (const e of withoutForbiddenCrdEnv(server.spec.env)) {
        assembled.push({ source: 'spec.env', entry: { name: e.name, value: e.value } })
      }
    }

    // Secret-backed env vars
    if (server.spec.envSecret) {
      for (const keyMapping of server.spec.envSecret.keys) {
        assembled.push({
          source: 'spec.envSecret',
          entry: {
            name: keyMapping.envVar,
            valueFrom: {
              secretKeyRef: {
                name: server.spec.envSecret.name,
                key: keyMapping.secretKey,
              },
            },
          },
        })
      }
    }

    const env: k8s.V1EnvVar[] = []
    for (const item of assembled) {
      // The egress-proxy entrypoint assigns these six before it checks and
      // renders, so a CRD value would never reach envsubst and would only make
      // the Deployment state a value the pod ignores. The resolver pair is
      // stripped for the same reason (see RESOLVER_RESERVED_PROXY_ENV): the
      // platform appends its own flag below. Exact and case-sensitive, like
      // envsubst. Non-remote servers keep them: a local image may use them.
      if (
        isRemote &&
        (ENVSUBST_PINNED_PROXY_ENV.has(item.entry.name) ||
          RESOLVER_RESERVED_PROXY_ENV.has(item.entry.name))
      ) {
        onStripped(item.entry.name, item.source)
        continue
      }
      env.push(item.entry)
    }

    // Remote servers: ensure authHeaders ${VAR} placeholders have env vars
    // defined, even when credentials are optional and envSecret is absent.
    // Without this, nginx envsubst fails with "unknown variable" on startup.
    // A name the authHeader guard rejects (platform-owned: the KUBERNETES_*
    // family, a forbidden name or a reserved egress-proxy name) is never
    // backfilled: the header is already dropped, and a `value: ''` entry would
    // only override the container's own value (PATH, a reserved egress-proxy
    // name). Only braced references are scanned here; a bare $NAME gets no
    // entry.
    if (isRemote && server.spec.remote?.authHeaders) {
      const definedVars = new Set(env.map(e => e.name))
      for (const ah of server.spec.remote.authHeaders) {
        const matches = ah.valueTemplate.match(/\$\{(\w+)\}/g)
        if (!matches) continue
        for (const m of matches) {
          const varName = m.slice(2, -1)
          if (isPlatformOwnedTemplateName(varName)) {
            continue
          }
          if (!definedVars.has(varName)) {
            env.push({ name: varName, value: '' })
            definedVars.add(varName)
          }
        }
      }
    }

    if (isRemote) {
      // The rendered template resolves its upstream through
      // $NGINX_LOCAL_RESOLVERS, which the image's 15-local-resolvers.envsh
      // only exports when this flag is set.
      env.push({ name: 'NGINX_ENTRYPOINT_LOCAL_RESOLVERS', value: '1' })
      // 20-envsubst-on-templates.sh substitutes only the names matching
      // NGINX_ENVSUBST_FILTER. A CRD- or Secret-supplied filter that excludes a
      // declared placeholder would leave ${NAME} in the rendered config, where
      // NGINX resolves it as one of its own variables. An empty filter means
      // every defined name, and appending it last wins over every env source.
      env.push({ name: 'NGINX_ENVSUBST_FILTER', value: '' })
    }

    return env
  }

  private buildDeployment(
    server: McpServerCRD,
    credentialsRevision = '',
    nginxConfigRevision = ''
  ): k8s.V1Deployment {
    // ── Platform hardening: sanitize an ephemeral copy before building PodSpec ──
    // The caller retains this object as the LIST -> WATCH desired-state cache.
    // Mutating it here makes a later status-only watch event look like a
    // user-driven spec revision, which invalidates the authoritative policy
    // revocation marker during startup. Sanitization remains mandatory for the
    // generated PodSpec, but must never rewrite the observed CRD inventory.
    server = structuredClone(server)
    this.sanitizeCrdSpec(server)

    const transportPort = server.spec.transport.port || 3000
    const isStdio = server.spec.transport.type === 'stdio'
    const isRemote = this.isRemote(server)
    const healthCheckPort = server.spec.healthCheck?.port

    // --- Env vars ---
    // One warning per stripped (name, source) pair per reconcile: the
    // ConfigMap render derives the same names silently through
    // egressProxyEnvNames, so the report belongs to the Deployment build.
    const reportedStrips = new Set<string>()
    const env = this.buildContainerEnv(server, (name, source) => {
      const pair = `${source}\u0000${name}`
      if (reportedStrips.has(pair)) return
      reportedStrips.add(pair)
      hccLogger.warn('McpServer: env from source stripped (reserved for the egress-proxy image)', {
        scope: '[Security]',
        name: server.name,
        envVar: name,
        source,
      })
    })

    // --- Ports ---
    const ports: k8s.V1ContainerPort[] = [
      { name: 'http', containerPort: transportPort, protocol: 'TCP' },
    ]
    if (healthCheckPort) {
      ports.push({ name: 'healthcheck', containerPort: healthCheckPort, protocol: 'TCP' })
    }

    // --- Probes ---
    const probePort = healthCheckPort ? 'healthcheck' : 'http'

    // --- Resources ---
    let resources: k8s.V1ResourceRequirements | undefined
    if (server.spec.resources) {
      resources = {}
      if (server.spec.resources.requests) {
        resources.requests = {}
        if (server.spec.resources.requests.memory)
          resources.requests['memory'] = server.spec.resources.requests.memory
        if (server.spec.resources.requests.cpu)
          resources.requests['cpu'] = server.spec.resources.requests.cpu
      }
      if (server.spec.resources.limits) {
        resources.limits = {}
        if (server.spec.resources.limits.memory)
          resources.limits['memory'] = server.spec.resources.limits.memory
        if (server.spec.resources.limits.cpu)
          resources.limits['cpu'] = server.spec.resources.limits.cpu
      }
    }

    // --- Labels ---
    const labels: Record<string, string> = {
      app: server.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [MCPSERVER_LABEL]: server.name,
    }
    const runAsUser = server.spec.security?.runAsUser ?? 1000
    const runAsGroup = server.spec.security?.runAsGroup ?? runAsUser
    const podAnnotations: Record<string, string> = {}
    if (credentialsRevision) {
      podAnnotations[CREDENTIALS_REVISION_ANNOTATION] = credentialsRevision
    }
    if (this.isRemote(server) && nginxConfigRevision) {
      podAnnotations[NGINX_CONFIG_REVISION_ANNOTATION] = nginxConfigRevision
    }
    const hardenedContainerSecurityContext: k8s.V1SecurityContext = {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser,
      runAsGroup,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    }

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: server.name,
        namespace: server.namespace,
        labels,
        // G5: ownerRef to McpServer CRD for garbage collection
        ...(server.uid && {
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'McpServer',
              name: server.name,
              uid: server.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        }),
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { app: server.name },
        },
        template: {
          metadata: {
            labels,
            // Rotating a credential changes its digest, while a
            // remote template change changes the NGINX digest. Either change
            // alters the PodTemplate and rolls the container. Empty revisions
            // are omitted so they cannot become drift fields.
            ...(Object.keys(podAnnotations).length > 0 && { annotations: podAnnotations }),
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            // G1: Apply security context from McpServer CRD spec
            securityContext: {
              runAsNonRoot: true,
              runAsUser,
              runAsGroup,
              seccompProfile: { type: 'RuntimeDefault' },
              ...(server.spec.security?.fsGroup !== undefined && {
                fsGroup: server.spec.security.fsGroup,
              }),
            },
            // G6: Apply imagePullSecrets from McpServer CRD spec
            // Codex P2 fix (PR #101): CRD schema mandates [{name: string}] per K8s
            // LocalObjectReference; producers (mcpDelegation, registry install) now
            // normalize to objects, so we pass through directly without double-wrapping.
            ...(server.spec.imagePullSecrets?.length
              ? {
                  imagePullSecrets: server.spec.imagePullSecrets,
                }
              : {}),
            initContainers:
              isStdio && !isRemote
                ? [
                    {
                      name: 'copy-mcp-app',
                      image: server.spec.image,
                      imagePullPolicy: config.mcpServerImagePullPolicy,
                      command: [
                        'sh',
                        '-c',
                        'cp -r /app/* /mcp-bin/ 2>/dev/null; cp -r /mcp-app/* /mcp-bin/ 2>/dev/null; true',
                      ],
                      securityContext: hardenedContainerSecurityContext,
                      volumeMounts: [{ name: 'mcp-bin', mountPath: '/mcp-bin' }],
                    },
                  ]
                : undefined,
            containers: [
              // Remote egress proxy: nginx container with ConfigMap mount
              ...(isRemote
                ? [
                    {
                      name: 'egress-proxy',
                      image: config.egressProxyImage,
                      imagePullPolicy: 'IfNotPresent' as const,
                      ports: [
                        { name: 'http', containerPort: transportPort, protocol: 'TCP' as const },
                      ],
                      env: env.length > 0 ? env : undefined,
                      // Codex P1 fix (PR #101): mount as templates so the nginx proxy
                      // entrypoint runs envsubst at startup and resolves ${VAR}
                      // placeholders in auth headers using env from envSecret.
                      volumeMounts: [
                        { name: 'nginx-conf', mountPath: '/etc/nginx/templates', readOnly: true },
                      ],
                      livenessProbe: {
                        exec: {
                          command: ['/usr/local/bin/egress-proxy-liveness', String(transportPort)],
                        },
                        initialDelaySeconds: 5,
                        periodSeconds: 15,
                        timeoutSeconds: 5,
                        failureThreshold: 3,
                      },
                      readinessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 3,
                        periodSeconds: 10,
                      },
                      resources: {
                        requests: { memory: '32Mi', cpu: '25m' },
                        limits: { memory: '64Mi', cpu: '100m' },
                      },
                      securityContext: {
                        runAsNonRoot: true,
                        runAsUser: 101,
                        runAsGroup: 101,
                        capabilities: { drop: ['ALL'] },
                        allowPrivilegeEscalation: false,
                        seccompProfile: { type: 'RuntimeDefault' },
                      },
                    },
                  ]
                : []),
              // Local HTTP server (not stdio, not remote)
              ...(isStdio || isRemote
                ? []
                : [
                    {
                      name: 'mcp-server',
                      image: server.spec.image,
                      imagePullPolicy: config.mcpServerImagePullPolicy,
                      command: server.spec.command || undefined,
                      args: server.spec.args || undefined,
                      ports,
                      env: env.length > 0 ? env : undefined,
                      // G1: Per-container security context — capabilities.add must be at container level
                      securityContext: {
                        allowPrivilegeEscalation: false,
                        runAsNonRoot: true,
                        runAsUser,
                        runAsGroup,
                        seccompProfile: { type: 'RuntimeDefault' },
                        capabilities: {
                          drop: ['ALL'],
                          ...(server.spec.security?.addCapabilities?.length
                            ? { add: server.spec.security.addCapabilities }
                            : {}),
                        },
                      },
                      livenessProbe: {
                        tcpSocket: { port: probePort as IntOrString },
                        initialDelaySeconds: 10,
                        periodSeconds: 15,
                      },
                      readinessProbe: {
                        tcpSocket: { port: probePort as IntOrString },
                        initialDelaySeconds: 5,
                        periodSeconds: 10,
                      },
                      resources,
                    },
                  ]),
              ...(isStdio
                ? [
                    {
                      name: 'stdio-bridge',
                      image: config.stdioBridgeImage, // G10: configurable bridge image
                      imagePullPolicy: config.mcpServerImagePullPolicy,
                      env: [
                        {
                          name: 'STDIO_COMMAND',
                          value: (server.spec.command || ['/mcp-bin/mcp-server'])[0],
                        },
                        {
                          name: 'STDIO_ARGS',
                          value: JSON.stringify(
                            server.spec.args || (server.spec.command || []).slice(1)
                          ),
                        },
                        { name: 'BRIDGE_PORT', value: String(transportPort) },
                        ...env,
                      ],
                      ports: [{ name: 'http', containerPort: transportPort, protocol: 'TCP' }],
                      securityContext: hardenedContainerSecurityContext,
                      livenessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 15,
                        periodSeconds: 15,
                      },
                      readinessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 10,
                        periodSeconds: 10,
                      },
                      volumeMounts: [{ name: 'mcp-bin', mountPath: '/mcp-bin' }],
                      // G4: Independent resource limits for stdio-bridge sidecar
                      resources: {
                        requests: config.stdioBridgeResources.requests,
                        limits: config.stdioBridgeResources.limits,
                      },
                    },
                  ]
                : []),
            ],
            volumes: (() => {
              const v: k8s.V1Volume[] = []
              if (isStdio) v.push({ name: 'mcp-bin', emptyDir: {} })
              if (isRemote)
                v.push({ name: 'nginx-conf', configMap: { name: `${server.name}-nginx-conf` } })
              return v.length > 0 ? v : undefined
            })(),
          },
        },
      },
    }
  }

  /**
   * Build a Service manifest for an McpServer.
   */
  private buildService(server: McpServerCRD): k8s.V1Service {
    const transportPort = server.spec.transport.port || 3000

    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: server.name,
        namespace: server.namespace,
        labels: {
          app: server.name,
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [MCPSERVER_LABEL]: server.name,
        },
        // G5: ownerRef to McpServer CRD for garbage collection
        ...(server.uid && {
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'McpServer',
              name: server.name,
              uid: server.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        }),
      },
      spec: {
        type: 'ClusterIP',
        ports: [
          {
            port: transportPort,
            targetPort: 'http' as IntOrString,
            protocol: 'TCP',
            name: 'http',
          },
        ],
        selector: { app: server.name },
      },
    }
  }

  // ─── Reconciliation Actions ─────────────────────────────────────────

  /**
   * Ensure a Deployment exists and is up to date.
   */
  private async ensureDeployment(
    server: McpServerCRD,
    credentialsRevision = '',
    isCurrent: () => boolean = () => true,
    nginxConfigRevision = ''
  ): Promise<void> {
    let resolvedNginxConfigRevision = nginxConfigRevision
    if (this.isRemote(server) && !resolvedNginxConfigRevision) {
      resolvedNginxConfigRevision = this.nginxConfigRevision(this.buildNginxConfigMap(server))
    }
    const deployment = this.buildDeployment(
      server,
      credentialsRevision,
      resolvedNginxConfigRevision
    )

    await ensureResource({
      mutationAllowed: isCurrent,
      read: () =>
        observeExistenceRead('Deployment', () =>
          this.appsApi.readNamespacedDeployment({
            name: server.name,
            namespace: server.namespace,
          })
        ),
      create: async () => {
        await observeCreate('Deployment', () =>
          this.appsApi.createNamespacedDeployment({
            namespace: server.namespace,
            body: deployment,
          })
        )
        hccLogger.info('Deployment created', {
          scope: '[Reconciler]',
          deployment: server.name,
          namespace: server.namespace,
        })
      },
      converge: read =>
        replaceWithConflictRetry({
          description: `Deployment "${server.name}"`,
          logPrefix: '[Reconciler]',
          body: deployment,
          mergeExisting: preserveDeploymentAnnotations,
          isUpToDate: deploymentMatchesDesired,
          read,
          replace: body =>
            this.appsApi.replaceNamespacedDeployment({
              name: server.name,
              namespace: server.namespace,
              body,
            }),
          mutationAllowed: isCurrent,
        }),
      onSkipped: () => createsTotal.inc({ kind: 'Deployment', outcome: 'skipped' }),
    })
  }

  /**
   * Ensure a Service exists and is up to date.
   */
  private async ensureService(
    server: McpServerCRD,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const service = this.buildService(server)

    await ensureResource({
      mutationAllowed: isCurrent,
      read: () =>
        observeExistenceRead('Service', () =>
          this.coreApi.readNamespacedService({
            name: server.name,
            namespace: server.namespace,
          })
        ),
      create: () =>
        observeCreate('Service', () =>
          this.coreApi.createNamespacedService({
            namespace: server.namespace,
            body: service,
          })
        ),
      converge: read =>
        replaceWithConflictRetry({
          description: `Service "${server.name}"`,
          logPrefix: '[Reconciler]',
          body: service,
          mergeExisting: preserveServiceAssignedFields,
          isUpToDate: serviceMatchesDesired,
          read,
          replace: body =>
            this.coreApi.replaceNamespacedService({
              name: server.name,
              namespace: server.namespace,
              body,
            }),
          mutationAllowed: isCurrent,
        }),
      onSkipped: () => createsTotal.inc({ kind: 'Service', outcome: 'skipped' }),
    })
  }

  /**
   * Delete HCC-owned Deployment, Service, and remote ConfigMap for an McpServer.
   * Name matches are not enough: WRC-owned `managed:false` runtimes can share
   * names with McpServer CRDs, so every delete verifies HCC ownership labels.
   */
  private async deleteResources(
    name: string,
    namespace: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    const failures: unknown[] = []
    for (const cleanup of [
      () => this.deleteDeploymentIfHccOwned(name, namespace, deleteAllowed),
      () => this.deleteConfigMapIfHccOwned(`${name}-nginx-conf`, namespace, name, deleteAllowed),
      () => this.deleteServiceIfHccOwned(name, namespace, deleteAllowed),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    throwCleanupFailures(
      failures,
      `Failed to delete runtime Kubernetes resources for McpServer "${name}"`
    )
  }

  private isHccOwnedMcpResource(
    resource: { metadata?: { labels?: Record<string, string> } },
    serverName: string
  ): boolean {
    const labels = resource.metadata?.labels ?? {}
    return labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE && labels[MCPSERVER_LABEL] === serverName
  }

  private async deleteDeploymentIfHccOwned(
    name: string,
    namespace: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<DeploymentDeleteOutcome> {
    let deployment: k8s.V1Deployment
    try {
      deployment = await this.appsApi.readNamespacedDeployment({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        hccLogger.info('Deployment already gone', { name })
        return 'gone'
      }
      hccLogger.error('Failed to read Deployment ownership', { name, err: error })
      throw error
    }

    if (!this.isHccOwnedMcpResource(deployment, name)) {
      hccLogger.warn('Skipping Deployment delete — not HCC-owned', { name })
      return 'foreign'
    }
    if (deleteAllowed && !(await deleteAllowed())) return 'denied'

    try {
      await this.appsApi.deleteNamespacedDeployment({ name, namespace })
      hccLogger.info('Deleted Deployment', { name })
      return 'gone'
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        hccLogger.info('Deployment already gone', { name })
        return 'gone'
      }
      hccLogger.error('Failed to delete Deployment', { name, err: error })
      throw error
    }
  }

  /**
   * Delete leftover HCC-owned ConfigMap and Service after the Deployment
   * outcome is known. Does not write status.
   */
  private async deleteHccOwnedRuntimeSiblings(
    name: string,
    namespace: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    const siblingFailures: unknown[] = []
    for (const cleanup of [
      () => this.deleteConfigMapIfHccOwned(`${name}-nginx-conf`, namespace, name, deleteAllowed),
      () => this.deleteServiceIfHccOwned(name, namespace, deleteAllowed),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        siblingFailures.push(error)
      }
    }
    throwCleanupFailures(
      siblingFailures,
      `Failed to delete runtime Kubernetes resources for McpServer "${name}"`
    )
  }

  /**
   * Withdraw an HCC-owned runtime (#606): once the Deployment is confirmed
   * gone, retire the poll, persist DeploymentReady=False/RuntimeNotDesired,
   * then finish sibling deletes. Sibling failure does not roll back the
   * retract. Retire before the retract write so an in-flight tick cannot
   * republish True after the retract PATCH commits but before the epoch
   * bumps. A foreign (WRC-owned) Deployment retires the window without
   * writing RuntimeNotDesired. The window is also retired up front: if the
   * delete itself throws, this reconcile writes no status at all, and the
   * fence is the only thing keeping an in-flight tick from republishing
   * Ready=True behind the failure. Retiring twice only bumps the epoch
   * again, so the later retire on the gone/foreign paths stays harmless.
   */
  private async retractManagedRuntime(
    server: McpServerCRD,
    kind: RuntimeWithdrawKind,
    isCurrent: () => boolean
  ): Promise<RetractManagedRuntimeResult> {
    const name = server.name
    const namespace = server.namespace
    this.retireReadinessWindow(name)
    const deleteAllowed = async (): Promise<boolean> => isCurrent()
    let cleanupComplete = true
    const gatedDeleteAllowed = async (): Promise<boolean> => {
      const allowed = await deleteAllowed()
      if (!allowed) cleanupComplete = false
      return allowed
    }

    let deploymentOutcome: DeploymentDeleteOutcome
    try {
      deploymentOutcome = await this.deleteDeploymentIfHccOwned(name, namespace, deleteAllowed)
    } catch (error) {
      const failures: unknown[] = [error]
      for (const cleanup of [
        () => this.deleteConfigMapIfHccOwned(`${name}-nginx-conf`, namespace, name, deleteAllowed),
        () => this.deleteServiceIfHccOwned(name, namespace, deleteAllowed),
      ]) {
        try {
          await cleanup()
        } catch (siblingError) {
          failures.push(siblingError)
        }
      }
      throwCleanupFailures(
        failures,
        `Failed to delete runtime Kubernetes resources for McpServer "${name}"`
      )
      throw new Error(`Failed to delete runtime Kubernetes resources for McpServer "${name}"`)
    }

    switch (deploymentOutcome) {
      case 'denied':
        return {
          retracted: false,
          cleanupComplete: false,
          foreignRuntime: false,
          runtimeGone: false,
        }
      case 'foreign':
        this.retireReadinessWindow(name)
        await this.deleteHccOwnedRuntimeSiblings(name, namespace, gatedDeleteAllowed)
        return {
          retracted: false,
          cleanupComplete: cleanupComplete && isCurrent(),
          foreignRuntime: true,
          runtimeGone: false,
        }
      case 'gone':
        break
      default: {
        const _exhaustive: never = deploymentOutcome
        return _exhaustive
      }
    }

    this.retireReadinessWindow(name)
    const retractWrite = await this.writeStatusCondition(
      server,
      {
        type: 'DeploymentReady',
        status: 'False',
        reason: 'RuntimeNotDesired',
        message: runtimeNotDesiredMessage(kind),
      },
      isCurrent
    )
    const epoch = this.readinessRetirements.get(name)
    if (retractWrite === 'declined') {
      hccLogger.warn('Retract write declined', { name, kind, epoch, outcome: retractWrite })
    } else {
      hccLogger.info('Retracted managed runtime', { name, kind, epoch, outcome: retractWrite })
    }

    await this.deleteHccOwnedRuntimeSiblings(name, namespace, gatedDeleteAllowed)
    if (retractWrite === 'declined') {
      return {
        retracted: false,
        cleanupComplete: false,
        foreignRuntime: false,
        runtimeGone: true,
      }
    }
    return {
      retracted: true,
      cleanupComplete: cleanupComplete && isCurrent(),
      foreignRuntime: false,
      runtimeGone: true,
    }
  }

  private async deleteConfigMapIfHccOwned(
    configMapName: string,
    namespace: string,
    serverName: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    let configMap: k8s.V1ConfigMap
    try {
      configMap = await this.coreApi.readNamespacedConfigMap({ name: configMapName, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        hccLogger.info('ConfigMap already gone', { scope: '[Reconciler]', name: configMapName })
      } else {
        hccLogger.error('Failed to read ConfigMap ownership', {
          scope: '[Reconciler]',
          name: configMapName,
          err: error,
        })
        throw error
      }
      return
    }

    if (!this.isHccOwnedMcpResource(configMap, serverName)) {
      hccLogger.warn('Skipping ConfigMap delete — not HCC-owned', {
        scope: '[Reconciler]',
        name: configMapName,
      })
      return
    }
    if (deleteAllowed && !(await deleteAllowed())) return

    try {
      await this.coreApi.deleteNamespacedConfigMap({ name: configMapName, namespace })
      hccLogger.info('Deleted nginx ConfigMap', { scope: '[Reconciler]', name: configMapName })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        hccLogger.info('ConfigMap already gone', { scope: '[Reconciler]', name: configMapName })
      } else {
        hccLogger.error('Failed to delete ConfigMap', {
          scope: '[Reconciler]',
          name: configMapName,
          err: error,
        })
        throw error
      }
    }
  }

  private async deleteServiceIfHccOwned(
    name: string,
    namespace: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    let service: k8s.V1Service
    try {
      service = await this.coreApi.readNamespacedService({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        hccLogger.info('Service already gone', { scope: '[Reconciler]', name })
      } else {
        hccLogger.error('Failed to read Service ownership', {
          scope: '[Reconciler]',
          name,
          err: error,
        })
        throw error
      }
      return
    }

    if (!this.isHccOwnedMcpResource(service, name)) {
      hccLogger.warn('Skipping Service delete — not HCC-owned', { scope: '[Reconciler]', name })
      return
    }
    if (deleteAllowed && !(await deleteAllowed())) return

    try {
      await this.coreApi.deleteNamespacedService({ name, namespace })
      hccLogger.info('Deleted Service', { scope: '[Reconciler]', name })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        hccLogger.info('Service already gone', { scope: '[Reconciler]', name })
      } else {
        hccLogger.error('Failed to delete Service', { scope: '[Reconciler]', name, err: error })
        throw error
      }
    }
  }

  private async deleteRuntimeResources(
    name: string,
    namespace: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<boolean> {
    // A guarded no-op is incomplete even if authority returns before the
    // outer call settles. Ownership-based skips remain legitimate outcomes.
    let complete = true
    await this.deleteResources(
      name,
      namespace,
      deleteAllowed
        ? async () => {
            const allowed = await deleteAllowed()
            if (!allowed) complete = false
            return allowed
          }
        : undefined
    )
    return complete
  }

  // ─── CRD Status & Annotation Patching ──────────────────────────────

  /**
   * G2: Set `clerum.io/network-ready: "true"` annotation on McpServer CRD.
   * Completes the pre-deploy handshake so WRC knows NetworkPolicies are applied.
   */
  private async setNetworkReadyAnnotation(
    server: McpServerCRD,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    // Use merge-patch (plain object body) instead of JSON Patch (array body).
    // JSON Patch op:"add" on /metadata/annotations/<key> requires /metadata/annotations
    // to already exist — it fails with 422 when the CRD was created without annotations.
    // Merge-patch creates the map if absent. Errors are re-thrown so the caller (reconcile)
    // knows the handshake was not completed — WRC will time out and fail rather than proceed
    // silently without NetworkPolicies in place.
    if (!isCurrent()) return
    await this.customApi.patchNamespacedCustomObject(
      {
        group: 'clerum.io',
        version: 'v1alpha1',
        namespace: server.namespace,
        plural: 'mcpservers',
        name: server.name,
        body: {
          metadata: {
            annotations: {
              [NETWORK_READY_ANNOTATION]: 'true',
              // Issue #408: stamp the acked generation so WRC's waitForNetworkReady
              // can reject a stale ack from a previous generation.
              ...(typeof server.generation === 'number'
                ? { [NETWORK_READY_GENERATION_ANNOTATION]: String(server.generation) }
                : {}),
            },
          },
        },
      },
      {
        middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
      }
    )
  }

  /**
   * G11: Update DeploymentReady on the McpServer status subresource.
   * The condition describes Deployment rollout. WRC does not watch this type;
   * it reads the `clerum.io/network-ready` annotation.
   */
  private async updateStatusConditions(
    server: McpServerCRD,
    deploymentReady: boolean,
    /**
     * Rollout numbers from readDeploymentRollout, appended to the failure
     * message so a stuck rollout reports WHAT is stuck (issue #223). Callers
     * that only know the verdict omit it.
     */
    rolloutDetail?: string,
    isCurrent: () => boolean = () => true,
    onDecline: StatusWriteDeclineArg = () => 'record-obligation'
  ): Promise<void> {
    try {
      const deploymentWrote = await this.writeStatusCondition(
        server,
        {
          type: 'DeploymentReady',
          status: deploymentReady ? 'True' : 'False',
          reason: deploymentReady
            ? 'ReplicasAvailable'
            : rolloutDetail
              ? 'RolloutIncomplete'
              : 'WaitingForReplicas',
          message: rolloutDetail
            ? `Rollout did not converge — ${rolloutDetail}`
            : deploymentReady
              ? 'Deployment has ready replicas'
              : 'Waiting for pods to become ready',
        },
        isCurrent,
        onDecline
      )
      if (deploymentWrote === 'wrote') {
        hccLogger.info('Updated status conditions', {
          name: server.name,
          deploymentReady,
        })
      }
    } catch (error) {
      // Status subresource may not exist yet — log but don't fail reconciliation
      hccLogger.warn('Failed to update status conditions', { name: server.name, err: error })
    }
  }

  /**
   * Write (or merge) a single status condition on the McpServer CRD.
   *
   * Merge semantics:
   *   - Condition with same `type` and unchanged `status` → keep existing
   *     `lastTransitionTime`, refresh `reason` / `message`.
   *   - `DeploymentReady` with the same `status` but a new `reason` or
   *     `message` → bump `lastTransitionTime` so recovery after
   *     `RuntimeNotDesired` is visible to #223 consumers.
   *   - `EgressProxyValuesValid=False` (the egress-proxy block) → always bump
   *     `lastTransitionTime`, even when `reason` and `message` are identical to
   *     the prior refusal, and therefore always patch. The value is a
   *     per-rotation verdict and the Control UI only accepts a refusal written
   *     after its own rotation cutoff, so two out-of-class rotations that
   *     violate the same placeholder and key must not share one stamp.
   *   - Condition with same `type` but different `status` → bump
   *     `lastTransitionTime` to now.
   *   - New type → append with fresh `lastTransitionTime`.
   *   - Any write also strips retired types (NetworkReady) and every type the
   *     caller lists in `retireTypes` (for example `EgressProxyValuesValid`
   *     once the server stops being remote or is disabled). A retired type in
   *     the merged array also defeats the `unchanged` short-circuit, so the
   *     removal reaches the CRD even when the requested condition is identical.
   *
   * Side-effect: updates the `clerum_hcc_mcpserver_missing_secret` gauge for
   * `SecretResolved` conditions (1 when False, 0 when True).
   *
   * `onDecline` is a factory evaluated at decline time. The default records
   * an incomplete-publication obligation. Poll ticks pass a factory that is
   * `'silent'` only while `retiredNow()` is true.
   *
   * Returns `'wrote'` after a successful patch, `'unchanged'` when the
   * requested condition already matches and no retired type remains, or
   * `'declined'` when the fence or a write error stops the update. The
   * `EgressProxyValuesValid=False` exception above never returns `'unchanged'`.
   *
   * Failure modes:
   *   - 404 (CRD deleted mid-reconcile) → log + `decline()`.
   *   - 409/422 (optimistic conflict) → re-read, re-merge, bounded retry.
   *   - Other errors or exhausted retries → log + `decline()`.
   */
  async writeStatusCondition(
    server: McpServerCRD,
    condition: Omit<McpServerCondition, 'lastTransitionTime'>,
    isCurrent: () => boolean = () => true,
    onDecline: StatusWriteDeclineArg = () => 'record-obligation',
    /**
     * Condition types this write must remove from the merged array, treated
     * exactly like a globally retired type for this write only. The global
     * `RETIRED_STATUS_CONDITION_TYPES` list does not change.
     */
    retireTypes: readonly string[] = []
  ): Promise<StatusWriteOutcome> {
    const decline = (): StatusWriteOutcome =>
      onDecline() === 'silent' ? 'declined' : this.recordIncompletePublication(server)
    if (!isCurrent()) return decline()
    const now = new Date().toISOString()

    // Update the missing-secret gauge for SecretResolved conditions.
    // Do this before any no-op short-circuit so the gauge stays current
    // across reconciles even when we skip the API patch.
    if (condition.type === 'SecretResolved' && server.spec.envSecret) {
      const labels = {
        namespace: server.namespace,
        name: server.name,
        secret_name: server.spec.envSecret.name,
      }
      mcpserverMissingSecret.set(labels, condition.status === 'False' ? 1 : 0)
    }

    // Optimistic-concurrency loop (M2). The patch REPLACES the whole
    // /status/conditions array with a value built from a snapshot read just
    // before. Without a version guard, a concurrent writer — the readiness poll
    // and a reconcile can both write status for the same server, and the poll
    // timer is NOT serialized through `inFlight` — would be silently clobbered
    // by whichever patch lands second, dropping the other's condition. A `test`
    // op on metadata.resourceVersion makes the API server reject the patch (422)
    // if anything changed since our read; we then re-read and retry, so no
    // writer's condition is lost.
    for (let attempt = 1; attempt <= STATUS_CONDITION_WRITE_MAX_ATTEMPTS; attempt += 1) {
      if (!isCurrent()) return decline()
      // Re-read on every optimistic-conflict retry. Merging against the
      // latest resourceVersion preserves conditions written by peer
      // controllers between our read and patch.
      let existingConditions: McpServerCondition[] = []
      let hasStatusObject = false
      let resourceVersion: string | undefined
      try {
        const current = (await this.customApi.getNamespacedCustomObjectStatus({
          group: 'clerum.io',
          version: 'v1alpha1',
          namespace: server.namespace,
          plural: 'mcpservers',
          name: server.name,
        })) as {
          metadata?: { resourceVersion?: string }
          status?: { conditions?: McpServerCondition[] }
        }
        hasStatusObject = typeof current.status === 'object' && current.status !== null
        existingConditions = current.status?.conditions ?? []
        resourceVersion = current.metadata?.resourceVersion
      } catch (error) {
        if (getErrorCode(error) === 404) {
          hccLogger.warn('McpServer deleted mid-reconcile — skipping status update', {
            scope: '[Reconciler]',
            name: server.name,
          })
          return decline()
        }
        hccLogger.warn(
          'Failed to read status — skipping status update for type to avoid clobbering other status fields',
          { scope: '[Reconciler]', name: server.name, type: condition.type, err: error }
        )
        return decline()
      }
      if (!isCurrent()) return decline()

      const prior = existingConditions.find(c => c.type === condition.type)
      const observedGeneration = condition.observedGeneration ?? server.generation
      // A refusal (`EgressProxyValuesValid=False`) is a per-rotation verdict,
      // not a property of the CRD: the Control UI reports the rotation as
      // failed only when that condition's lastTransitionTime is after the
      // rotation's own cutoff (control-ui, useRolloutWait.ts). Two consecutive
      // out-of-class rotations that violate the same placeholder and key
      // produce a byte-identical reason+message, so reusing the prior stamp
      // would make a genuinely fresh refusal look stale and the UI would wait
      // out its whole 180s budget instead of failing. Restamping on every
      // block write is self-terminating: the patch changes status only, and
      // HCC already declines to reconcile a status-only MODIFIED event
      // (mcpServerSafety.isMcpServerStatusOnlyUpdate),
      // so it cannot re-enter this path. Scoped to this type+status: no other
      // condition type changes behavior.
      const refreshEgressProxyRefusalTime =
        condition.type === 'EgressProxyValuesValid' &&
        condition.status === 'False' &&
        prior !== undefined
      const unchanged =
        !refreshEgressProxyRefusalTime &&
        prior !== undefined &&
        prior.status === condition.status &&
        prior.reason === condition.reason &&
        prior.message === condition.message &&
        prior.observedGeneration === observedGeneration &&
        !existingConditions.some(
          existing =>
            isRetiredStatusConditionType(existing.type) || retireTypes.includes(existing.type)
        )

      // Skip the patch when the condition is identical to what's already on
      // the CRD. Without this, every reconcile bumps the McpServer's
      // resourceVersion, fires another watch event, triggers another
      // reconcile — a tight self-loop that also amplifies NetworkPolicy
      // optimistic-lock contention downstream.
      if (unchanged) {
        return 'unchanged'
      }

      const refreshDeploymentReadyTime =
        condition.type === 'DeploymentReady' &&
        prior !== undefined &&
        (prior.reason !== condition.reason || prior.message !== condition.message)
      const lastTransitionTime =
        prior &&
        prior.status === condition.status &&
        !refreshDeploymentReadyTime &&
        !refreshEgressProxyRefusalTime
          ? prior.lastTransitionTime
          : now

      const merged: McpServerCondition = {
        type: condition.type,
        status: condition.status,
        reason: condition.reason,
        message: condition.message,
        lastTransitionTime,
        ...(observedGeneration !== undefined && { observedGeneration }),
      }

      const nextConditions = [
        ...existingConditions.filter(
          existing =>
            existing.type !== condition.type &&
            !isRetiredStatusConditionType(existing.type) &&
            !retireTypes.includes(existing.type)
        ),
        merged,
      ]

      const writePreconditions: Array<{
        op: 'test'
        path: string
        value: string | number
      }> = []
      if (server.uid !== undefined) {
        writePreconditions.push({
          op: 'test',
          path: '/metadata/uid',
          value: server.uid,
        })
      }
      if (server.generation !== undefined) {
        writePreconditions.push({
          op: 'test',
          path: '/metadata/generation',
          value: server.generation,
        })
      }
      if (resourceVersion !== undefined) {
        writePreconditions.push({
          op: 'test',
          path: '/metadata/resourceVersion',
          value: resourceVersion,
        })
      }
      const statusPatch = [
        ...writePreconditions,
        ...(hasStatusObject
          ? [{ op: 'add', path: '/status/conditions', value: nextConditions }]
          : [{ op: 'add', path: '/status', value: { conditions: nextConditions } }]),
      ]

      try {
        // The generated client prefers JSON Patch for this endpoint. Send an
        // actual patch document so status writes keep working across client
        // upgrades instead of relying on merge-patch object bodies.
        if (!isCurrent()) return decline()
        await this.customApi.patchNamespacedCustomObjectStatus({
          group: 'clerum.io',
          version: 'v1alpha1',
          namespace: server.namespace,
          plural: 'mcpservers',
          name: server.name,
          body: statusPatch,
        })
        return 'wrote'
      } catch (error) {
        const errorCode = getErrorCode(error)
        if (errorCode === 404) {
          hccLogger.warn('McpServer deleted mid-reconcile — status patch skipped', {
            scope: '[Reconciler]',
            name: server.name,
          })
          return decline()
        }
        // 409 (Conflict) or 422 (a `test` op failed) mean a concurrent writer
        // won the race. Re-read and retry rather than lose our condition. Any
        // other error, or the last attempt, falls through to the best-effort
        // log-and-swallow below.
        if (
          (errorCode === 409 || errorCode === 422) &&
          attempt < STATUS_CONDITION_WRITE_MAX_ATTEMPTS
        ) {
          continue
        }
        hccLogger.warn('Failed to write status condition', {
          scope: '[Reconciler]',
          name: server.name,
          type: condition.type,
          status: condition.status,
          attempt,
          maxAttempts: STATUS_CONDITION_WRITE_MAX_ATTEMPTS,
          err: error,
        })
        return decline()
      }
    }
    return decline()
  }

  private recordIncompletePublication(server: McpServerCRD): 'declined' {
    // A declined or failed write replaces the obligation so an enclosing
    // reconcile cannot clear that failure on a later successful sibling write.
    this.pendingReconciliations.set(server.name, { namespace: server.namespace })
    return 'declined'
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Reconcile a created or modified McpServer.
   *
   * Concurrent calls for the same server name are serialized through
   * `inFlight` so we never run two reconciles in parallel for one server.
   * A prior failure does not block the next call; the chain absorbs it so
   * the next reconcile still runs.
   */
  async reconcile(server: McpServerCRD, options: McpServerMutationOptions = {}): Promise<void> {
    const capturedAuthority = this.inventoryAuthority()
    const callerIsCurrent = options.isCurrent ?? (() => true)
    const isCurrent = () => {
      if (!callerIsCurrent()) return false
      if (!this.inventoryAuthorityConfigured) return this.currentWhenUnconfigured()
      if (!this.authorityMatches(capturedAuthority)) return false
      const current = this.resolveCurrentServer?.(server.name)
      return current !== undefined && sameMcpServerDesiredRevision(server, current)
    }
    const key = server.name
    const obligation = { namespace: server.namespace }
    this.pendingReconciliations.set(key, obligation)
    const prev = this.inFlight.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return
        const completed = await this.performReconcile(server, isCurrent)
        if (completed && this.pendingReconciliations.get(key) === obligation) {
          this.pendingReconciliations.delete(key)
        }
      })
    this.inFlight.set(key, next)
    try {
      await next
    } finally {
      if (this.inFlight.get(key) === next) {
        this.inFlight.delete(key)
      }
    }
  }

  private async performReconcile(server: McpServerCRD, isCurrent: () => boolean): Promise<boolean> {
    if (!isCurrent()) return false
    this.beginStatusTracking(server)

    // G7: Enforce managed field immutability — once set, cannot change
    if (!isCurrent()) return false
    const currentManaged = server.spec.managed ?? true
    const previousManaged = this.managedSnapshot.get(server.name)
    if (previousManaged !== undefined && previousManaged !== currentManaged) {
      hccLogger.error(
        'McpServer: managed field changed. This is not allowed — delete and recreate the McpServer to change ownership.',
        { scope: '[Reconciler]', name: server.name, previousManaged, currentManaged }
      )
      if (!isCurrent()) return false
      this.setStatus(server.name, {
        deployed: false,
        ready: false,
        message: `managed field is immutable (was ${previousManaged}, attempted ${currentManaged})`,
      })
      return isCurrent()
    }
    if (!isCurrent()) return false
    this.managedSnapshot.set(server.name, currentManaged)

    // If disabled, respect ownership before any cleanup. managed:false means
    // WRC owns runtime resources; HCC only marks discovery status disabled.
    if (server.spec.enabled === false) {
      let cleanupComplete = true
      let retract: RetractManagedRuntimeResult | undefined
      if (currentManaged) {
        hccLogger.info('McpServer is disabled — removing HCC-owned resources', {
          scope: '[Reconciler]',
          name: server.name,
        })
        retract = await this.retractManagedRuntime(server, 'disabled', isCurrent)
        if (shouldStopAfterIncompleteRetract(retract, isCurrent)) return false
        cleanupComplete = retract.cleanupComplete
      } else {
        hccLogger.info('McpServer is disabled but WRC-owned; skipping runtime cleanup', {
          scope: '[Reconciler]',
          name: server.name,
        })
      }
      if (!isCurrent()) return false
      this.setStatus(server.name, { deployed: false, ready: false, message: 'Disabled' })
      await this.writeStatusCondition(
        server,
        {
          type: 'Ready',
          status: 'False',
          reason: 'Disabled',
          message: 'McpServer is disabled',
        },
        isCurrent,
        undefined,
        // A disabled server has no egress-proxy values to validate; retire the
        // condition instead of leaving a stale verdict on the CRD.
        ['EgressProxyValuesValid']
      )
      if (retract && !retract.retracted && !retract.foreignRuntime) return false
      return cleanupComplete && isCurrent()
    }

    if (!currentManaged) {
      return this.reconcileWrcOwnedServer(server, isCurrent)
    }

    // Validate secret before creating/updating
    const secretResult = await this.validateSecret(server)
    if (!isCurrent()) return false
    if (!secretResult.ok) {
      hccLogger.error('Skipping deployment — secret validation failed', {
        scope: '[Reconciler]',
        name: server.name,
      })
      const withdrawRuntime = shouldFailClosedForSecretFailure(secretResult.reason)
      let cleanupComplete = true
      let retract: RetractManagedRuntimeResult | undefined
      if (withdrawRuntime) {
        retract = await this.retractManagedRuntime(server, 'fail-closed', isCurrent)
        if (shouldStopAfterIncompleteRetract(retract, isCurrent)) return false
        cleanupComplete = retract.cleanupComplete
      } else {
        hccLogger.warn('Preserving existing runtime after transient Secret read failure', {
          scope: '[Reconciler]',
          name: server.name,
        })
      }
      if (!isCurrent()) return false
      this.setStatus(server.name, {
        deployed: false,
        ready: false,
        message: secretResult.message,
      })
      await this.writeStatusCondition(
        server,
        {
          type: 'SecretResolved',
          status: 'False',
          reason: secretResult.reason,
          message: secretResult.message,
        },
        isCurrent
      )
      await this.writeStatusCondition(
        server,
        {
          type: 'Ready',
          status: 'False',
          reason: 'SecretValidationFailed',
          message: secretResult.message,
        },
        isCurrent,
        undefined,
        // A fail-closed withdrawal removes the runtime the verdict judged,
        // so the verdict goes with it. A transient read failure preserves
        // that runtime and its still-accurate verdict.
        withdrawRuntime ? ['EgressProxyValuesValid'] : []
      )
      if (retract && !retract.retracted && !retract.foreignRuntime) return false
      return withdrawRuntime && cleanupComplete && isCurrent()
    }

    // Ensure resources exist and are up to date. The catch below serves two
    // phases with opposite contracts for EgressProxyValuesValid, told apart
    // by this flag: before the preflight verdict this spec has no verdict,
    // after it the verdict already judged the current values.
    let egressVerdictPassed = false
    try {
      // Remote egress proxy: create nginx ConfigMap before Deployment
      let nginxConfigRevision = ''
      if (this.isRemote(server)) {
        // The CRD image remains desired-state input owned by its author. Remote
        // workloads use the platform-owned proxy image selected in
        // buildDeployment(); rewriting spec.image here would bump generation
        // and retire this reconcile before it can create the runtime resources.
        //
        // Render once: the same ConfigMap goes to the API server, and the value
        // preflight derives its reference positions from it. The block runs
        // before ensureConfigMap, so an invalid value leaves the running pod's
        // template and env a matching pair (a ConfigMap-only write would project
        // a new template into a pod whose env predates it).
        const rendered = this.renderNginxTemplate(server)
        const verdict = this.checkEgressProxyValues(server, rendered, secretResult.secretData)
        if (!verdict.ok) {
          const blocked = await this.blockEgressProxyValues(server, verdict, isCurrent)
          return blocked
        }
        egressVerdictPassed = true
        nginxConfigRevision = await this.ensureConfigMap(server, isCurrent, rendered.configMap)
      } else {
        // Phase 2.3: plugin image-host allowlist. Audit mode (default) logs a
        // would-be denial and still builds; enforce mode blocks the workload.
        const decision = classifyPluginImage(server.spec.image, {
          allowedPrefixes: config.allowedPluginImagePrefixes,
          rejectLatest: false,
        })
        if (!decision.ok) {
          const message = `Image "${server.spec.image}" is not permitted by the plugin image allowlist (${decision.reason})`
          if (config.enforcePluginImageAllowlist) {
            hccLogger.warn(
              'Image is not permitted by the plugin image allowlist — blocking (enforce mode)',
              {
                scope: '[Reconciler]',
                image: server.spec.image,
                reason: decision.reason,
                name: server.name,
              }
            )
            await this.writeStatusCondition(
              server,
              {
                type: 'Ready',
                status: 'False',
                reason: 'ImageNotAllowed',
                message,
              },
              isCurrent,
              undefined,
              // No runtime is built on this exit, so no egress verdict
              // describes this server (an ex-remote keeps none either).
              ['EgressProxyValuesValid']
            )
            if (!isCurrent()) return false
            this.setStatus(server.name, { deployed: false, ready: false, message })
            return isCurrent()
          }
          hccLogger.warn(
            'Image is not permitted by the plugin image allowlist — audit mode, allowing (set CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST=true to block)',
            {
              scope: '[Reconciler]',
              image: server.spec.image,
              reason: decision.reason,
              name: server.name,
            }
          )
        }
      }
      if (!isCurrent()) return false
      await this.ensureService(server, isCurrent)
      if (!isCurrent()) return false
      await this.ensureDeployment(server, secretResult.revision, isCurrent, nginxConfigRevision)
    } catch (err) {
      if (!isCurrent()) return false
      const message = `Resource sync failed: ${err instanceof Error ? err.message : String(err)}`
      // The detail (which can carry a raw provider body) belongs in memory
      // and in this log only, never in a persisted condition. The logger
      // drops the provider code, so it rides its own field.
      hccLogger.error('Resource sync failed', {
        scope: '[Reconciler]',
        name: server.name,
        err,
        errorCode: getErrorCode(err),
      })
      this.setStatus(server.name, {
        deployed: false,
        ready: false,
        message,
      })
      if (this.isRemote(server) && !egressVerdictPassed) {
        // This spec produced no egress-proxy verdict (its render or preflight
        // is what failed), so an EgressProxyValuesValid=True persisted by an
        // earlier spec no longer describes this server. Retire it on the
        // Ready write, the same pattern the disabled and non-remote success
        // writes use: a condition this reconcile no longer owns is removed,
        // never parked at Unknown. The persisted message is a fixed literal;
        // the detail stays in the log above. A post-verdict failure takes
        // neither branch: the verdict already judged these values, so the
        // catch writes nothing and the next reconcile retries the sync.
        this.retireReadinessWindow(server.name)
        await this.writeStatusCondition(
          server,
          {
            type: 'Ready',
            status: 'False',
            reason: 'ResourceSyncFailed',
            message: 'Resource sync failed',
          },
          isCurrent,
          undefined,
          ['EgressProxyValuesValid']
        )
      }
      return false
    }

    // G2: Complete pre-deploy handshake — set network-ready annotation
    // after Deployment + Service are created, signaling WRC that
    // NetworkPolicies are in place and workload can proceed.
    if (
      server.annotations?.[PRE_DEPLOY_ANNOTATION] === 'true' &&
      (server.annotations?.[NETWORK_READY_ANNOTATION] !== 'true' ||
        // Issue #408: re-ack when the stamped generation is stale (spec changed since
        // the last ack). A non-numeric generation keeps the legacy behavior.
        (typeof server.generation === 'number' &&
          server.annotations?.[NETWORK_READY_GENERATION_ANNOTATION] !== String(server.generation)))
    ) {
      try {
        await this.setNetworkReadyAnnotation(server, isCurrent)
      } catch (err) {
        if (!isCurrent()) return false
        this.setStatus(server.name, {
          deployed: false,
          ready: false,
          message: `Pre-deploy handshake failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return false
      }
    }

    // Check readiness after reconciliation
    const rollout = await this.readDeploymentRollout(server.name, server.namespace)
    if (!isCurrent()) return false
    const ready = rollout.ready
    this.setStatus(server.name, {
      deployed: true,
      ready,
      message: ready ? 'Running' : 'Deployment created, waiting for pods to become ready',
    })

    // G11: Update status conditions on McpServer CRD. If the readiness poll
    // already exhausted its budget for THIS Deployment generation, keep the
    // terminal RolloutIncomplete verdict sticky: the terminal status write
    // itself fires a MODIFIED watch event and thus this very code path, and
    // writing a bare "waiting" condition here would downgrade the verdict
    // milliseconds after it was published — the operator (and the E2
    // scenario) would never observe the rollout failure. A NEW rollout
    // (different generation) drops the stickiness and reports fresh.
    const pollState = this.readinessPolls.get(server.name)
    const exhaustedDetail =
      !ready &&
      pollState !== undefined &&
      pollState.exhausted &&
      rollout.generation !== null &&
      pollState.generation === rollout.generation
        ? pollState.detail
        : undefined
    await this.updateStatusConditions(server, ready, exhaustedDetail, isCurrent)

    // PR-B B1: record SecretResolved=True + Ready=True after a successful
    // reconcile. This is additive to updateStatusConditions (DeploymentReady);
    // the merge logic in writeStatusCondition preserves the existing
    // conditions by type.
    if (server.spec.envSecret) {
      await this.writeStatusCondition(
        server,
        {
          type: 'SecretResolved',
          status: 'True',
          reason: 'SecretFound',
          message: 'Secret resolved and validated',
        },
        isCurrent
      )
    }
    // Only managed, enabled, remote servers get this condition: their values
    // passed the preflight just above. A local or WRC-owned server never has it
    // (and gets it retired by its Ready write below when it stops being remote).
    if (this.isRemote(server)) {
      await this.writeStatusCondition(
        server,
        {
          type: 'EgressProxyValuesValid',
          status: 'True',
          reason: 'ValuesWithinClass',
          message: 'Every value the egress-proxy template substitutes is within its class',
        },
        isCurrent
      )
    }
    await this.writeStatusCondition(
      server,
      {
        type: 'Ready',
        status: ready ? 'True' : 'Unknown',
        reason: ready ? 'ReconcileSuccess' : 'WaitingForReplicas',
        message: ready
          ? 'Deployment created'
          : 'Deployment created, waiting for pods to become ready',
      },
      isCurrent,
      undefined,
      // A server that stops being remote must not keep a stale
      // EgressProxyValuesValid from its egress-proxy lifetime.
      this.isRemote(server) ? [] : ['EgressProxyValuesValid']
    )

    // If not ready yet, poll until it becomes ready. With generation-aware
    // readiness this is the normal path right after any Deployment write —
    // including a credential rotation — so the poll owns the terminal verdict
    // on the CRD.
    //
    // Post-terminal re-observation (intentional, self-terminating): after a
    // terminal RolloutIncomplete, the status write that recorded it fires a
    // MODIFIED watch → performReconcile → here again with !ready, arming ONE more
    // poll window. For a genuinely stuck deployment the terminal condition re-write
    // is byte-identical (the detail is a pure function of the replica tuple, no
    // timestamps), so writeStatusCondition's `unchanged` short-circuit skips the
    // patch → no watch event → no further re-arm. The only thing that re-arms again
    // is a deployment whose replica tuple perpetually OSCILLATES, and that is
    // bounded to one reconcile per poll window (~120s) — not a tight loop, and (per
    // pollReadiness's atomic check-then-set) not a timer leak.
    if (!ready && isCurrent()) {
      this.pollReadiness(server, 5000, 24, isCurrent)
    }
    return isCurrent()
  }

  private async reconcileWrcOwnedServer(
    server: McpServerCRD,
    isCurrent: () => boolean
  ): Promise<boolean> {
    if (!isCurrent()) return false
    hccLogger.info(
      'McpServer is WRC-owned (managed:false); skipping HCC runtime creation/deletion and updating discovery status.',
      { scope: '[Reconciler]', name: server.name }
    )

    const secretResult = await this.validateSecret(server)
    if (!isCurrent()) return false
    if (!secretResult.ok) {
      this.setStatus(server.name, {
        deployed: true,
        ready: false,
        message: secretResult.message,
      })
      if (server.spec.envSecret) {
        await this.writeStatusCondition(
          server,
          {
            type: 'SecretResolved',
            status: 'False',
            reason: secretResult.reason,
            message: secretResult.message,
          },
          isCurrent
        )
      }
      await this.writeStatusCondition(
        server,
        {
          type: 'Ready',
          status: 'False',
          reason: 'SecretValidationFailed',
          message: secretResult.message,
        },
        isCurrent,
        undefined,
        // Same retire list as the WRC success write below: HCC never runs
        // the egress-proxy preflight for a WRC-owned server.
        ['EgressProxyValuesValid']
      )
      return shouldFailClosedForSecretFailure(secretResult.reason) && isCurrent()
    }

    if (!isCurrent()) return false
    this.setStatus(server.name, {
      deployed: true,
      ready: true,
      message: 'WRC-owned runtime registered',
    })
    if (server.spec.envSecret) {
      await this.writeStatusCondition(
        server,
        {
          type: 'SecretResolved',
          status: 'True',
          reason: 'SecretFound',
          message: 'Secret resolved and validated',
        },
        isCurrent
      )
    }
    await this.writeStatusCondition(
      server,
      {
        type: 'Ready',
        status: 'True',
        reason: WRC_OWNED_RUNTIME_READY_REASON,
        message: 'WRC-owned runtime registered for HCC discovery',
      },
      isCurrent,
      undefined,
      // WRC owns the runtime, so HCC never runs the egress-proxy preflight
      // for this server: retire any verdict persisted from before WRC
      // ownership instead of leaving it next to Ready=True. Same retire list
      // the managed non-remote success write passes.
      ['EgressProxyValuesValid']
    )
    return isCurrent()
  }

  /**
   * Reconcile a deleted McpServer.
   */
  async reconcileDelete(name: string, namespace: string): Promise<void> {
    hccLogger.info('McpServer deleted — cleaning up resources', { scope: '[Reconciler]', name })
    const capturedAuthority = this.inventoryAuthority()
    const obligation = { namespace }
    this.pendingReconciliations.set(name, obligation)
    const complete = await this.deleteRuntimeResources(name, namespace, () =>
      this.orphanDeleteAllowed(name, namespace, capturedAuthority)
    )
    if (complete && this.pendingReconciliations.get(name) === obligation) {
      this.pendingReconciliations.delete(name)
      this.clearStatus(name)
    }
  }

  private authorityMatches(captured: McpServerInventoryAuthoritySnapshot): boolean {
    const current = this.inventoryAuthority()
    return captured.known && current.known && captured.generation === current.generation
  }

  /**
   * A cache miss is not proof of absence: the API watch may have accepted an
   * ADDED event that has not reached this process yet. Confirm a 404 from the
   * API and then recheck both cache membership and LIST→WATCH authority
   * immediately before every destructive delete.
   */
  private async orphanDeleteAllowed(
    name: string,
    namespace: string,
    capturedAuthority: McpServerInventoryAuthoritySnapshot
  ): Promise<boolean> {
    return confirmAuthoritativeMcpServerAbsence({
      inventoryAuthoritative: () => this.authorityMatches(capturedAuthority),
      resolveCurrent: () => this.resolveCurrentServer?.(name),
      readCurrent: () =>
        this.customApi.getNamespacedCustomObject({
          group: 'clerum.io',
          version: 'v1alpha1',
          namespace,
          plural: 'mcpservers',
          name,
        }),
    })
  }

  /**
   * Full reconciliation pass — sync desired state with actual state.
   * Called on startup to handle CRDs that were created while the skill-mapper was down.
   */
  async fullReconcile(
    desiredServers: McpServerCRD[],
    options: McpServerFullReconcileOptions = {}
  ): Promise<void> {
    hccLogger.info('Running full reconciliation for McpServer(s)', {
      scope: '[Reconciler]',
      count: desiredServers.length,
    })
    const capturedAuthority = this.inventoryAuthority()

    // Get all deployments managed by skill-mapper
    const existingDeployments = await this.listManagedDeployments()
    const desiredNames = new Set(
      desiredServers
        .filter(s => s.spec.enabled !== false && (s.spec.managed ?? true))
        .map(s => s.name)
    )

    const runEffect =
      options.runEffect ?? ((_serverName: string, work: () => Promise<void>) => work())
    const maxConcurrency = options.maxConcurrency ?? DEFAULT_FULL_RECONCILE_MAX_CONCURRENCY
    const inScope = (name: string) => options.scope === undefined || options.scope.has(name)

    // Create or update desired servers independently. runEffect owns each
    // per-server lane, so a slow fleet member cannot become a process-wide
    // startup barrier. The finite worker pool admits no more than the configured
    // number of effects at once, while still waiting for every desired result
    // before reporting aggregated failures or moving to orphan cleanup.
    const scopedServers = desiredServers.filter(server => inScope(server.name))
    const desiredResults = await mapSettledWithConcurrency(scopedServers, maxConcurrency, server =>
      runEffect(server.name, async () => {
        const current = this.resolveCurrentServer ? this.resolveCurrentServer(server.name) : server
        // Cache mutation happens synchronously before its keyed watch effect is
        // queued. If this startup item was superseded, skip it and let the
        // newer queued event perform external-egress-before-runtime using its
        // own spec; reconciling the newer runtime here could otherwise race
        // ahead of that safety policy.
        if (!current || !sameMcpServerDesiredRevision(server, current)) return
        const isCurrent = () => {
          if (!this.inventoryAuthorityConfigured) {
            if (!this.currentWhenUnconfigured()) return false
          } else if (!this.authorityMatches(capturedAuthority)) {
            return false
          }
          const latest = this.resolveCurrentServer?.(current.name)
          return latest
            ? sameMcpServerDesiredRevision(current, latest)
            : this.resolveCurrentServer === undefined && this.currentWhenUnconfigured()
        }
        await this.reconcile(current, { isCurrent })
      })
    )
    throwCleanupFailures(
      desiredResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason),
      'Failed to reconcile desired McpServers'
    )

    // Delete orphaned deployments (managed by us but no longer desired)
    const cleanupTargets = new Map(
      existingDeployments.map(deployment => [
        deployment.metadata?.name || '',
        deployment.metadata?.namespace || config.namespace,
      ])
    )
    const presentNames = new Set(desiredServers.map(server => server.name))
    for (const [name, pending] of this.pendingReconciliations) {
      if (!presentNames.has(name)) cleanupTargets.set(name, pending.namespace)
    }
    for (const [name, namespace] of cleanupTargets) {
      if (!desiredNames.has(name) && inScope(name)) {
        if (!presentNames.has(name)) this.pendingReconciliations.set(name, { namespace })
        await runEffect(name, async () => {
          if (!(await this.orphanDeleteAllowed(name, namespace, capturedAuthority))) {
            hccLogger.warn(
              'Deferring orphan cleanup: McpServer exists or inventory authority is unknown or changed',
              { scope: '[Reconciler]', name }
            )
            return
          }
          hccLogger.info('Removing orphaned resources', { scope: '[Reconciler]', name })
          await this.reconcileDelete(name, namespace)
        })
      }
    }

    hccLogger.info('Full reconciliation complete', { scope: '[Reconciler]' })
  }

  /**
   * List all Deployments managed by skill-mapper (by label selector).
   */
  private async listManagedDeployments(): Promise<k8s.V1Deployment[]> {
    try {
      const response = await this.appsApi.listNamespacedDeployment({
        namespace: config.namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      })
      return response.items || []
    } catch (error) {
      hccLogger.error('Failed to list managed deployments', { scope: '[Reconciler]', err: error })
      throw error
    }
  }
}
