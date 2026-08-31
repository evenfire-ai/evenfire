/**
 * WorkflowRecipe Reconciler — 11-step pipeline.
 *
 * 1. Read WorkflowRecipe CRD
 * 2. Validate spec
 * 3. Resolve inputs (defaults << inputs << profiles)
 * 4. Resolve templates ({{...}} references)
 * 5. Sort dependencies (topological sort)
 * 6. Build K8s manifests (resource builders)
 * 7. Create resources (PVCs, Secrets, ConfigMaps)
 * 8. Create workloads (in dependency order)
 * 9. Create services (for workloads with ports, no transport)
 * 10. Update status subresource
 * 11. Handle delete (reverse dependency order, skip PVCs)
 */
import * as k8s from '@kubernetes/client-node'
import {
  PROVIDER_NON_TRANSPORT_ALLOWED_PORTS,
  STATE_ANNOTATION,
  isProviderNonTransportPortAllowed,
  parseProviderNetblocks,
  resolveProviderRanges,
} from '@clerum/network-policy-core'
import {
  lookupFqdnProvider,
  providerBounds,
  providerNames,
} from '@clerum/network-policy-core/providerRegistry'
import { OperatorConfig, loadConfig } from '../config'
import { getPool } from '../db'
import {
  externalEgressPermanentDnsExemptedTotal,
  externalEgressProviderDriftTotal,
} from '../metrics'
import {
  ConfigMapResourceDef,
  CronJobDef,
  DaemonSetDef,
  DeploymentDef,
  JobDef,
  PvcResourceDef,
  RecipePhase,
  ResourceDef,
  SecretResourceDef,
  SecurityIsolationLevel,
  StatefulSetDef,
  StatusCondition,
  WorkflowRecipeCRD,
  WorkflowRecipeSpec,
  WorkflowRecipeStatus,
  WorkloadDef,
} from '../types'
import {
  INHERITED_PARENT_RESOURCES_ANNOTATION,
  buildDbRunChildName,
} from '../workflow/childRecipeFactory'
import { HttpMcpHostClient } from '../workflow/httpMcpHostClient'
import { JwtTokenFactory } from '../workflow/jwtTokenFactory'
import { K8sSecretReaderImpl } from '../workflow/k8sSecretReaderImpl'
import { readRecipeCodexConnectionRef } from '../workflow/llmAllowedModelsSnapshot'
import { ModelConfigHandler } from '../workflow/modelConfigHandler'
import { buildCoordinatorGfsNetworkPolicy } from '../workflow/networkPolicyFactory'
import type { EagerSdkBootstrapProof } from '../workflow/pluginWorkloadSdkProvisioner'
import { HttpPluginWorkloadSdkRevocationClient } from '../workflow/pluginWorkloadSdkRevocationClient'
import { deriveWorkflowRuntimePlan } from '../workflow/runtimePlan'
import { validateWorkflowRecipeLimits } from '../workflow/workflowLimits'
import {
  WORKFLOW_OUTPUT_CONDITION_TYPES,
  WorkflowReconciler,
  WorkflowReconcilerDeps,
} from '../workflow/workflowReconciler'
import { evaluateComputedValues } from './computedValuesEvaluator'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from './crdConstants'
import { sort as sortDependencies } from './dependencyGraph'
import { type AccumulateOutput, accumulateExternalEgress } from './externalEgressAccumulator'
import {
  type EgressFailureKind,
  type EgressResolutionFailure,
  type FqdnLookup,
  defaultFqdnLookup,
  isBlockedExternalIPv4,
  resolveExternalEgress,
} from './fqdnResolver'
import { filterByIncludeWhen } from './includeWhenFilter'
import { resolve as resolveInputs } from './inputResolver'
import {
  type InternalDependencyIssueReason,
  evaluateInternalDependencies,
} from './internalDependencies'
import {
  INTERNAL_DEPENDENCY_POLICY_TYPE,
  NETWORK_POLICY_TYPE_LABEL,
  buildInternalDependencyEgressNetworkPolicy,
  buildInternalDependencyIngressNetworkPolicy,
} from './internalDependencyNetworkPolicies'
import { getErrorCode, isRetryableInfraError } from './k8sErrors'
import {
  DelegationDeps,
  cleanupDelegation,
  delegateTransportWorkloads,
  deleteTransportDelegation,
  externalEgressMcpServerNames,
  mcpServerName,
  preDeployMcpServers,
  waitForExternalEgressReady,
  waitForNetworkReady,
} from './mcpDelegation'
import { issueOAuthBrokerToken } from './oauthBrokerTokenIssuerClient'
import {
  PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
  type PluginWorkloadSdkStatusProjection,
  buildPluginWorkloadSdkStatus,
  validatePluginWorkloadSdkSpec,
} from './pluginWorkloadSdkValidator'
import { listWorkflowRecipePolicies } from './policyClient'
import { enforcePolicy } from './policyEnforcer'
import * as rb from './resourceBuilder'
import {
  classifySecretAccess,
  combineSecretAccess,
  isSecretAccessibleByRecipe,
  parseSecretOwnership,
} from './secretOwnership'
import { SecretReverseIndex } from './secretReverseIndex'
import { SPEC_HASH_ANNOTATION, specHashUnchanged, stampSpecHash } from './specHash'
import { isTerminal, transition } from './stateMachine'
import {
  buildWebhookGatewayResources,
  gatewayConfigMapName,
  gatewayResourceName,
  gatewayServiceName,
  handlerEgressNetworkPolicyName,
  handlerIngressNetworkPolicyName,
  proxyIngressNetworkPolicyName,
} from './webhookGatewayBuilder'
import { validateWebhooks } from './webhookValidator'
import { WorkloadTemplateResolutionError, resolveWorkloadTemplates } from './workloadTemplates'

const FINALIZER = 'clerum.io/workload-cleanup'
const PARENT_RECIPE_LABEL = 'clerum.io/parent-recipe'
const WORKFLOW_RUN_ID_LABEL = 'clerum.io/workflow-run-id'
const WORKFLOW_ACTOR_ID_LABEL = 'clerum.io/workflow-actor-id'
const WORKFLOW_ACTOR_TYPE_LABEL = 'clerum.io/workflow-actor-type'

function externalEgressReadinessError(
  recipeName: string,
  result: Awaited<ReturnType<typeof waitForExternalEgressReady>>
): Error {
  const pending = result.pending.map(name => `${name}: pending`)
  const failed = result.failed.map(({ name, message }) => `${name}: ${message}`)
  return new Error(
    `External egress policy readiness not achieved for WorkflowRecipe "${recipeName}". ` +
      `${[...pending, ...failed].join('; ')}. ` +
      `External egress bindings are not enforceable until HCC reports ExternalEgressReady=True.`
  )
}

function clusterNetworkPolicyEnforcementError(recipeName: string): Error {
  return new Error(
    `NetworkPolicy enforcement mode is required for WorkflowRecipe "${recipeName}", but ` +
      'CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED is not true. External egress policies are ' +
      'ready, but this cluster has not been explicitly validated as enforcing NetworkPolicy packets.'
  )
}

function declaresInheritedParentResources(recipe: WorkflowRecipeCRD): boolean {
  const parentName = recipe.metadata.labels?.[PARENT_RECIPE_LABEL]
  return (
    parentName !== undefined &&
    recipe.metadata.annotations?.[INHERITED_PARENT_RESOURCES_ANNOTATION] === 'true' &&
    (recipe.metadata.ownerReferences ?? []).some(
      ownerRef =>
        ownerRef.apiVersion === 'clerum.io/v1alpha1' &&
        ownerRef.kind === 'WorkflowRecipe' &&
        ownerRef.name === parentName &&
        ownerRef.controller === true
    )
  )
}

function isTerminalWorkflowStatusPhase(phase: unknown): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}

// Re-issue the OAuth broker token once it is within this window of expiry, so
// the mounted Secret never serves a stale token between reconcile cadences.
const OAUTH_BROKER_TOKEN_REFRESH_BEFORE_SECS = 300

/** Decode a JWT's `exp` (seconds) without verifying the signature. 0 on failure. */
function decodeJwtExp(token: string): number {
  try {
    const payload = token.split('.')[1]
    if (!payload) return 0
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp : 0
  } catch {
    return 0
  }
}

/** Condition types this reconciler owns; merge logic replaces them by type. */
const WEBHOOK_CONDITION_TYPES = new Set([
  'WebhookHandlerInvalid',
  'WebhookSecretMissing',
  'WebhookDormant',
  'WebhookGatewayNotReady',
  'WebhookJwksFetchFailed',
])

/**
 * Replace any condition whose type is owned by this reconciler pass with the
 * freshly emitted version. Conditions of other types pass through untouched,
 * preserving status maintained by other components.
 *
 * Returns `undefined` when there is nothing to merge (no fresh owned conditions
 * and no existing owned conditions to clear) so the merge-patch body can omit
 * the field entirely.
 */
function mergeOwnedConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined,
  ownedTypes: ReadonlySet<string>
): StatusCondition[] | undefined {
  const hasFresh = fresh && fresh.length > 0
  const hasExistingOwned = existing?.some(c => ownedTypes.has(c.type)) ?? false
  if (!hasFresh && !hasExistingOwned) return undefined
  const out = (existing ?? []).filter(c => !ownedTypes.has(c.type))
  for (const c of fresh ?? []) out.push(c)
  return out
}

function mergeWebhookConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined
): StatusCondition[] | undefined {
  return mergeOwnedConditions(existing, fresh, WEBHOOK_CONDITION_TYPES)
}

function mergeWorkflowOutputConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined
): StatusCondition[] | undefined {
  return mergeOwnedConditions(existing, fresh, WORKFLOW_OUTPUT_CONDITION_TYPES)
}

const INTERNAL_DEPENDENCY_CONDITION_TYPES = new Set(['InternalDependenciesReady'])

function mergeInternalDependencyConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined
): StatusCondition[] | undefined {
  return mergeOwnedConditions(existing, fresh, INTERNAL_DEPENDENCY_CONDITION_TYPES)
}

// Issue #637 — recipe↔Secret cross-ownership boundary for workload refs
// (envSecret + imagePullSecrets). Owned by the Step 8 ownership gate.
const SECRET_OWNERSHIP_CONDITION_TYPES = new Set(['EnvSecretOwnershipDenied'])

function mergeSecretOwnershipConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined
): StatusCondition[] | undefined {
  return mergeOwnedConditions(existing, fresh, SECRET_OWNERSHIP_CONDITION_TYPES)
}

const PLUGIN_WORKLOAD_SDK_CONDITION_TYPES = new Set([
  PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
])

function mergePluginWorkloadSdkConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined
): StatusCondition[] | undefined {
  return mergeOwnedConditions(existing, fresh, PLUGIN_WORKLOAD_SDK_CONDITION_TYPES)
}

const WORKLOAD_RECONCILE_CONDITION_TYPES = new Set(['StatefulSetImmutableDrift'])

function mergeWorkloadReconcileConditions(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined
): StatusCondition[] | undefined {
  return mergeOwnedConditions(existing, fresh, WORKLOAD_RECONCILE_CONDITION_TYPES)
}

function validateWorkloadEgressBindings(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  workloadNamespace: string
): void {
  const bindings = workload.egressBindings ?? []
  if (bindings.length === 0) return
  if (bindings.length > 20) {
    throw new Error(`Workload "${workload.id}" egressBindings must contain at most 20 items`)
  }
  for (const [index, binding] of bindings.entries()) {
    const prefix = `Workload "${workload.id}" egressBindings[${index}]`
    const rawBinding = binding as unknown as Record<string, unknown>

    if ('cidr' in rawBinding) {
      throw new Error(`${prefix}: cidr is not allowed on WorkflowRecipe egressBindings`)
    }

    const egressClass = binding.egressClass ?? 'exact-host'
    if (
      egressClass !== 'exact-host' &&
      egressClass !== 'public-web' &&
      egressClass !== 'provider'
    ) {
      throw new Error(`${prefix}: egressClass must be exact-host, public-web, or provider`)
    }

    // issue #299 Phase 2 (PR335-WRC-001) — defense-in-depth SHAPE validation
    // mirroring the CRD CEL and the HCC reconciler. SHAPE ONLY: catalog
    // validity stays at reconcile via resolveProviderRanges.
    if (binding.provider !== undefined && egressClass !== 'provider') {
      throw new Error(`${prefix}: provider declarations require egressClass "provider"`)
    }
    if (egressClass === 'provider') {
      if (binding.provider === undefined) {
        throw new Error(`${prefix}: egressClass "provider" requires a provider declaration`)
      }
      if (typeof binding.provider.name !== 'string' || binding.provider.name.trim() === '') {
        throw new Error(`${prefix}: provider.name must be a non-empty string`)
      }
      if (binding.provider.categories !== undefined) {
        if (
          !Array.isArray(binding.provider.categories) ||
          binding.provider.categories.length === 0 ||
          binding.provider.categories.some(c => typeof c !== 'string' || c.trim() === '')
        ) {
          throw new Error(
            `${prefix}: provider.categories must be a non-empty array of non-empty strings`
          )
        }
      }
      // NO `continue`: a provider binding falls through to the port + dns
      // strictness block below, exactly like exact-host.
    }

    if (egressClass === 'public-web') {
      if (!workload.transport) {
        throw new Error(
          `${prefix}: public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings`
        )
      }
      if (
        rawBinding.dns !== undefined ||
        rawBinding.port !== undefined ||
        rawBinding.protocol !== undefined
      ) {
        throw new Error(
          `${prefix}: public-web egressBindings must not declare dns, port, or protocol`
        )
      }
      continue
    }

    if (
      binding.port === undefined ||
      !Number.isInteger(binding.port) ||
      binding.port < 1 ||
      binding.port > 65535
    ) {
      throw new Error(`${prefix}: port must be an integer between 1 and 65535`)
    }

    // issue #510 — cap `provider` on NON-TRANSPORT workloads to the ports
    // `public-web` allows. `public-web` is refused outright above for this
    // workload class; without this cap `provider` would be the WIDER grant on
    // the port dimension (any 1-65535 against a whole netblock catalog — a /20
    // on TCP/22 was reproduced), i.e. the refused tier would be narrower than
    // the permitted one. With the cap, `provider` is a strict subset of
    // `public-web` in both dimensions and permitting it is coherent.
    //
    // Placed AFTER the port range check so `binding.port` is a valid integer,
    // and BEFORE any catalog read so the ceiling holds even when the netblocks
    // ConfigMap is missing or stale. Transport workloads are not capped.
    if (
      egressClass === 'provider' &&
      !workload.transport &&
      !isProviderNonTransportPortAllowed(binding.port)
    ) {
      throw new Error(
        `${prefix}: egressClass "provider" on a non-transport workload is limited to port ` +
          `${PROVIDER_NON_TRANSPORT_ALLOWED_PORTS.join(' or ')} (got ${binding.port}); ` +
          `move the workload to an MCP transport to reach other ports`
      )
    }

    if (Object.prototype.hasOwnProperty.call(rawBinding, 'dns')) {
      const dns = typeof binding.dns === 'string' ? binding.dns.trim() : ''
      if (!dns) {
        throw new Error(`${prefix}: dns is required`)
      }
      if (dns.includes('/')) {
        throw new Error(`${prefix}: dns must not use CIDR notation`)
      }
      if (dns === '*' || dns.startsWith('*.')) {
        throw new Error(`${prefix}: wildcard dns values are not allowed`)
      }
      if (dns !== dns.toLowerCase()) {
        throw new Error(`${prefix}: dns must be lowercase`)
      }
      if (dns.includes(':')) {
        throw new Error(`${prefix}: dns must not include a port or URL scheme`)
      }
      // Cluster-local target? If so, MUST be a sibling workload in THIS
      // recipe in the expected namespace. Otherwise an author could write
      // `db.sandbox-recipes.svc.cluster.local` and have us auto-grant
      // ingress on someone else's `db`. Sibling refs short-circuit the
      // public-DNS strictness below.
      const resolved = rb.resolveClusterLocalBinding(dns, recipe, workloadNamespace)
      if (resolved) {
        // issue #299 Phase 2 (PR335-WRC-001) — provider ranges are public
        // netblocks; a cluster-local sibling target makes no sense and would
        // smuggle catalog CIDRs onto an internal hop.
        if (egressClass === 'provider') {
          throw new Error(
            `${prefix}: provider egressBindings must target a public DNS hostname, not a cluster-local sibling`
          )
        }
        if (workload.transport) {
          throw new Error(
            `${prefix}: cluster-local egressBindings are only supported on non-transport workloads`
          )
        }
        if (resolved.kind === 'mismatch') {
          throw new Error(`${prefix}: ${resolved.reason}`)
        }
        continue
      }
      if (
        !dns.includes('.') ||
        dns === 'localhost' ||
        dns === 'metadata.goog' ||
        dns === 'kubernetes.default' ||
        dns.endsWith('.localhost') ||
        dns.endsWith('.local') ||
        dns.endsWith('.internal') ||
        dns.endsWith('.svc') ||
        dns.endsWith('.cluster.local')
      ) {
        throw new Error(`${prefix}: dns must be a public DNS hostname`)
      }
      if (dns.split('.').some(label => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error(`${prefix}: dns must be a valid DNS hostname`)
      }
    } else {
      throw new Error(`${prefix}: dns is required`)
    }
  }
}

function validateWorkloadBindings(
  workloads: WorkloadDef[],
  bindings: WorkflowRecipeCRD['spec']['bindings']
): void {
  if (!bindings || bindings.length === 0) return

  const workloadIds = new Set(workloads.map(w => w.id))
  const transportIds = new Set(workloads.filter(w => Boolean(w.transport)).map(w => w.id))

  bindings.forEach((binding, index) => {
    const prefix = `Binding ${index}`
    if (!workloadIds.has(binding.from)) {
      throw new Error(`${prefix}: from references unknown workload "${binding.from}"`)
    }
    if (!workloadIds.has(binding.to)) {
      throw new Error(`${prefix}: to references unknown workload "${binding.to}"`)
    }
    if (!Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65535) {
      throw new Error(`${prefix}: port must be an integer between 1 and 65535`)
    }
    if (
      binding.protocol !== undefined &&
      binding.protocol !== 'TCP' &&
      binding.protocol !== 'UDP'
    ) {
      throw new Error(`${prefix}: protocol must be TCP or UDP`)
    }

    const transportEndpoints = [binding.from, binding.to].filter(id => transportIds.has(id))
    if (transportEndpoints.length !== 1) {
      throw new Error(
        `${prefix}: binding must connect exactly one MCP transport workload to one non-transport workload`
      )
    }
  })
}

/**
 * Thrown by a reconcile step that failed for a transient reason (e.g. a DNS
 * SERVFAIL/timeout while resolving egress FQDNs) rather than a permanent
 * misconfiguration. The top-level reconcile catch maps this to the non-terminal
 * `degraded` phase so the periodic reconcile retries and the recipe self-heals
 * once the underlying dependency recovers — instead of bricking it at the
 * terminal `failed` phase, which is never retried.
 */
export class RetryableReconcileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'RetryableReconcileError'
    // Preserve the underlying error so logs (and any `.cause`-walking
    // classifier such as isRetryableInfraError's collectSocketCodes) can still
    // see the original transport/HTTP signal even though we re-message it for
    // the recipe status. Re-wrapping with `: ${String(error)}` alone would
    // flatten the chain and discard `.code`/`.cause`.
    if (options && 'cause' in options) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

class NetworkPolicyOwnershipConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkPolicyOwnershipConflictError'
  }
}

class InternalDependencyReconcileError extends Error {
  constructor(
    message: string,
    readonly conditions: StatusCondition[]
  ) {
    super(message)
    this.name = 'InternalDependencyReconcileError'
  }
}

class ImmutableStatefulSetDriftError extends Error {
  constructor(
    message: string,
    readonly condition: StatusCondition
  ) {
    super(message)
    this.name = 'ImmutableStatefulSetDriftError'
  }
}

/**
 * Build the error thrown when external egress FQDNs can't be resolved. Returns
 * a `RetryableReconcileError` only when EVERY failure was transient (a resolver
 * blip worth retrying); a single permanent failure (no records or a blocked
 * address) yields a plain `Error` so the recipe fails closed terminally.
 */
function egressResolutionError(
  context: string,
  failures: Array<{
    fqdn: string
    error: string
    retryable: boolean
    failureKind?: EgressFailureKind
  }>
): Error {
  const message = `${context}: ${failures.map(f => `${f.fqdn} (${f.error})`).join(', ')}`
  return failures.every(f => f.retryable)
    ? new RetryableReconcileError(message)
    : new Error(message)
}

export interface ReconcileResult {
  phase: RecipePhase
  message: string
  workloadStatuses: Array<{ id: string; phase: string; ready: boolean; message?: string }>
  /**
   * Webhook gateway-related conditions accumulated during reconcile.
   * `patchStatus` writes these into status.conditions[]; an empty array
   * means there is nothing to merge for this pass.
   */
  webhookConditions?: StatusCondition[]
  workflowConditions?: StatusCondition[]
  internalDependencyConditions?: StatusCondition[]
  /**
   * EnvSecretOwnershipDenied condition(s) from the Step 8 ownership gate
   * (Issue #637). `True` when a workload references a Secret it does not own;
   * `False`/absent when all referenced Secrets are owned or shared.
   */
  secretOwnershipConditions?: StatusCondition[]
  /**
   * Workload reconcile conditions owned by this reconciler. Used for stable,
   * UI/API-consumable reasons that should not be inferred from free-form messages.
   */
  workloadConditions?: StatusCondition[]
  /** SDK-only eager-host provider health, kept separate from workflow phase. */
  pluginWorkloadSdkProviderUnavailable?: boolean
  /** SDK host identity is ready, but an operator prompt policy is not active yet. */
  pluginWorkloadSdkPolicyPending?: boolean
  /** Cleanup completed successfully while the SDK feature flag was off. */
  pluginWorkloadSdkTeardownConfirmed?: boolean
  pluginWorkloadSdkBootstrapProof?: EagerSdkBootstrapProof
  /**
   * SDK capability projection (conditions + `status.pluginWorkloadSdk` value)
   * derived once per reconcile from this result. Populated by the watcher after
   * `reconcile()` returns (see `projectPluginWorkloadSdk`) so BOTH
   * `shouldPatchRecipeStatus` (to detect a computed awaiting_policy↔validated
   * transition that no other diff would surface — issue #375) and `patchStatus`
   * (to avoid recomputing it) consume the same object. Left undefined on paths
   * that do not run the SDK lane (e.g. workload-status-only refresh), where the
   * SDK comparison is intentionally skipped.
   */
  pluginWorkloadSdkProjection?: PluginWorkloadSdkStatusProjection
  workflowPhase?: import('../workflow/types').WorkflowPhase
  clearWorkflowExecution?: boolean
  /** When true, the caller should NOT patch the CRD status — the phase hasn't changed. */
  skipStatusPatch?: boolean
  /**
   * Base delay (ms) after which the watcher should re-enqueue this recipe even
   * though no status was patched. Set on transient infra paths (where
   * skipStatusPatch suppresses the write, so there is no MODIFIED event to
   * drive the retry). The watcher applies bounded exponential backoff on top,
   * UNLESS `requeueFixedInterval` is set (see below).
   */
  requeueAfterMs?: number
  /**
   * When true, the watcher must requeue at a FIXED `requeueAfterMs` interval and
   * RESET the per-recipe backoff counter, instead of applying exponential
   * backoff. Set for steady-state PROGRESS requeues (phase === 'deploying',
   * waiting on a Pod we created to advance). Progress is not an error, so it
   * must NOT inherit the transient-error backoff curve: exponential growth would
   * stretch the poll cadence toward the 60s cap and re-expose the 240s mcp-host
   * readiness deadline (MCP_HOST_READINESS_WAIT_TIMEOUT_MS) that this requeue
   * exists to beat. Transient-ERROR requeues (skipStatusPatch) leave this
   * false/undefined so genuine flakiness still backs off.
   */
  requeueFixedInterval?: boolean
}

/**
 * Base requeue delay for a transient (skipStatusPatch) reconcile result. The
 * watcher backs off exponentially from here up to its own cap.
 */
export const TRANSIENT_REQUEUE_BASE_MS = 5_000

/**
 * Base requeue delay for a non-terminal in-progress workflow reconcile result
 * (phase === 'deploying') that is waiting on a Pod it created — e.g. the output
 * anchor/prepare pods. The controller is level-triggered and watches ONLY the
 * WorkflowRecipe CR, not the Pods it spawns. A Pod transitioning to Succeeded is
 * a Pod change, NOT a CR change, so no MODIFIED event fires to re-run reconcile.
 * Without a timer-driven requeue, the run wedges at phase=deploying forever (the
 * `${recipeName}-mcp-host` pod is never created once the output-prepare pod
 * Succeeds), and dbRunProcessor repeatedly logs "orphaned running run reclaimed".
 * The watcher applies bounded exponential backoff on top; once output-prepare is
 * Succeeded the next pass advances past the waiting state, so the requeue is not
 * a hot loop.
 */
export const WORKFLOW_PROGRESS_REQUEUE_BASE_MS = 5_000

export interface WorkflowRecipeReconcilerDeps {
  /**
   * DNS resolver used to expand `ui.egress.external[].fqdn` entries into
   * /32 (A) and /128 (AAAA) ipBlock rules. Defaults to node:dns/promises.
   * Tests inject a stub so they don't hit real DNS.
   */
  fqdnLookup?: FqdnLookup
  /**
   * Secret reverse index updated after each recipe reconcile. The Secret
   * watcher consults it to fan out reconciles when a referenced Secret's
   * key-set changes. Optional — tests can omit it; in dev mode it can be
   * left unset.
   */
  secretReverseIndex?: SecretReverseIndex
  /**
   * Test seam for the durable DB-run provenance check used before a child
   * WorkflowRecipe may inherit its parent's runtime identity. Production uses
   * the authoritative `workflow_runs` row directly.
   */
  verifyWorkflowRunProvenance?: (expected: {
    runId: string
    parentNamespace: string
    parentName: string
    childNamespace: string
    childName: string
  }) => Promise<WorkflowRunProvenanceState>
}

export type WorkflowRunProvenanceState = 'verified' | 'pending' | 'invalid'

export interface WorkflowRunProvenanceRow {
  phase: string
  recipe_namespace: string
  recipe_name: string
  child_recipe_namespace: string | null
  child_recipe_name: string | null
}

export function classifyWorkflowRunProvenance(
  row: WorkflowRunProvenanceRow | undefined,
  expected: {
    runId: string
    parentNamespace: string
    parentName: string
    childNamespace: string
    childName: string
  }
): WorkflowRunProvenanceState {
  if (
    !row ||
    row.recipe_namespace !== expected.parentNamespace ||
    row.recipe_name !== expected.parentName
  ) {
    return 'invalid'
  }
  if (
    row.child_recipe_namespace === expected.childNamespace &&
    row.child_recipe_name === expected.childName
  ) {
    return 'verified'
  }
  if (
    row.phase === 'Pending' &&
    row.child_recipe_namespace === null &&
    row.child_recipe_name === null &&
    expected.childName === buildDbRunChildName(expected.parentName, expected.runId)
  ) {
    return 'pending'
  }
  return 'invalid'
}

export class RuntimeScopeResolutionPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeScopeResolutionPendingError'
  }
}

/**
 * Recursively canonicalize a value: sort every object's keys (order-insensitive
 * for objects) while PRESERVING array order (egress/to/ports arrays are emitted
 * in a deterministic order and the apiserver preserves it). Used to compare
 * policy egress without the key-ordering fragility of a raw JSON.stringify.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k])
    return out
  }
  return value
}

/**
 * A representation-independent signature of a policy's egress: a canonical
 * (deep key-sorted) JSON of `spec.egress`. Decides whether a write is needed
 * WITHOUT the key-ordering fragility of a raw JSON.stringify (audit R2-1): the
 * apiserver/client deserializes rule objects with keys ordered differently than
 * the builder emits them, so a raw compare is always unequal on a live cluster
 * and would defeat the no-churn gate. Unlike the earlier tuple-only signature,
 * this captures the FULL rule — including `namespaceSelector`/`podSelector` `to`
 * entries for internal/cluster-local egress (audit H1): a tuple signature over
 * ipBlock only was blind to selector changes, stranding a stale policy.
 *
 * It also projects `podSelector` and `policyTypes` (audit H-C), not just
 * `spec.egress`: a policy whose selector or policy types drifted out-of-band —
 * with the same destination rules — must count as changed so the reconcile
 * re-owns it, rather than leaving external egress applied to the wrong pods.
 * `policyTypes` is order-insensitive (sorted). Mirrors HCC's `egressSignature`.
 */
export function egressSignature(policy: k8s.V1NetworkPolicy): string {
  const spec = policy.spec
  return JSON.stringify(
    canonicalize({
      podSelector: spec?.podSelector ?? {},
      policyTypes: [...(spec?.policyTypes ?? [])].sort(),
      egress: spec?.egress ?? [],
    })
  )
}

export class WorkflowRecipeReconciler {
  private appsApi: k8s.AppsV1Api
  private batchApi: k8s.BatchV1Api
  private coreApi: k8s.CoreV1Api
  private customApi: k8s.CustomObjectsApi
  private networkingApi: k8s.NetworkingV1Api
  private config: OperatorConfig
  private workflowReconciler: WorkflowReconciler | null = null
  private _tokenFactory: JwtTokenFactory | null = null
  private fqdnLookup: FqdnLookup
  // H2 (issue #299): the smallest DNS TTL (ms) observed across external-egress
  // resolutions. The refresh loop advances to <= this/2 so a rotating low-TTL
  // host is sampled every rotation. Ratchets down and never recovers until
  // restart — deliberately: over-refreshing is cheap (writes are no-ops via the
  // F2 gate) and the safe direction; under-refreshing would reopen #299.
  private externalEgressMinObservedTtlMs = Infinity
  private secretReverseIndex: SecretReverseIndex | null
  private verifyWorkflowRunProvenance: NonNullable<
    WorkflowRecipeReconcilerDeps['verifyWorkflowRunProvenance']
  >

  constructor(kc: k8s.KubeConfig, config?: OperatorConfig, deps?: WorkflowRecipeReconcilerDeps) {
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api)
    this.batchApi = kc.makeApiClient(k8s.BatchV1Api)
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api)
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi)
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api)
    this.config = config ?? loadConfig()
    this.fqdnLookup = deps?.fqdnLookup ?? defaultFqdnLookup
    this.secretReverseIndex = deps?.secretReverseIndex ?? null
    this.verifyWorkflowRunProvenance =
      deps?.verifyWorkflowRunProvenance ??
      (async expected => {
        const result = await getPool().query<WorkflowRunProvenanceRow>(
          `SELECT phase, recipe_namespace, recipe_name,
                  child_recipe_namespace, child_recipe_name
             FROM workflow_runs
            WHERE run_id = $1
            LIMIT 1`,
          [expected.runId]
        )
        return classifyWorkflowRunProvenance(result.rows[0], expected)
      })
  }

  /**
   * Returns the JwtTokenFactory initialized by `initializeWorkflow`, or null
   * if the signing-key Secret was not found at bootstrap. Used by the MCP
   * server to sign fresh WRC→mcp-host tokens inside the artifact proxy and
   * configure-model endpoints (no in-memory store).
   */
  get tokenFactory(): JwtTokenFactory | null {
    return this._tokenFactory
  }

  /** Initialize workflow subsystem with JWT signing key. Call once at startup. */
  async initializeWorkflow(privateKeyPem: string, publicKeyPem?: string): Promise<void> {
    const tokenFactory = new JwtTokenFactory(privateKeyPem, {
      runtimeTokenTtlSeconds: this.config.runtimeTokenTtlSeconds,
    })
    await tokenFactory.initialize()
    this._tokenFactory = tokenFactory

    // Initialize WRC public key for verifying tokens WRC signed itself.
    if (publicKeyPem) {
      const { initializePublicKey } = await import('../workflow/restEndpoints')
      await initializePublicKey(publicKeyPem)
    }

    // Bootstrap control-api public key from env var — verifies admin delegation
    // tokens (iss=control-api) used by getArtifact. If not set, admin delegation
    // paths fail closed with 401, which is the correct posture.
    const controlApiPem = process.env.CONTROL_API_PUBLIC_KEY_PEM
    if (controlApiPem) {
      const { initializeControlApiPublicKey } = await import('../workflow/restEndpoints')
      await initializeControlApiPublicKey(controlApiPem)
      console.log('[WR-Reconciler] control-api JWT public key loaded — admin delegation enabled')
    } else {
      console.warn(
        '[WR-Reconciler] CONTROL_API_PUBLIC_KEY_PEM not set — admin artifact delegation will return 401'
      )
    }

    const deps: WorkflowReconcilerDeps = {
      coreApi: this.coreApi,
      customApi: this.customApi,
      networkingApi: this.networkingApi,
      pgPool: getPool(),
      config: {
        coordinatorImage:
          process.env.CLERUM_COORDINATOR_IMAGE ?? 'clerum/workflow-coordinator:latest',
        mcpHostImage: process.env.CLERUM_MCP_HOST_IMAGE ?? 'clerum/mcp-host:latest',
        artifactReaderImage:
          process.env.CLERUM_ARTIFACT_READER_IMAGE ?? 'clerum/workflow-recipes:latest',
        snippetRunnerImage:
          process.env.CLERUM_SNIPPET_RUNNER_IMAGE ?? 'clerum/workflow-snippet-runner:latest',
        wrcEndpoint: `http://${process.env.CLERUM_WRC_SERVICE_NAME ?? 'workflow-recipes'}.control-plane.svc.cluster.local:${this.config.port}`,
        sandboxNamespace: this.config.sandboxNamespace,
        mcpServerNamespace: this.config.namespace,
        imagePullPolicy:
          (process.env.CLERUM_IMAGE_PULL_POLICY as 'Always' | 'IfNotPresent' | 'Never') ??
          'IfNotPresent',
        enableCustomCoordinatorImage: this.config.enableCustomCoordinatorImage,
        enableSnippetRuntime: this.config.enableSnippetRuntime,
        pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
        maxWorkflowSteps: this.config.maxWorkflowSteps,
        allowedCoordinatorImagePrefixes: this.config.allowedCoordinatorImagePrefixes,
        requireCoordinatorImageDigest: this.config.requireCoordinatorImageDigest,
        enableDeterministicMode: this.config.enableDeterministicMode,
        workflowDefaultRunDurationSeconds: this.config.workflowDefaultRunDurationSeconds,
        workflowMaxRunDurationSeconds: this.config.workflowMaxRunDurationSeconds,
        runtimeTokenTtlSeconds: this.config.runtimeTokenTtlSeconds,
        runtimeTokenRefreshBeforeSeconds: this.config.runtimeTokenRefreshBeforeSeconds,
        runtimeEgressDnsOverlapSeconds: this.config.runtimeEgressDnsOverlapSeconds,
        networkPolicyEnforcementMode: this.config.networkPolicyEnforcementMode,
        networkPolicyEnforcementConfirmed: this.config.networkPolicyEnforcementConfirmed,
        workflowMaxWorkloadsPerRecipe: this.config.workflowMaxWorkloadsPerRecipe,
        workflowUiEgressInternalMaxItems: this.config.workflowUiEgressInternalMaxItems,
        workflowMaxSteps: this.config.workflowMaxSteps,
        workflowStepDependsOnMaxItems: this.config.workflowStepDependsOnMaxItems,
        workflowStepAllowedToolsMaxItems: this.config.workflowStepAllowedToolsMaxItems,
        workflowStepMcpServersMaxItems: this.config.workflowStepMcpServersMaxItems,
        workflowStatefulSetMaxReplicas: this.config.workflowStatefulSetMaxReplicas,
        workflowStatefulSetMaxVolumeClaimTemplates:
          this.config.workflowStatefulSetMaxVolumeClaimTemplates,
        workflowStatefulSetMaxPvcPreflightChecks:
          this.config.workflowStatefulSetMaxPvcPreflightChecks,
      },
      tokenFactory,
      // WRC-side Secret Broker for the Plugin Workload SDK eager mcp-host
      // configure path (Option A). Same wiring as mcp/server.ts.
      modelConfigHandler: new ModelConfigHandler(
        new K8sSecretReaderImpl(this.coreApi),
        new HttpMcpHostClient()
      ),
      pluginWorkloadSdkRevocationClient: new HttpPluginWorkloadSdkRevocationClient(),
    }
    this.workflowReconciler = new WorkflowReconciler(deps)
    console.log('[WR-Reconciler] Workflow subsystem initialized')
  }

  private get delegationDeps(): DelegationDeps {
    return { customApi: this.customApi, coreApi: this.coreApi }
  }

  /**
   * SDK revocation is fail-closed: an uninitialised workflow subsystem is not
   * equivalent to a successful cleanup. Refusing to report the capability as
   * disabled keeps a stale host/token reachable only behind an explicit
   * requeue, until the cleanup dependency is available and converges.
   */
  private async cleanupPluginWorkloadSdkOrThrow(
    recipeName: string,
    options: { preserveWorkflowRuntime?: boolean } = {}
  ): Promise<void> {
    if (!this.workflowReconciler) {
      throw new Error('workflow subsystem is not initialized; SDK cleanup cannot be confirmed')
    }
    await this.workflowReconciler.cleanupPluginWorkloadSdk(recipeName, options)
  }

  private async waitForTransportNetworkReadiness(
    recipe: WorkflowRecipeCRD,
    preDeployedServers: string[],
    namespace: string
  ): Promise<void> {
    if (preDeployedServers.length === 0) return

    const externalEgressServers = new Set(externalEgressMcpServerNames(recipe))
    const externalServers = preDeployedServers.filter(name => externalEgressServers.has(name))
    const stdioServers = new Set(
      (recipe.spec.workloads ?? [])
        .filter(workload => workload.transport?.type === 'stdio')
        .map(workload => mcpServerName(recipe.metadata.name, workload.id, recipe))
    )
    const genericServers = preDeployedServers.filter(
      name => !externalEgressServers.has(name) && stdioServers.has(name)
    )

    // HTTP transport workloads without external egress are closed by default.
    // They do not wait on a child ExternalEgressReady condition because HCC
    // has no external egress policy to reconcile; their network path is limited
    // to in-cluster MCP ingress/context policies.
    if (externalServers.length > 0) {
      const result = await waitForExternalEgressReady(
        this.delegationDeps,
        externalServers,
        namespace
      )
      if (!result.ready) {
        throw externalEgressReadinessError(recipe.metadata.name, result)
      }
      this.assertClusterEnforcesExternalEgress(recipe, 'HCC egress policies are ready')
    }

    if (genericServers.length > 0) {
      const { ready, pending } = await waitForNetworkReady(
        this.delegationDeps,
        genericServers,
        namespace
      )
      if (!ready) {
        console.warn(
          `[WR-Reconciler] Generic network readiness not confirmed for: ${pending.join(', ')}`
        )
      }
    }
  }

  private assertClusterEnforcesExternalEgress(
    recipe: WorkflowRecipeCRD,
    policyReadiness: string
  ): void {
    if (
      this.config.networkPolicyEnforcementMode === 'required' &&
      !this.config.networkPolicyEnforcementConfirmed
    ) {
      throw clusterNetworkPolicyEnforcementError(recipe.metadata.name)
    }
    if (this.config.networkPolicyEnforcementMode === 'warn') {
      console.warn(
        `[WR-Reconciler] NetworkPolicy enforcement mode is "warn" for recipe "${recipe.metadata.name}". ${policyReadiness}, but packet-level cluster enforcement must still be validated before treating this as a security gate.`
      )
    }
  }

  private async workflowRuntimeScopeRecipeName(recipe: WorkflowRecipeCRD): Promise<string> {
    const parentLabel = recipe.metadata.labels?.[PARENT_RECIPE_LABEL]?.trim()
    const workflowRunId = recipe.metadata.labels?.[WORKFLOW_RUN_ID_LABEL]?.trim()
    const ownerRecipe = recipe.metadata.ownerReferences?.find(
      ref =>
        ref.apiVersion === `${CRD_GROUP}/${CRD_VERSION}` &&
        ref.kind === 'WorkflowRecipe' &&
        ref.controller === true &&
        typeof ref.name === 'string' &&
        typeof ref.uid === 'string' &&
        ref.name.trim().length > 0
    )
    const ownerRecipeName = ownerRecipe?.name?.trim()
    const ownerRecipeUid = ownerRecipe?.uid?.trim()

    if (ownerRecipeName && ownerRecipeUid) {
      if (
        !workflowRunId ||
        !parentLabel ||
        parentLabel !== ownerRecipeName ||
        recipe.metadata.annotations?.[INHERITED_PARENT_RESOURCES_ANNOTATION] !== 'true'
      ) {
        console.warn(
          `[WR-Reconciler] Ignoring controller ownerReference "${ownerRecipeName}" on workflow "${recipe.metadata.name}" because normal DB-run inheritance metadata is incomplete or inconsistent`
        )
        return recipe.metadata.name
      }

      const verifiedOwnerRecipeName = await this.verifyControllerOwnerRecipe(
        recipe,
        ownerRecipeName,
        ownerRecipeUid
      )
      if (!verifiedOwnerRecipeName) {
        if (parentLabel) {
          console.warn(
            `[WR-Reconciler] Ignoring ${PARENT_RECIPE_LABEL}="${parentLabel}" on workflow "${recipe.metadata.name}" because controller ownerReference "${ownerRecipeName}" could not be verified`
          )
        }
        return recipe.metadata.name
      }

      try {
        const provenance = await this.verifyWorkflowRunProvenance({
          runId: workflowRunId,
          parentNamespace: recipe.metadata.namespace,
          parentName: ownerRecipeName,
          childNamespace: recipe.metadata.namespace,
          childName: recipe.metadata.name,
        })
        if (provenance === 'pending') {
          throw new RuntimeScopeResolutionPendingError(
            `workflow_runs binding for run "${workflowRunId}" is still pending`
          )
        }
        if (provenance === 'invalid') {
          console.warn(
            `[WR-Reconciler] Ignoring controller ownerReference "${ownerRecipeName}" on workflow "${recipe.metadata.name}" because workflow_runs does not bind run "${workflowRunId}" to this exact parent and child`
          )
          return recipe.metadata.name
        }
      } catch (error) {
        if (error instanceof RuntimeScopeResolutionPendingError) throw error
        console.warn(
          `[WR-Reconciler] Deferring runtime scope resolution for workflow "${recipe.metadata.name}" because DB-run provenance is temporarily unavailable:`,
          error
        )
        throw new RuntimeScopeResolutionPendingError(
          `DB-run provenance is temporarily unavailable for workflow "${recipe.metadata.name}"`,
          { cause: error }
        )
      }

      return verifiedOwnerRecipeName
    }

    if (parentLabel) {
      console.warn(
        `[WR-Reconciler] Ignoring ${PARENT_RECIPE_LABEL}="${parentLabel}" on workflow "${recipe.metadata.name}" because no controller WorkflowRecipe ownerReference is present`
      )
    }
    return recipe.metadata.name
  }

  private claimedCodexParent(recipe: WorkflowRecipeCRD): boolean {
    const parentLabel = recipe.metadata.labels?.[PARENT_RECIPE_LABEL]?.trim()
    const ownerRef = recipe.metadata.ownerReferences?.some(
      ref =>
        ref.kind === 'WorkflowRecipe' &&
        ref.controller === true &&
        typeof ref.name === 'string' &&
        ref.name.trim().length > 0
    )
    return Boolean(parentLabel || ownerRef)
  }

  private async loadCodexParent(
    recipe: WorkflowRecipeCRD,
    runtimeScopeRecipeName: string
  ): Promise<{ spec: WorkflowRecipeSpec | null; annotations?: Record<string, string> }> {
    if (runtimeScopeRecipeName === recipe.metadata.name) return { spec: null }
    try {
      const live = (await this.customApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: recipe.metadata.namespace,
        plural: WORKFLOWRECIPE_PLURAL,
        name: runtimeScopeRecipeName,
      })) as { metadata?: { annotations?: Record<string, string> }; spec?: WorkflowRecipeSpec }
      return { spec: live.spec ?? null, annotations: live.metadata?.annotations }
    } catch {
      return { spec: null }
    }
  }

  private async bindCodexReconcileContext(
    recipe: WorkflowRecipeCRD,
    runtimeScopeRecipeName: string
  ): Promise<void> {
    const setter = this.workflowReconciler?.setCodexReconcileContext
    if (typeof setter !== 'function') return
    const parent = await this.loadCodexParent(recipe, runtimeScopeRecipeName)
    // The Codex grant (connection key) follows the same authority rule as the
    // Codex spec: the runtime-scope parent's annotation when inherited, the
    // recipe's own annotation when standalone. Missing/unreadable annotations
    // resolve to the fail-closed `unassigned` sentinel inside the reader.
    const recipeUid = recipe.metadata.uid?.trim()
    // No Kubernetes uid yet → skip bind. Miss stays fail-closed `unassigned`;
    // never key the Map by recipe name.
    if (!recipeUid) return
    const grantAnnotations =
      runtimeScopeRecipeName !== recipe.metadata.name
        ? parent.annotations
        : recipe.metadata.annotations
    setter.call(this.workflowReconciler, {
      recipeUid,
      recipeName: recipe.metadata.name,
      runtimeScopeRecipeName,
      claimedParent: this.claimedCodexParent(recipe),
      parentSpec: parent.spec,
      connectionKey: readRecipeCodexConnectionRef(grantAnnotations),
    })
  }

  private async hasVerifiedInheritedParentResources(recipe: WorkflowRecipeCRD): Promise<boolean> {
    if (!declaresInheritedParentResources(recipe)) return false
    const parentName = recipe.metadata.labels?.[PARENT_RECIPE_LABEL]?.trim()
    const ownerRecipe = recipe.metadata.ownerReferences?.find(
      ref =>
        ref.apiVersion === `${CRD_GROUP}/${CRD_VERSION}` &&
        ref.kind === 'WorkflowRecipe' &&
        ref.controller === true &&
        ref.name === parentName &&
        typeof ref.uid === 'string' &&
        ref.uid.trim().length > 0
    )
    if (!parentName || parentName === recipe.metadata.name || !ownerRecipe?.uid) return false
    const verifiedOwner = await this.verifyControllerOwnerRecipe(
      recipe,
      parentName,
      ownerRecipe.uid.trim()
    )
    return verifiedOwner === parentName
  }

  private workflowAwaitsTriggeredRun(recipe: WorkflowRecipeCRD): boolean {
    const workflowRunId = recipe.metadata.labels?.[WORKFLOW_RUN_ID_LABEL]?.trim()
    const runtime = deriveWorkflowRuntimePlan(recipe.spec, {
      recipeName: recipe.metadata.name,
      workflowRunId,
      pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
    })
    return runtime.mcpHost.required && !workflowRunId
  }

  private async verifyControllerOwnerRecipe(
    recipe: WorkflowRecipeCRD,
    ownerRecipeName: string,
    ownerRecipeUid: string
  ): Promise<string | null> {
    try {
      const liveOwner = (await this.customApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: recipe.metadata.namespace,
        plural: WORKFLOWRECIPE_PLURAL,
        name: ownerRecipeName,
      })) as {
        metadata?: { uid?: string; deletionTimestamp?: string }
      }

      const liveOwnerUid = liveOwner.metadata?.uid
      if (liveOwner.metadata?.deletionTimestamp) {
        console.warn(
          `[WR-Reconciler] Ignoring controller ownerReference "${ownerRecipeName}" on workflow "${recipe.metadata.name}" because the owner is deleting`
        )
        return null
      }
      if (liveOwnerUid !== ownerRecipeUid) {
        console.warn(
          `[WR-Reconciler] Ignoring controller ownerReference "${ownerRecipeName}" on workflow "${recipe.metadata.name}" because owner UID did not match the live WorkflowRecipe`
        )
        return null
      }
      return ownerRecipeName
    } catch (error) {
      const code = getErrorCode(error)
      if (code === 404) {
        console.warn(
          `[WR-Reconciler] Ignoring controller ownerReference "${ownerRecipeName}" on workflow "${recipe.metadata.name}" because the owner WorkflowRecipe was not found`
        )
        return null
      }
      console.warn(
        `[WR-Reconciler] Deferring runtime scope resolution for workflow "${recipe.metadata.name}" because the owner WorkflowRecipe is temporarily unavailable:`,
        error
      )
      throw new RuntimeScopeResolutionPendingError(
        `Owner WorkflowRecipe "${ownerRecipeName}" is temporarily unavailable`,
        { cause: error }
      )
    }
  }

  private async ensureSteadyWorkflowRuntimeCredentials(
    recipe: WorkflowRecipeCRD,
    resolvedRuntimeScopeRecipeName?: string
  ): Promise<void> {
    if (!this.workflowReconciler) return
    const runtimeScopeRecipeName =
      resolvedRuntimeScopeRecipeName ?? (await this.workflowRuntimeScopeRecipeName(recipe))
    await this.bindCodexReconcileContext(recipe, runtimeScopeRecipeName)
    const coordinatorRefresher = this.workflowReconciler as WorkflowReconciler & {
      ensureCoordinatorRuntimeCredentials?: (
        recipeNamespace: string,
        recipeName: string,
        spec: WorkflowRecipeCRD['spec'],
        runtimeScopeRecipeName?: string
      ) => Promise<void>
    }
    try {
      await coordinatorRefresher.ensureCoordinatorRuntimeCredentials?.(
        recipe.metadata.namespace,
        recipe.metadata.name,
        recipe.spec,
        runtimeScopeRecipeName
      )
    } catch (error) {
      console.error(
        `[WR-Reconciler] Failed to repair coordinator runtime credentials for steady-state workflow "${recipe.metadata.name}"; continuing without phase change:`,
        error
      )
    }
    try {
      await this.workflowReconciler.ensureMcpHostRuntimeCredentials(
        recipe.metadata.namespace,
        recipe.metadata.name,
        recipe.spec,
        runtimeScopeRecipeName,
        recipe.metadata.uid
      )
    } catch (error) {
      console.error(
        `[WR-Reconciler] Failed to repair mcpHost runtime credentials for steady-state workflow "${recipe.metadata.name}"; continuing without phase change:`,
        error
      )
    }
    try {
      await this.workflowReconciler.refreshRuntimeHttpEgressNetworkPolicies(
        recipe.metadata.namespace,
        recipe.metadata.name,
        recipe.metadata.uid ?? recipe.metadata.name,
        recipe.spec,
        runtimeScopeRecipeName
      )
    } catch (error) {
      console.error(
        `[WR-Reconciler] Failed to refresh runtime HTTP egress for steady-state workflow "${recipe.metadata.name}"; keeping last valid NetworkPolicy:`,
        error
      )
    }
  }

  async refreshInProgressWorkflowRuntimeCredentials(recipe: WorkflowRecipeCRD): Promise<void> {
    const isWorkflow = (recipe.spec.steps ?? []).length > 0
    const workflowPhase = recipe.status?.workflowExecution?.phase
    const workflowInProgress =
      workflowPhase === 'initializing' ||
      workflowPhase === 'running' ||
      workflowPhase === 'recovering'

    if (!isWorkflow || !workflowInProgress || recipe.metadata.deletionTimestamp) return

    await this.ensureSteadyWorkflowRuntimeCredentials(recipe)
  }

  private staleRecipeResult(recipe: WorkflowRecipeCRD, stage: string): ReconcileResult {
    console.warn(
      `[WR-Reconciler] Skipping stale reconcile for "${recipe.metadata.name}" at ${stage}; recipe is gone or deleting`
    )
    return {
      phase: recipe.status?.phase ?? 'candidate',
      message: `Recipe deleted during reconcile; skipped ${stage}`,
      workloadStatuses: [],
      skipStatusPatch: true,
    }
  }

  private async recipeStillActive(recipe: WorkflowRecipeCRD): Promise<boolean> {
    if (recipe.metadata.deletionTimestamp) return false

    try {
      const live = (await this.customApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: recipe.metadata.namespace,
        plural: WORKFLOWRECIPE_PLURAL,
        name: recipe.metadata.name,
      })) as { metadata?: { uid?: string; deletionTimestamp?: string } }

      const liveUid = live.metadata?.uid
      if (recipe.metadata.uid && liveUid && recipe.metadata.uid !== liveUid) return false
      return !live.metadata?.deletionTimestamp
    } catch (error) {
      if (getErrorCode(error) === 404) return false
      throw error
    }
  }

  async isRecipeStillActive(recipe: WorkflowRecipeCRD): Promise<boolean> {
    return this.recipeStillActive(recipe)
  }

  // ─── Namespace Resolution ────────────────────────────────────────

  /**
   * WorkflowRecipe CRDs always live in sandbox-recipes. Three-way split for
   * the workloads themselves:
   *   - `transport` set                          → mcp-server  (MCP server)
   *   - referenced by spec.ui.workloadRef        → sandbox-ui  (UI workload)
   *   - otherwise                                → sandbox-recipes
   *
   * `uiWorkloadId` is the value of `recipe.spec.ui?.workloadRef` for the
   * recipe being reconciled, or undefined when the recipe has no `ui` block.
   * Pass it explicitly so this method stays pure (no recipe lookup).
   */
  private resolveWorkloadNamespace(workload: WorkloadDef, uiWorkloadId?: string): string {
    if (workload.transport) return this.config.namespace
    if (uiWorkloadId && workload.id === uiWorkloadId) return this.config.sandboxUiNamespace
    return this.config.sandboxNamespace
  }

  /** Resources follow the namespace of the workload that mounts them. */
  private resolveResourceNamespace(
    resource: ResourceDef,
    workloads: WorkloadDef[],
    uiWorkloadId?: string
  ): string {
    for (const w of workloads) {
      if (w.volumeMounts?.some(vm => vm.name === resource.id)) {
        return this.resolveWorkloadNamespace(w, uiWorkloadId)
      }
    }
    return this.config.sandboxNamespace // not mounted -> recipe/runtime namespace
  }

  /**
   * Adjust manifest namespace; remove ownerRef for cross-namespace resources.
   *
   * K8s garbage-collects any object whose ownerRef points to a resource in a
   * DIFFERENT namespace (cross-namespace ownerRefs are invalid per API spec
   * and surface as `OwnerRefInvalidNamespace` warnings before GC sweeps the
   * object). WorkflowRecipe CRDs are always in `sandbox-recipes`; transport
   * children may be in `mcp-server`, so the authoritative namespace is the
   * CRD namespace, not the transport namespace.
   *
   * Reference namespace is taken from `recipe.metadata.namespace` — the CRD's
   * actual home. When `targetNs` matches it, the ownerRef is same-namespace
   * and safe to keep; otherwise we strip it and rely on label-based cleanup
   * in `reconcileDelete`.
   */
  private adjustManifestNamespace(
    manifest: { metadata?: { namespace?: string; ownerReferences?: k8s.V1OwnerReference[] } },
    targetNs: string,
    recipeNamespace: string
  ): void {
    if (manifest.metadata) {
      manifest.metadata.namespace = targetNs
      if (targetNs !== recipeNamespace && manifest.metadata.ownerReferences) {
        delete manifest.metadata.ownerReferences
      }
    }
  }

  // ─── Finalizer ──────────────────────────────────────────────────

  async ensureFinalizer(recipe: WorkflowRecipeCRD): Promise<void> {
    const finalizers = recipe.metadata.finalizers ?? []
    if (finalizers.includes(FINALIZER)) return

    const patch =
      finalizers.length === 0
        ? [{ op: 'add' as const, path: '/metadata/finalizers', value: [FINALIZER] }]
        : [{ op: 'add' as const, path: '/metadata/finalizers/-', value: FINALIZER }]

    await this.customApi.patchNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: recipe.metadata.namespace,
      plural: WORKFLOWRECIPE_PLURAL,
      name: recipe.metadata.name,
      body: patch,
    })
    console.log(`[WR-Reconciler] Added finalizer to "${recipe.metadata.name}"`)
  }

  async removeFinalizer(recipe: WorkflowRecipeCRD): Promise<void> {
    const finalizers = recipe.metadata.finalizers ?? []
    const idx = finalizers.indexOf(FINALIZER)
    if (idx < 0) return

    try {
      await this.customApi.patchNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: recipe.metadata.namespace,
        plural: WORKFLOWRECIPE_PLURAL,
        name: recipe.metadata.name,
        body: [{ op: 'remove' as const, path: `/metadata/finalizers/${idx}` }],
      })
    } catch (error) {
      if (getErrorCode(error) === 404) {
        console.warn(
          `[WR-Reconciler] Finalizer already gone for "${recipe.metadata.name}" because the recipe no longer exists`
        )
        return
      }
      throw error
    }
    console.log(`[WR-Reconciler] Removed finalizer from "${recipe.metadata.name}"`)
  }

  // ─── Main Pipeline ────────────────────────────────────────────────

  async reconcile(recipe: WorkflowRecipeCRD): Promise<ReconcileResult> {
    // issue #375: compute the Plugin Workload SDK capability projection ONCE per
    // reconcile and attach it to the result. shouldPatchRecipeStatus reads it to
    // publish a computed awaiting_policy↔validated transition that no
    // phase/message/workload diff would otherwise surface; patchStatus reuses
    // the same object instead of rebuilding it. Paths that bypass this method
    // (e.g. observeCurrentWorkloadStatus) leave the projection undefined, which
    // both consumers treat as "no SDK opinion this pass".
    const result = await this.reconcileInternal(recipe)
    result.pluginWorkloadSdkProjection = this.projectPluginWorkloadSdk(recipe, result)
    return result
  }

  private async reconcileInternal(recipe: WorkflowRecipeCRD): Promise<ReconcileResult> {
    const name = recipe.metadata.name
    const ns = recipe.metadata.namespace
    const currentPhase = recipe.status?.phase ?? 'candidate'
    let sdkOnlyProviderUnavailable = false

    // Defense-in-depth: the VAP + admin-API already enforce this invariant,
    // but a manually-applied CRD in another namespace must not be reconciled.
    const allowedNamespaces = [this.config.sandboxNamespace]
    if (!allowedNamespaces.includes(ns)) {
      console.warn(
        `[WR-Reconciler] Refusing to reconcile "${name}" — namespace "${ns}" is not in allowlist (${allowedNamespaces.join(', ')}). This recipe bypassed the admission layer; leaving untouched.`
      )
      return {
        phase: 'failed',
        message: `Namespace "${ns}" outside allowlist [${allowedNamespaces.join(', ')}]`,
        workloadStatuses: [],
        skipStatusPatch: true,
      }
    }

    console.log(
      `[WR-Reconciler] Reconciling "${name}" in namespace "${ns}" (phase: ${currentPhase})`
    )

    if (!(await this.recipeStillActive(recipe))) {
      return this.staleRecipeResult(recipe, 'initial check')
    }

    const isWorkflow = recipe.spec.steps !== undefined && recipe.spec.steps.length > 0
    // The feature flag is a kill switch for SDK-only runtimes. Reconcile this
    // before the non-deployable phase guard so a previously-created host cannot
    // remain reachable merely because the recipe was already latched failed.
    // Workflow recipes keep their normal mcp-host lifecycle; this cleanup is
    // intentionally restricted to the stepless adapter.
    if (!isWorkflow && recipe.spec.pluginWorkloadSdk && !this.config.pluginWorkloadSdkEnabled) {
      try {
        await this.cleanupPluginWorkloadSdkOrThrow(name, {
          preserveWorkflowRuntime: isWorkflow,
        })
      } catch (error) {
        return {
          phase: 'failed' as RecipePhase,
          message: `Plugin Workload SDK teardown failed while the feature flag is disabled: ${String(error)}`,
          workloadStatuses: [],
          skipStatusPatch: true,
          requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
        }
      }
      return {
        phase: currentPhase,
        message: 'Plugin Workload SDK disabled after confirmed teardown',
        workloadStatuses: [],
        pluginWorkloadSdkTeardownConfirmed: true,
      }
    }
    if (isWorkflow) {
      // Revocation must precede spec/policy validation: an invalid edit that also
      // removes publishTargets must still close the previously opened lane.
      await this.revokeCoordinatorGfsNetworkPolicyIfDisabled(recipe)
    }

    // Capability removal is independent from workflow phase. Do this before
    // terminal-phase short-circuiting so a failed/deprecated/rollback-failed
    // recipe cannot retain SDK authority after the operator removes the block.
    // The durable status marker is cleared by the following status projection
    // only after this fail-closed cleanup succeeds.
    if (!recipe.spec.pluginWorkloadSdk && recipe.status?.pluginWorkloadSdk) {
      try {
        await this.cleanupPluginWorkloadSdkOrThrow(name, {
          preserveWorkflowRuntime: isWorkflow,
        })
      } catch (error) {
        return {
          phase: 'failed' as RecipePhase,
          message: `Plugin Workload SDK teardown failed after capability removal: ${String(error)}`,
          workloadStatuses: [],
          skipStatusPatch: true,
          requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
        }
      }
    }

    const limitError = validateWorkflowRecipeLimits(recipe.spec, this.config)
    if (limitError) {
      if (isWorkflow) await this.revokeCoordinatorGfsNetworkPolicy(recipe)
      return {
        phase: 'failed' as RecipePhase,
        message: limitError,
        workloadStatuses: [],
      }
    }

    // ─── Policy enforcement (BLOCKING) — runs FIRST so agentic workflows
    // are also gated. Previously this lived after the isWorkflow branch and
    // was only applied to classic MCP stacks, letting agentic workflows
    // bypass the contextRef default-deny policy. The idempotency guard
    // (alreadyPolicyFailed) prevents reconcile-thrash when a persistent
    // violation is re-evaluated on every reconcile pass.
    const alreadyPolicyFailed =
      currentPhase === 'failed' && recipe.status?.message?.startsWith('Policy violation:')
    if (!isTerminal(currentPhase as RecipePhase) && !alreadyPolicyFailed) {
      const policies = await listWorkflowRecipePolicies(this.customApi, ns)
      const violations = enforcePolicy(recipe, policies)
      if (violations.length > 0) {
        if (isWorkflow) await this.revokeCoordinatorGfsNetworkPolicy(recipe)
        const details = violations.map(v => `[${v.policy}] ${v.rule}: ${v.message}`).join('; ')
        console.error(`[WR-Reconciler] Policy violation for "${name}": ${details}`)
        return {
          phase: 'failed',
          message: `Policy violation: ${details}`,
          workloadStatuses: [],
        }
      }
    }

    // ─── Transient-latch detection (workload AND workflow) ───────────────
    // Computed HERE, before the workflow terminal guard below, so a workflow
    // latched `failed` by a transient blip can self-heal instead of having the
    // terminal guard re-confirm the stale failure. For a workflow the real
    // error is on the inner `workflowExecution.message` (the top-level message
    // is just "Workflow failed"), so we check BOTH messages.
    //
    // SECURITY: never self-heal a recipe that failed policy enforcement. Its
    // `status.message` ("Policy violation: …") embeds operator-controlled
    // workload fields verbatim; combined with the `alreadyPolicyFailed`
    // idempotency guard above, self-healing one would deploy a policy-rejected
    // workload. Policy failures stay terminal until the spec is fixed (which
    // re-arms enforcement). The classifier is also anchored to transport-error
    // shapes (see isRetryableInfraError) so an embedded token can't match.
    const latchedByTransientError =
      currentPhase === 'failed' &&
      !recipe.status?.message?.startsWith('Policy violation:') &&
      (isRetryableInfraError(recipe.status?.message) ||
        isRetryableInfraError(recipe.status?.workflowExecution?.message))

    // ─── Workflow Detection — must come BEFORE non-deployable guard ────
    // Workflow recipes have their own lifecycle managed by the coordinator Pod.
    // The recipe.phase must be derived from workflowExecution.phase, NOT the
    // reconcile loop. This prevents the fundamental conflict between the WRC
    // reconciler (which patches recipe.phase) and the coordinator (which patches
    // workflowExecution.phase and steps[]) — two concurrent writers on the same CRD.
    if (isWorkflow) {
      const stepLimitError = this.validateWorkflowStepLimit(recipe)
      if (stepLimitError) {
        await this.revokeCoordinatorGfsNetworkPolicy(recipe)
        return {
          phase: 'failed',
          message: stepLimitError,
          workloadStatuses: [],
        }
      }
      // ─── Workflow Phase Mapping ──────────────────────────────────────
      // Map recipe.phase directly from workflowExecution.phase.
      // This is the ONLY place where recipe.phase is determined for workflows.
      // The coordinator owns the workflow lifecycle; the reconciler only creates infrastructure.
      const wfExecPhase = recipe.status?.workflowExecution?.phase
      const awaitsTriggeredRun = this.workflowAwaitsTriggeredRun(recipe)
      const wfTerminal =
        wfExecPhase === 'completed' || wfExecPhase === 'failed' || wfExecPhase === 'cancelled'
      const wfInProgress =
        wfExecPhase === 'initializing' || wfExecPhase === 'running' || wfExecPhase === 'recovering'

      const workflowWorkloads = recipe.spec.workloads ?? []
      const policyPreflight = this.buildWorkflowRuntimeSpec(recipe)
      const policyPreflightError = this.workflowReconciler?.validateWorkflowSpec?.(
        policyPreflight.workflowRuntimeSpec
      )
      const coordinatorGfsPolicyCanOpen =
        this.workflowReconciler !== undefined &&
        !recipe.spec.dryRun &&
        !alreadyPolicyFailed &&
        !policyPreflight.unresolvedMcpServerMessage &&
        !policyPreflightError
      if ((recipe.spec.gfs?.publishTargets ?? []).length > 0 && !coordinatorGfsPolicyCanOpen) {
        await this.revokeCoordinatorGfsNetworkPolicy(recipe)
      }

      let approvalScopeRecipeName: string
      try {
        // Resolve provenance before any workflow-side mutation. A pending DB
        // binding or transient DB/Kubernetes lookup must never mint credentials
        // or create resources under the child fallback identity.
        approvalScopeRecipeName = await this.workflowRuntimeScopeRecipeName(recipe)
      } catch (error) {
        if (!(error instanceof RuntimeScopeResolutionPendingError)) throw error
        console.warn(
          `[WR-Reconciler] Runtime scope resolution pending for workflow "${name}"; keeping current state and requeueing:`,
          error
        )
        return {
          phase: currentPhase as RecipePhase,
          message: recipe.status?.message ?? '',
          workloadStatuses: (recipe.status?.workloads ?? []).map(workload => ({
            id: workload.id,
            phase: workload.phase,
            ready: workload.ready ?? false,
            message: workload.message,
          })),
          skipStatusPatch: true,
          requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
        }
      }

      if (currentPhase === 'active' && awaitsTriggeredRun && !wfExecPhase) {
        // Plugin Workload SDK recipes (BOTH families) keep an eager mcp-host and
        // must fall through to the inner reconcile: promptBridge so
        // ensureEagerSdkMcpHost retries the /configure (the short-circuit below
        // would freeze it provider_unavailable forever), and clientNotifications-
        // only so the reconcile re-gathers the bootstrap proof and recomputes the
        // capability projection (issue #375 jozer BLOCKER: short-circuiting here
        // returned skipStatusPatch:true, so a computed awaiting_policy→validated
        // transition was never published for that family). The Step 8 ownership
        // gate inside the inner reconcile covers Secret-ownership revocation on
        // the fall-through path, exactly as it already did for promptBridge.
        if (!recipe.spec.pluginWorkloadSdk) {
          if (coordinatorGfsPolicyCanOpen) {
            await this.ensureCoordinatorGfsNetworkPolicyIfEnabled(recipe)
          }
          // Issue #637 — this awaiting-trigger short-circuit also returns before the
          // Step 8 ownership gate, yet the recipe's envSecret/imagePullSecrets
          // workloads were already deployed on the first-deploy pass. Enforce
          // revocation (teardown only, no redeploy) so a mid-life re-label is honored
          // even while the workflow idles awaiting its trigger.
          const awaitOwnership = await this.revokeOrRequeueSteadyWorkflow(recipe, 'active')
          if (awaitOwnership) return awaitOwnership
          return {
            phase: 'active' as RecipePhase,
            message: recipe.status?.message ?? 'Workflow trigger infrastructure registered',
            workloadStatuses: [],
            skipStatusPatch: true,
          }
        }
      }

      // Terminal workflow → derive recipe phase and stop reconciling.
      // EXCEPTION: a workflow latched `failed` by a transient infra blip (the
      // error lives on workflowExecution.message) must NOT be re-confirmed here
      // — fall through to the recovery handoff below so the run is retried.
      if (wfTerminal && !awaitsTriggeredRun && !latchedByTransientError) {
        if (wfExecPhase === 'completed' && coordinatorGfsPolicyCanOpen) {
          await this.ensureCoordinatorGfsNetworkPolicyIfEnabled(recipe)
        } else {
          await this.revokeCoordinatorGfsNetworkPolicy(recipe)
        }
        const derivedPhase: RecipePhase = wfExecPhase === 'completed' ? 'active' : 'failed'
        const derivedMessage = `Workflow ${wfExecPhase}`
        if (wfExecPhase === 'completed') {
          await this.ensureSteadyWorkflowRuntimeCredentials(recipe, approvalScopeRecipeName)
        }
        // Free a terminal run's COMPUTE pods promptly (mcp-host, coordinator,
        // snippet-runner, and any cross-namespace transport/MCP-server such as
        // web-search). Previously these lingered Running until the control-api
        // archive-cron deleted the run-scoped CR at its TTL (default 30 days),
        // starving the cluster of CPU and causing FailedScheduling on new runs.
        // PRESERVE the artifact-reader pod, the workflow-output PVC, the
        // run-scoped CR, and the DB run history so /output artifacts stay
        // downloadable until the archive-cron deletes the CR.
        await this.teardownTerminalRunComputeIfRunScoped(recipe)
        // Issue #637 — a terminal (completed/failed/cancelled) workflow that is NOT
        // run-scoped keeps its steady envSecret/imagePullSecrets workloads. Enforce
        // revocation on a mid-life re-label here too (run-scoped compute is already
        // torn down above; this teardown is idempotent/404-tolerant).
        const terminalOwnership = await this.revokeOrRequeueSteadyWorkflow(recipe, derivedPhase)
        if (terminalOwnership) return terminalOwnership
        // The recipe phase may remain active across running -> completed. Still
        // patch once if the top-level message is stale so UIs do not show a
        // completed execution as still running.
        if (currentPhase === derivedPhase) {
          return {
            phase: derivedPhase,
            message: derivedMessage,
            workloadStatuses: [],
            skipStatusPatch: recipe.status?.message === derivedMessage,
          }
        }
        console.log(
          `[WR-Reconciler] Workflow "${name}" ${wfExecPhase} — transitioning recipe phase: ${currentPhase} → ${derivedPhase}`
        )
        return { phase: derivedPhase, message: derivedMessage, workloadStatuses: [] }
      }

      if (!this.workflowReconciler) {
        return {
          phase: 'failed',
          message: 'Workflow subsystem not initialized — missing clerum-wrc-signing-key',
          workloadStatuses: [],
        }
      }

      // In-progress workflow with infrastructure already created → skip reconcile to avoid
      // starving the coordinator of 409-free windows.
      // EXCEPTION: "initializing" and "recovering" phases mean pods may not exist yet,
      // may be broken (e.g. CreateContainerConfigError), or were just deleted by crash
      // recovery. We MUST reconcile to allow infrastructure creation to complete.
      if (wfInProgress && (currentPhase === 'deploying' || currentPhase === 'failed')) {
        if (wfExecPhase === 'initializing' || wfExecPhase === 'recovering') {
          console.log(
            `[WR-Reconciler] Workflow "${name}" ${wfExecPhase} — allowing reconcile for pod creation`
          )
          // Fall through to WorkflowReconciler.reconcile() which will create/recreate pods
        } else {
          if (coordinatorGfsPolicyCanOpen) {
            await this.ensureCoordinatorGfsNetworkPolicyIfEnabled(recipe)
          }
          console.log(
            `[WR-Reconciler] Workflow "${name}" in-progress (wf: ${wfExecPhase}) — skipping reconcile`
          )
          await this.ensureSteadyWorkflowRuntimeCredentials(recipe, approvalScopeRecipeName)
          // Issue #637 — same revocation enforcement as the active short-circuit
          // below: a re-labeled Secret on an in-progress workflow must tear down the
          // affected workload(s) even though we skip the full reconcile here.
          const inProgressOwnership = await this.revokeOrRequeueSteadyWorkflow(
            recipe,
            (wfExecPhase === 'running' ? 'active' : currentPhase) as RecipePhase
          )
          if (inProgressOwnership) return inProgressOwnership
          const derivedPhase: RecipePhase = wfExecPhase === 'running' ? 'active' : currentPhase
          return {
            phase: derivedPhase,
            message: `Workflow ${wfExecPhase}`,
            workloadStatuses: [],
            skipStatusPatch: currentPhase === derivedPhase,
          }
        }
      }

      // "active" covers both completed workflow infrastructure and an already-active
      // recipe whose current execution is still running.
      if (currentPhase === 'active' && !awaitsTriggeredRun) {
        if (coordinatorGfsPolicyCanOpen) {
          await this.ensureCoordinatorGfsNetworkPolicyIfEnabled(recipe)
        }
        await this.ensureSteadyWorkflowRuntimeCredentials(recipe, approvalScopeRecipeName)
        // Issue #637 — this short-circuit runs BEFORE the Step 8 ownership gate to
        // protect the coordinator 409-window. Enforce Secret-ownership revocation on
        // the active workload(s) (teardown only, no redeploy) and re-seed the
        // SecretReverseIndex for restart durability. Surface the denial so the
        // operator re-labels the Secret.
        const activeOwnership = await this.revokeOrRequeueSteadyWorkflow(recipe, 'active')
        if (activeOwnership) return activeOwnership
        // issue #375 (jozer BLOCKER): Plugin Workload SDK recipes fall through to
        // the inner reconcile (mirroring the awaiting-trigger carve-out above) so
        // the bootstrap proof is re-gathered and a computed capability transition
        // (e.g. awaiting_policy→validated) is actually published — this
        // short-circuit's skipStatusPatch:true suppressed it unconditionally.
        // The gfs/credentials/ownership enforcement above has already run.
        // EXCEPTION: while a workflow execution is in progress the short-circuit
        // is kept even for SDK recipes — this branch exists to protect the
        // coordinator's 409-free windows, and the capability publication is
        // level-triggered (requeue + watchdog) so it lands on the next
        // non-running pass.
        if (!recipe.spec.pluginWorkloadSdk || wfInProgress) {
          return {
            phase: 'active' as RecipePhase,
            message: wfExecPhase ? `Workflow ${wfExecPhase}` : 'Workflow completed',
            workloadStatuses: [],
            skipStatusPatch: true,
          }
        }
      }

      // ─── First-time infrastructure creation ──────────────────────────
      // Only reaches here on first deploy (candidate phase) or when no wfExecPhase yet.
      // After this, the skip guards above prevent redundant reconciles.

      const workflowComputedValues = recipe.spec.computed
        ? evaluateComputedValues(recipe.spec.computed, recipe.spec.inputs ?? {})
        : undefined
      const workflowResolvedInputs = resolveInputs(
        recipe.spec.inputs ?? {},
        recipe.spec.inputContract,
        recipe.spec.profiles,
        recipe.spec.activeProfile,
        workflowComputedValues
      )

      // Assign stable resource names before workload template resolution so
      // agentic recipes use the same Service names that WRC will materialize.
      try {
        if (workflowWorkloads.length > 0) {
          await this.assignWorkloadInstances(recipe, workflowWorkloads, {
            persist: !recipe.spec.dryRun,
          })
        }
        if (recipe.spec.resources && recipe.spec.resources.length > 0) {
          await this.assignResourceInstances(recipe, recipe.spec.resources, {
            persist: !recipe.spec.dryRun,
          })
        }
      } catch (error) {
        // The resource adoption probe (legacyRawResourceExists) issues a K8s read in
        // the WORKFLOW path. A transient infra error here must requeue with backoff —
        // otherwise it propagates out of the workflow branch where the watcher
        // swallows it with no deterministic retry (issue #571).
        if (isRetryableInfraError(error)) {
          console.warn(
            `[WR-Reconciler] Transient infra error assigning instances for "${recipe.metadata.name}" — will retry: ${String(error)}`
          )
          return {
            phase: (recipe.status?.phase ?? 'deploying') as RecipePhase,
            message: recipe.status?.message ?? '',
            workloadStatuses: (recipe.status?.workloads ?? []).map(w => ({
              id: w.id,
              phase: w.phase,
              ready: w.ready ?? false,
              message: w.message,
            })),
            skipStatusPatch: true,
            requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
          }
        }
        throw error
      }

      try {
        resolveWorkloadTemplates({
          recipe,
          workloads: workflowWorkloads,
          inputs: workflowResolvedInputs,
          computed: workflowComputedValues,
          resolveNamespace: workload => this.resolveWorkloadNamespace(workload),
        })
      } catch (error) {
        if (error instanceof WorkloadTemplateResolutionError) {
          return {
            phase: 'failed' as RecipePhase,
            message: error.message,
            workloadStatuses: [],
          }
        }
        throw error
      }

      // Rebuild after instance assignment because transport Service names may
      // depend on the newly persisted workload instance mapping.
      const { workflowRuntimeSpec, unresolvedMcpServerMessage } =
        this.buildWorkflowRuntimeSpec(recipe)
      if (unresolvedMcpServerMessage) {
        return {
          phase: 'failed' as RecipePhase,
          message: unresolvedMcpServerMessage,
          workloadStatuses: [],
        }
      }
      const workflowPreflightError =
        this.workflowReconciler.validateWorkflowSpec(workflowRuntimeSpec)
      if (workflowPreflightError) {
        return {
          phase: 'failed' as RecipePhase,
          message: workflowPreflightError,
          workloadStatuses: [],
        }
      }

      if (recipe.spec.dryRun) {
        const previewWorkloads = workflowWorkloads.map(w => ({
          id: w.id,
          type: w.type,
          namespace: this.resolveWorkloadNamespace(w),
          image: w.image,
        }))
        return {
          phase: 'candidate' as RecipePhase,
          message: 'Dry-run: preview generated, no resources created',
          workloadStatuses: previewWorkloads.map(w => ({
            id: w.id,
            phase: 'preview',
            ready: false,
            message: `Would deploy ${w.type} "${w.id}" to ${w.namespace} (image: ${w.image})`,
          })),
        }
      }

      const inheritsVerifiedParentResources =
        approvalScopeRecipeName !== recipe.metadata.name && declaresInheritedParentResources(recipe)
      if (!inheritsVerifiedParentResources) {
        await this.ensureRecipeResources(recipe)
      }

      let workflowInternalDependencyConditions: StatusCondition[] | undefined
      let workflowSecretOwnershipConditions: StatusCondition[] | undefined
      let workflowWorkloadConditions: StatusCondition[] | undefined
      if (workflowWorkloads.length > 0) {
        console.log(
          `[WR-Reconciler] Deploying ${workflowWorkloads.length} workflow workload(s) for "${name}"`
        )
        try {
          const workflowDeploy = await this.deployWorkflowWorkloads(recipe, name)
          workflowInternalDependencyConditions = workflowDeploy.internalDependencyConditions
          workflowWorkloadConditions = workflowDeploy.workloadConditions
          // Issue #637 — surface the EnvSecretOwnershipDenied condition from the
          // workflow build path too; previously it was computed and dropped, so a
          // denied workflow workload degraded silently with no status condition.
          workflowSecretOwnershipConditions = workflowDeploy.secretOwnershipConditions
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const internalDependencyConditions =
            error instanceof InternalDependencyReconcileError ? error.conditions : undefined
          const workloadConditions =
            error instanceof ImmutableStatefulSetDriftError ? [error.condition] : undefined
          if (error instanceof RetryableReconcileError) {
            // Transient infra failure (e.g. DNS SERVFAIL on egress). Degrade
            // instead of failing so the next reconcile retries before the
            // workflow runs — don't mark workflowPhase failed.
            return {
              phase: 'degraded' as RecipePhase,
              message,
              workloadStatuses: [],
              internalDependencyConditions,
              workloadConditions,
            }
          }
          return {
            phase: 'failed' as RecipePhase,
            message,
            workloadStatuses: [],
            workflowPhase: 'failed',
            internalDependencyConditions,
            workloadConditions,
          }
        }
      }

      console.log(
        `[WR-Reconciler] Workflow "${name}" first deploy (${recipe.spec.steps!.length} steps) — creating infrastructure`
      )
      // Recovery handoff: when this workflow was latched `failed` by a transient
      // infra blip, hand the inner reconciler a `recovering` execution phase
      // (preserving message/steps/conditions) so it retries infrastructure
      // instead of reading the stale `failed` state and re-confirming it.
      const existingExecution = recipe.status?.workflowExecution as
        | import('../workflow/types').WorkflowExecutionStatus
        | undefined
      const inboundStatus = recipe.status
        ? {
            workflowExecution:
              latchedByTransientError && existingExecution
                ? {
                    ...existingExecution,
                    phase: 'recovering' as import('../workflow/types').WorkflowPhase,
                  }
                : existingExecution,
            steps: recipe.status.steps as import('../workflow/types').StepStatus[] | undefined,
            conditions: recipe.status.conditions,
            resourceInstances: recipe.status.resourceInstances,
          }
        : undefined
      await this.bindCodexReconcileContext(recipe, approvalScopeRecipeName)
      const result = await this.workflowReconciler.reconcile(
        name,
        recipe.metadata.uid ?? '',
        ns,
        workflowRuntimeSpec,
        inboundStatus,
        workflowResolvedInputs,
        approvalScopeRecipeName,
        recipe.metadata.labels?.[WORKFLOW_RUN_ID_LABEL],
        recipe.metadata.labels?.['clerum.io/workflow-team-id'],
        recipe.metadata.labels?.[WORKFLOW_ACTOR_ID_LABEL],
        recipe.metadata.labels?.[WORKFLOW_ACTOR_TYPE_LABEL]
      )
      if (coordinatorGfsPolicyCanOpen && !result.skipStatusPatch && result.phase !== 'failed') {
        await this.ensureCoordinatorGfsNetworkPolicyIfEnabled(recipe)
      } else if (result.phase === 'failed' || !coordinatorGfsPolicyCanOpen) {
        await this.revokeCoordinatorGfsNetworkPolicy(recipe)
      }
      return {
        phase: result.phase as RecipePhase,
        message: result.message,
        workloadStatuses: [],
        workflowPhase: result.workflowPhase,
        clearWorkflowExecution: result.clearWorkflowExecution,
        workflowConditions: result.workflowConditions,
        workloadConditions: workflowWorkloadConditions,
        pluginWorkloadSdkBootstrapProof: result.pluginWorkloadSdkBootstrapProof,
        pluginWorkloadSdkPolicyPending: result.pluginWorkloadSdkPolicyPending,
        // Thread the inner reconciler's transient-skip up so the watcher leaves
        // status untouched and requeues instead of patching a false failure.
        skipStatusPatch: result.skipStatusPatch,
        // Requeue on a timer when the workflow reconcile is either (a) a
        // transient skip, or (b) still bringing up infra (phase === 'deploying',
        // e.g. waiting on the output anchor/prepare pod). The controller watches
        // only the CR, not the Pods it creates, so a Pod reaching Succeeded
        // fires no CR MODIFIED event — without this timer the run wedges at
        // phase=deploying forever (mcp-host pod never created) and dbRunProcessor
        // logs "orphaned running run reclaimed" every reclaim tick. Terminal /
        // active / failed results keep `undefined` so steady-state does not
        // requeue.
        //
        // Priority: a transient ERROR (skipStatusPatch) wins over PROGRESS
        // (deploying). The error path keeps exponential backoff; the progress
        // path requeues at a FIXED interval (requeueFixedInterval) so a run
        // advancing through its deploying sub-phases does NOT inherit the
        // transient-error backoff curve — exponential growth there would
        // degrade the poll cadence toward the 60s cap and re-expose the 240s
        // mcp-host readiness deadline this requeue exists to beat (see §5 and
        // requeueFixedInterval doc).
        requeueAfterMs: result.skipStatusPatch
          ? TRANSIENT_REQUEUE_BASE_MS
          : result.phase === 'deploying' || result.pluginWorkloadSdkPolicyPending
            ? WORKFLOW_PROGRESS_REQUEUE_BASE_MS
            : undefined,
        requeueFixedInterval:
          !result.skipStatusPatch &&
          (result.phase === 'deploying' || result.pluginWorkloadSdkPolicyPending === true),
        internalDependencyConditions: workflowInternalDependencyConditions,
        secretOwnershipConditions: workflowSecretOwnershipConditions,
      }
    }

    // ─── Non-deployable phase guard (non-workflow recipes only) ──────
    // Workflow recipes handle their own phase mapping above.
    // Regular workload recipes in failed/deprecated/rollback-failed do not need reconciliation.
    //
    // Exception: a recipe latched into `failed` by a *transient* infra error
    // (connect ETIMEDOUT, 5xx, …) must be allowed to self-heal. Without this,
    // a momentary controller↔API blip permanently bricks a healthy recipe —
    // the watch resync fires, but this guard skips it forever. Re-running the
    // pipeline re-confirms the (already-deployed) workloads and returns the
    // recipe to `active`. Genuine failures (invalid spec, image pull, policy)
    // keep their non-retryable message and stay skipped.
    // `latchedByTransientError` (and its SECURITY rationale) is computed near
    // the top of reconcile(), before the workflow terminal guard, so both the
    // workflow path and this non-workflow guard share one definition.
    const nonDeployablePhases: RecipePhase[] = ['failed', 'deprecated', 'rollback-failed']
    // Shared mcp-server internal-dependency boundary latch: a recipe failed
    // because a referenced MCP Service is outside its eligible runtime boundary
    // self-heals once the boundary decision changes. The policy-violation
    // exclusion mirrors latchedByTransientError (defined at the top of
    // reconcile()) so a policy failure can't masquerade here either.
    const latchedBySharedMcpInternalDependencyBoundary =
      currentPhase === 'failed' &&
      !recipe.status?.message?.startsWith('Policy violation:') &&
      recipe.status?.conditions?.some(
        condition =>
          condition.type === 'InternalDependenciesReady' &&
          condition.status === 'False' &&
          condition.reason === 'InvalidInternalDependency' &&
          typeof condition.message === 'string' &&
          condition.message.includes('.mcp-server.svc.cluster.local') &&
          condition.message.includes('not an eligible runtime Service')
      )
    // Observed-health self-heal (the durable backstop): a recipe latched
    // `failed` whose LAST-OBSERVED workloads were all `ready` was healthy
    // before something flipped it terminal — e.g. a transient handshake
    // exception whose re-messaged text the isRetryableInfraError classifier
    // did not recognize (the worktracker pre-deploy incident). Rather than
    // depend on message-shape matching, derive the truth from observed state:
    // re-run the pipeline so the phase is recomputed from live workload health.
    // The re-run lands in `active` if still healthy or `degraded` if not — it
    // can only return to `failed` via a genuine early-return (bad spec, policy,
    // template error), so a real failure re-confirms itself and does not loop.
    //
    // Scope + guards:
    //   - Non-workflow recipes ONLY. For a workflow, workload readiness ≠ run
    //     success: a genuine "Workflow failed" run can have all MCP workloads
    //     ready, and must stay terminal. The workflow path keeps using
    //     latchedByTransientError (workflowExecution.message) and is handled
    //     above, before this guard.
    //   - Requires a NON-EMPTY observed workload set, so a recipe that failed
    //     before any workload was created (pre-deploy never succeeded, bad
    //     spec) is not churned — its status.workloads is empty and it stays
    //     skipped.
    //   - Excludes `Policy violation:` (security: must stay terminal, mirrors
    //     latchedByTransientError).
    const latchedDespiteHealthyWorkloads =
      currentPhase === 'failed' &&
      !isWorkflow &&
      !recipe.status?.message?.startsWith('Policy violation:') &&
      (recipe.status?.workloads?.length ?? 0) > 0 &&
      (recipe.status?.workloads ?? []).every(w => w.ready === true)
    if (latchedByTransientError) {
      console.log(
        `[WR-Reconciler] Recipe "${name}" is failed with a transient infra message — re-reconciling to self-heal`
      )
    }
    if (latchedBySharedMcpInternalDependencyBoundary) {
      console.log(
        `[WR-Reconciler] Recipe "${name}" is failed by a shared mcp-server internal-dependency boundary decision — re-reconciling to self-heal`
      )
    }
    if (latchedDespiteHealthyWorkloads) {
      console.log(
        `[WR-Reconciler] Recipe "${name}" is failed but all observed workloads are ready — re-reconciling to re-derive phase from live health`
      )
    }
    if (
      nonDeployablePhases.includes(currentPhase as RecipePhase) &&
      !latchedByTransientError &&
      !latchedBySharedMcpInternalDependencyBoundary &&
      !latchedDespiteHealthyWorkloads
    ) {
      console.log(
        `[WR-Reconciler] Skipping non-deployable recipe "${name}" (phase: ${currentPhase})`
      )
      return {
        phase: currentPhase as RecipePhase,
        message: recipe.status?.message ?? `Recipe is in ${currentPhase} state`,
        workloadStatuses: (recipe.status?.workloads ?? []).map(w => ({
          id: w.id,
          phase: w.phase,
          ready: w.ready ?? false,
          message: w.message,
        })),
      }
    }

    try {
      // Step 2: Validate spec
      this.validateSpec(recipe)

      // Step 2.5: Policy enforcement already ran at the top of reconcile()
      // so both workflow and non-workflow recipes are gated uniformly. No
      // duplicate check here.

      // Step 3: Resolve inputs (with computed values)
      const computedValues = recipe.spec.computed
        ? evaluateComputedValues(recipe.spec.computed, recipe.spec.inputs ?? {})
        : undefined
      const resolvedInputs = resolveInputs(
        recipe.spec.inputs ?? {},
        recipe.spec.inputContract,
        recipe.spec.profiles,
        recipe.spec.activeProfile,
        computedValues
      )

      // Step 3a: Filter by includeWhen before rendering Kubernetes resources.
      const filtered = filterByIncludeWhen(
        recipe.spec.workloads ?? [],
        recipe.spec.resources,
        recipe.spec.bindings,
        resolvedInputs
      )
      // Replace spec arrays with filtered versions for the rest of the pipeline
      recipe.spec.workloads = filtered.workloads
      recipe.spec.resources =
        filtered.resources.length > 0 ? filtered.resources : recipe.spec.resources
      recipe.spec.bindings = filtered.bindings.length > 0 ? filtered.bindings : undefined

      // Re-validate after filtering (all workloads may have been excluded)
      if (recipe.spec.workloads.length === 0) {
        return {
          phase: 'failed',
          message: 'All workloads excluded by includeWhen conditions',
          workloadStatuses: [],
        }
      }

      // Persist stable runtime names before template resolution so catalog
      // recipes materialize Services/StatefulSets/PVCs under recipe-scoped
      // names instead of generic workload IDs such as "db" or "api".
      await this.assignWorkloadInstances(recipe, recipe.spec.workloads, {
        persist: !recipe.spec.dryRun,
      })
      if (recipe.spec.resources && recipe.spec.resources.length > 0) {
        await this.assignResourceInstances(recipe, recipe.spec.resources, {
          persist: !recipe.spec.dryRun,
        })
      }

      // Step 4: Resolve templates in env vars, command, and args.
      try {
        resolveWorkloadTemplates({
          recipe,
          workloads: recipe.spec.workloads,
          inputs: resolvedInputs,
          computed: computedValues,
          resolveNamespace: workload =>
            this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef),
        })
      } catch (error) {
        if (error instanceof WorkloadTemplateResolutionError) {
          return {
            phase: 'failed',
            message: error.message,
            workloadStatuses: [],
          }
        }
        throw error
      }

      // Step 4a: Dry-run short-circuit.
      // Validate and resolve but do NOT create any resources.
      if (recipe.spec.dryRun) {
        const previewWorkloads = recipe.spec.workloads.map(w => ({
          id: w.id,
          type: w.type,
          namespace: this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef),
          image: w.image,
        }))
        return {
          phase: 'candidate' as RecipePhase,
          message: 'Dry-run: preview generated, no resources created',
          workloadStatuses: previewWorkloads.map(w => ({
            id: w.id,
            phase: 'preview',
            ready: false,
            message: `Would deploy ${w.type} "${w.id}" to ${w.namespace} (image: ${w.image})`,
          })),
        }
      }

      // Step 5: Sort dependencies
      const sortOrder = sortDependencies(
        recipe.spec.workloads.map(w => ({
          id: w.id,
          dependsOn: w.dependsOn ?? [],
        }))
      )

      // Step 6: Compute target phase after workloads are deployed.
      // For phases that don't support a "deploy" transition (active, deploying, degraded),
      // keep the current phase — the reconciler is just ensuring resources are up-to-date
      // after a WRC restart.
      let deployPhase: RecipePhase
      if (
        latchedByTransientError ||
        latchedBySharedMcpInternalDependencyBoundary ||
        latchedDespiteHealthyWorkloads
      ) {
        // Recovering a recipe that was latched into `failed` by a transient
        // infra blip, the historical shared mcp-server boundary bug, or an
        // unrecognized failure despite observed-healthy workloads: there is no
        // `failed --deploy--> ...` edge, so drive it straight back through the
        // deploy -> testing -> active chain below. If the workloads turn out
        // unhealthy it lands in `degraded`, not `failed`.
        deployPhase = 'deploying'
      } else {
        try {
          deployPhase = transition(
            currentPhase === 'candidate' ? 'approved' : currentPhase,
            'deploy'
          )
        } catch {
          deployPhase = currentPhase as RecipePhase
        }
      }

      const isolationLevel: SecurityIsolationLevel =
        recipe.spec.security?.isolationLevel ?? 'minimal'

      // Step 7: Create resources first (PVCs, Secrets, ConfigMaps)
      if (!(await this.hasVerifiedInheritedParentResources(recipe))) {
        await this.ensureRecipeResources(recipe)
      }

      // Step 7a: Provision the OAuth broker token Secret when the recipe opts a
      // client into backgroundAccess. Must run before workloads so the env
      // var's secretKeyRef resolves on first pod start. Path B, spec §9.2.
      //
      // Non-fatal: a transient control-api blip during reconcile (e.g. it's
      // mid-restart) would otherwise leave the recipe stuck in `failed`
      // forever, since `failed` is a non-deployable terminal phase. The
      // periodic rotation loop retries broker-token issuance on its own
      // cadence (every 60s, see WorkflowRecipeWatcher.startBrokerTokenRotationLoop);
      // a missed initial issuance just means dependent pods sit in
      // ContainerCreating until the rotation loop succeeds, rather than the
      // whole recipe getting bricked.
      try {
        await this.ensureOAuthBrokerTokenSecret(recipe)
      } catch (err) {
        console.warn(
          `[WR-Reconciler] Broker-token issuance failed during reconcile for "${name}" (will retry via rotation loop): ${err instanceof Error ? err.message : String(err)}`
        )
      }

      // Issue #637 — classify Secret ownership ONCE, up front, BEFORE any MCP
      // delegation or workload render. The verdict (per-workload namespace:
      // transport→mcp-server, rest→sandbox-recipes) gates BOTH the transport
      // McpServer delegation (Step 7b/9a) and the non-transport render (Step 8).
      // Reading after pre-deploy would let a foreign credential reach the McpServer
      // CRD — which HCC materializes without re-checking ownership — before the
      // gate ever ran. A transient read error requeues here, before we create
      // anything.
      const secretKeys = await this.readReferencedSecrets(recipe)
      const secretOwnership = this.partitionWorkloadsBySecretOwnership(recipe, secretKeys)
      if (secretOwnership.errored) {
        throw new RetryableReconcileError(
          `Secret ownership could not be verified for WorkflowRecipe "${name}" ` +
            `(transient read error) — requeuing before delegating or rendering workloads`
        )
      }

      // Step 7b: Pre-deploy McpServer CRDs for network isolation (Option C handshake)
      // Creates McpServer CRDs with clerum.io/pre-deploy annotation BEFORE workload
      // resources, so HCC can apply NetworkPolicies proactively. This closes the
      // vulnerability window where pods could receive traffic before NPs are applied.
      const hasTransportWorkloads = (recipe.spec.workloads ?? []).some(w => w.transport)
      let preDeployedServers: string[] = []
      // MCP batch targets the MCP namespace (`mcp-server`), NOT the recipe's
      // own namespace. The recipe lives in `sandbox-recipes`, but its MCP
      // children (McpServer CRDs, Services, Contexts) must land where HCC's
      // Context Mapper watches.
      const mcpBatchNs = this.config.namespace
      if (hasTransportWorkloads) {
        try {
          preDeployedServers = await preDeployMcpServers(
            this.delegationDeps,
            recipe,
            mcpBatchNs,
            secretKeys
          )
          if (preDeployedServers.length > 0) {
            console.log(
              `[WR-Reconciler] Pre-deployed ${preDeployedServers.length} McpServer(s) for network isolation`
            )
          }
        } catch (error) {
          console.error(`[WR-Reconciler] Pre-deploy failed for "${name}":`, error)
          // The pre-deploy McpServer handshake is an eventually-consistent
          // wait on HCC reconciling the child McpServers + NetworkPolicies. A
          // failure here means HCC has not caught up yet, NOT that the recipe
          // is broken — so degrade and retry rather than latching the recipe
          // at the terminal `failed` phase. (A plain re-wrapped Error here
          // flattens the cause and yields a generic message the
          // isRetryableInfraError classifier deliberately rejects, which is
          // how healthy recipes used to brick on a transient blip.)
          throw new RetryableReconcileError(
            `Pre-deploy failed for WorkflowRecipe "${name}". ` +
              `WRC cannot start transport workloads until HCC can reconcile child McpServers: ${String(error)}`,
            { cause: error }
          )
        }
      }

      // Step 7c: Wait for HCC to confirm network isolation
      if (preDeployedServers.length > 0) {
        await this.waitForTransportNetworkReadiness(recipe, preDeployedServers, mcpBatchNs)
        console.log(`[WR-Reconciler] Transport network readiness checked for MCP workloads`)
      }

      if (!(await this.recipeStillActive(recipe))) {
        return this.staleRecipeResult(recipe, 'post-network materialization')
      }

      // Step 8: Create workloads in dependency order. Secret ownership was already
      // classified and fail-closed up front (secretKeys / secretOwnership above);
      // reuse that verdict so render and delegation share one source of truth.
      const workloadStatuses: ReconcileResult['workloadStatuses'] = []
      const workloadConditions: StatusCondition[] = []
      // Issue #637 — set when a denied workload's teardown throws; drives a requeue
      // (see requeueAfterMs at the return) so the revocation is retried deterministically
      // instead of leaving a foreign-credentialed pod live until the next event.
      let deniedTeardownFailed = false
      for (const workloadId of sortOrder) {
        const workload = (recipe.spec.workloads ?? []).find(w => w.id === workloadId)!

        if (secretOwnership.deniedWorkloadIds.has(workload.id)) {
          // Ownership-refused Secret ref — do not render. Tear down any prior
          // instance and surface the denial so the operator labels the Secret.
          await this.teardownDeniedWorkload(workload, recipe, secretKeys).catch(err => {
            deniedTeardownFailed = true
            console.error(
              `[WR-Reconciler] Issue #637: teardown of denied workload "${workload.id}" failed; ` +
                `will requeue:`,
              err
            )
          })
          workloadStatuses.push({
            id: workload.id,
            phase: 'failed',
            ready: false,
            message: `EnvSecretOwnershipDenied: ${
              secretOwnership.messageByWorkload.get(workload.id) ??
              'references a Secret it does not own'
            }`,
          })
          continue
        }

        try {
          switch (workload.type) {
            case 'deployment':
              // stdio workloads: HCC creates the Deployment with stdio-bridge sidecar (managed: true)
              if (workload.transport?.type !== 'stdio') {
                await this.ensureDeployment(
                  workload as DeploymentDef,
                  recipe,
                  isolationLevel,
                  secretKeys
                )
              }
              break
            case 'statefulset':
              await this.ensureStatefulSet(
                workload as StatefulSetDef,
                recipe,
                isolationLevel,
                secretKeys
              )
              break
            case 'cronjob':
              await this.ensureCronJob(workload as CronJobDef, recipe, isolationLevel, secretKeys)
              break
            case 'job':
              await this.ensureJob(workload as JobDef, recipe, isolationLevel, secretKeys)
              break
            case 'daemonset':
              await this.ensureDaemonSet(
                workload as DaemonSetDef,
                recipe,
                isolationLevel,
                secretKeys
              )
              break
          }
          // G3: For stdio workloads, HCC owns the Deployment — mark as delegated
          // (runtime readiness is tracked via McpServer CRD status conditions)
          if (workload.transport?.type === 'stdio') {
            workloadStatuses.push({
              id: workload.id,
              phase: 'delegated',
              ready: true,
              message: 'HCC manages Deployment',
            })
          } else {
            workloadStatuses.push(await this.observeWorkloadStatus(workload, recipe))
          }
        } catch (error) {
          if (error instanceof ImmutableStatefulSetDriftError) {
            workloadConditions.push(error.condition)
          }
          workloadStatuses.push({
            id: workload.id,
            phase: 'failed',
            ready: false,
            message: String(error),
          })
        }
      }

      // Step 9: Create services for workloads with ports (no transport)
      for (const workload of recipe.spec.workloads ?? []) {
        const svc = rb.buildService(workload, recipe)
        if (svc) {
          const svcNs = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
          const svcName = svc.metadata!.name!
          this.adjustManifestNamespace(
            svc,
            svcNs,
            recipe.metadata.namespace ?? this.config.sandboxNamespace
          )
          // No ownership guard on this replace (unlike Secret/ConfigMap, issue #571):
          // the Service name is recipe-scoped (a foreign recipe cannot produce this
          // identity hash), a Service carries no data to exfiltrate, and this runs on
          // every reconcile — a guard here would hard-fail the hot path on any
          // unlabeled/transitional Service for marginal defense-in-depth.
          await this.createOrReplace(
            () => this.coreApi.createNamespacedService({ namespace: svcNs, body: svc }),
            async () => {
              const existing = await this.coreApi.readNamespacedService({
                name: svcName,
                namespace: svcNs,
              })
              svc.metadata!.resourceVersion = existing.metadata?.resourceVersion
              svc.spec!.clusterIP = existing.spec?.clusterIP
              return this.coreApi.replaceNamespacedService({
                name: svcName,
                namespace: svcNs,
                body: svc,
              })
            },
            `Service "${svcName}"`
          )
        }
      }

      const legacyRawStatefulSetCleanupPending = await this.cleanupLegacyRawStatefulSetResources(
        recipe,
        workloadStatuses
      )
      const legacyRawDeploymentCleanupPending = await this.cleanupLegacyRawDeploymentResources(
        recipe,
        workloadStatuses
      )
      const legacyRawCleanupPending =
        legacyRawStatefulSetCleanupPending || legacyRawDeploymentCleanupPending

      // Step 9b: Sandbox UI egress policy + symmetric ingress on each
      // internal-egress target (without the ingress side the target stays
      // behind deny-all-<ns> and UI→backend traffic is dropped).
      await this.reconcileUiEgressPolicy(recipe)
      await this.reconcileUiIngressPolicies(recipe)
      // Egress for background-OAuth workloads → control-api broker route.
      await this.reconcileOAuthBrokerEgressPolicy(recipe)

      // Step 9c: Per-workload egressBindings → NetworkPolicies
      // For each non-MCP, non-UI workload that declares egressBindings,
      // emit an egress policy on the source + symmetric ingress policy on
      // any sibling targets it points at. MCP workloads inherit egress
      // through HCC via the McpServer CRD path; UI workloads use
      // `spec.ui.egress.*` which is handled by reconcileUiEgressPolicy.
      await this.reconcileWorkloadEgressPolicies(recipe)

      // Step 9d: WRC-owned intra-recipe internal dependency policies.
      // This lane is separate from HCC binding-allow and legacy wl-* policies.
      const internalDependencyConditions = await this.reconcileInternalDependencyPolicies(recipe)
      const internalDependencyNotReady = internalDependencyConditions.some(
        c => c.status === 'False'
      )
      if (internalDependencyNotReady) {
        return {
          phase: 'failed',
          message:
            internalDependencyConditions.find(c => c.status === 'False')?.message ??
            'Internal dependencies are not ready',
          workloadStatuses: [],
          internalDependencyConditions,
        }
      }

      // Step 9a: MCP delegation — finalize (Context patch + ensure McpServer CRDs).
      // McpServer CRDs were already created in Step 7b (pre-deploy handshake).
      // This step patches the Context allowlist and ensures McpServer CRDs are up-to-date.
      // Same namespace invariant as Step 7b: MCP children live in mcp-server.
      //
      // NOTE: `pre-deploy` is deliberately NOT removed here. `buildMcpServerManifest`
      // omits it, but the replace merge in `ensureMcpServer` carries the live object's
      // `pre-deploy: "true"` over, so it persists — by design. HCC's network-ready
      // re-ack guard keys off `pre-deploy === "true"`, so stripping it would break the
      // stdio readiness handshake. The spec-hash gate excludes `pre-deploy` from the
      // hash (see HASH_EXCLUDED_ANNOTATIONS) so 7b and 9a converge to a no-op write.
      if (hasTransportWorkloads) {
        if (!(await this.recipeStillActive(recipe))) {
          return this.staleRecipeResult(recipe, 'MCP delegation finalization')
        }
        try {
          const delegated = await delegateTransportWorkloads(
            this.delegationDeps,
            recipe,
            mcpBatchNs,
            secretKeys
          )
          if (delegated.length > 0) {
            console.log(
              `[WR-Reconciler] Delegated ${delegated.length} MCP server(s): ${delegated.join(', ')}`
            )
          }
        } catch (error) {
          console.error(`[WR-Reconciler] MCP delegation failed for "${name}":`, error)
          // Same eventually-consistent handshake rationale as the pre-deploy
          // step above: delegation depends on HCC having persisted the child
          // McpServers/Context. A failure is transient (HCC not caught up),
          // so degrade + retry instead of bricking the recipe at `failed`.
          throw new RetryableReconcileError(
            `MCP delegation failed for WorkflowRecipe "${name}". ` +
              `WRC cannot run transport workloads without persisted child McpServers and Context allowlists: ${String(error)}`,
            { cause: error }
          )
        }
      }

      // Step 10: Webhook gateway. Skipped when spec.webhooks is empty/missing.
      // Failure modes (W2 invalid, secret missing, deployment not yet ready)
      // are surfaced via status.conditions[] and DEGRADE the recipe — they
      // don't fail it. The recipe goes back to "active" once the gateway
      // becomes Available on a subsequent reconcile pass.
      const webhookOutcome = await this.reconcileWebhookGateway(recipe)
      const webhookHealthy = webhookOutcome.handled === false || webhookOutcome.ready

      // SDK-only recipes are capability runtimes. Provision the eager host only
      // after workloads and their resources exist, and never route this case
      // through WorkflowReconciler.reconcile() (which owns coordinator/run
      // lifecycle). The adapter owns the same host/token/network/configure
      // semantics as the existing workflow eager path.
      const isSdkOnly =
        !isWorkflow &&
        this.config.pluginWorkloadSdkEnabled &&
        recipe.spec.pluginWorkloadSdk !== undefined
      const sdkOnlyRuntime = isSdkOnly
        ? await this.reconcilePluginWorkloadSdkOnly(recipe)
        : undefined
      sdkOnlyProviderUnavailable = sdkOnlyRuntime?.phase === 'provider_unavailable'
      const sdkOnlyPolicyPending = sdkOnlyRuntime?.phase === 'awaiting_policy'
      // Defense in depth: an active promptBridge recipe is impossible without
      // a fresh v2 proof tied to the eager Pod. Keep the recipe in a progress
      // phase if an adapter regression ever omits it; never publish
      // active+BootstrapNotReady as a settled state.
      const sdkOnlyBootstrapPending =
        sdkOnlyRuntime?.phase === 'active' &&
        recipe.spec.pluginWorkloadSdk !== undefined &&
        sdkOnlyRuntime.pluginWorkloadSdkBootstrapProof?.ready !== true
      if (sdkOnlyRuntime?.phase === 'failed') {
        return {
          phase: 'failed',
          message: sdkOnlyRuntime.message,
          workloadStatuses,
          webhookConditions: webhookOutcome.conditions,
          internalDependencyConditions,
          secretOwnershipConditions: secretOwnership.conditions,
          workloadConditions,
        }
      }

      const allReady =
        workloadStatuses.every(ws => ws.ready) &&
        webhookHealthy &&
        sdkOnlyRuntime?.phase !== 'deploying' &&
        sdkOnlyRuntime?.phase !== 'provider_unavailable' &&
        !sdkOnlyBootstrapPending
      let finalPhase: RecipePhase
      if (sdkOnlyRuntime?.phase === 'deploying' || sdkOnlyBootstrapPending) {
        // A level-triggered SDK host must stay in a progress phase until it is
        // Ready so the watcher requeues provider configuration. `degraded`
        // would incorrectly describe a normal first boot as workload failure.
        finalPhase = 'deploying'
      } else if (allReady) {
        // Advance through valid state machine transitions to reach "active".
        // deploying → test-pass → testing → success → active
        // degraded  → recover  → active
        // active    → (no-op, already active)
        let p: RecipePhase = deployPhase
        if (p === 'deploying') p = transition(p, 'test-pass') // → testing
        if (p === 'testing') p = transition(p, 'success') // → active
        if (p === 'degraded') p = transition(p, 'recover') // → active
        finalPhase = p
      } else {
        finalPhase = 'degraded'
      }
      const message =
        sdkOnlyRuntime?.phase === 'provider_unavailable'
          ? sdkOnlyRuntime.message
          : sdkOnlyPolicyPending
            ? sdkOnlyRuntime.message
            : sdkOnlyRuntime?.phase === 'deploying' || sdkOnlyBootstrapPending
              ? sdkOnlyBootstrapPending
                ? 'Plugin Workload SDK bootstrap identity proof pending'
                : sdkOnlyRuntime.message
              : !allReady && !webhookHealthy
                ? (webhookOutcome.message ?? 'Webhook gateway not ready')
                : allReady
                  ? 'All workloads deployed'
                  : workloadStatuses.some(ws => ws.phase === 'failed')
                    ? 'Some workloads failed'
                    : 'Some workloads not ready'
      return {
        phase: finalPhase,
        message,
        workloadStatuses,
        webhookConditions: webhookOutcome.conditions,
        internalDependencyConditions,
        secretOwnershipConditions: secretOwnership.conditions,
        workloadConditions,
        pluginWorkloadSdkProviderUnavailable: sdkOnlyProviderUnavailable,
        pluginWorkloadSdkPolicyPending: sdkOnlyPolicyPending,
        pluginWorkloadSdkBootstrapProof: sdkOnlyRuntime?.pluginWorkloadSdkBootstrapProof,
        // Issue #637 — requeue if a denied workload's teardown failed (deniedTeardownFailed),
        // so the revocation is retried rather than left to the next event.
        requeueAfterMs:
          legacyRawCleanupPending ||
          deniedTeardownFailed ||
          sdkOnlyRuntime?.phase === 'deploying' ||
          sdkOnlyRuntime?.phase === 'provider_unavailable' ||
          sdkOnlyPolicyPending ||
          sdkOnlyBootstrapPending
            ? TRANSIENT_REQUEUE_BASE_MS
            : undefined,
        requeueFixedInterval:
          sdkOnlyPolicyPending || sdkOnlyRuntime?.phase === 'deploying' || sdkOnlyBootstrapPending,
      }
    } catch (error) {
      // Transient failures must not brick a healthy recipe at the terminal,
      // never-retried `failed` phase. Two complementary signals:
      //
      // (1) RetryableReconcileError — explicitly thrown for a transient step
      //     (e.g. DNS SERVFAIL/timeout on egress resolution). Degrade so the
      //     periodic reconcile retries and the recipe self-heals once the
      //     dependency recovers. egressResolutionError() raises this ONLY when
      //     every failure was transient; a permanent failure yields a plain
      //     Error that must stay terminal (fail-closed) below.
      if (error instanceof RetryableReconcileError) {
        console.warn(
          `[WR-Reconciler] Transient failure reconciling "${name}" (will retry): ${error.message}`
        )
        return {
          phase: 'degraded',
          message: error.message,
          workloadStatuses: [],
        }
      }
      // (2) A raw retryable infra error (connect ETIMEDOUT/ECONNRESET, 5xx,
      //     429, …) thrown from any OTHER step — e.g. the API-server blip that
      //     hit the pre-deploy Context fetch in the original incident. The
      //     recipe itself is fine; keep its phase and leave status untouched so
      //     the next watch resync retries while the workloads keep running.
      //
      //     Egress-resolution errors are deliberately excluded: egressResolution-
      //     Error() already classified their retryability (all-transient →
      //     RetryableReconcileError above; permanent/mixed → a terminal plain
      //     Error). Without this exclusion a mixed failure — whose message
      //     embeds a transient sibling's code like `(ETIMEDOUT)` — would be
      //     re-classified retryable here, silently overriding that fail-closed
      //     decision and hiding the permanent misconfiguration.
      const isEgressResolutionError =
        error instanceof Error && error.message.includes('egress resolution failed')
      if (!isEgressResolutionError && isRetryableInfraError(error)) {
        console.warn(
          `[WR-Reconciler] Transient infra error reconciling "${name}" — keeping phase "${currentPhase}", will retry: ${String(error)}`
        )
        return {
          phase: currentPhase as RecipePhase,
          message: recipe.status?.message ?? '',
          workloadStatuses: (recipe.status?.workloads ?? []).map(w => ({
            id: w.id,
            phase: w.phase,
            ready: w.ready ?? false,
            message: w.message,
          })),
          skipStatusPatch: true,
          // No status patch ⇒ no MODIFIED event to drive the retry; ask the
          // watcher to re-enqueue this recipe with backoff so self-heal does
          // not depend on an unrelated future watch/secret/external event.
          requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
        }
      }
      console.error(`[WR-Reconciler] Failed to reconcile "${name}":`, error)
      return {
        phase: 'failed',
        message: String(error),
        workloadStatuses: [],
      }
    }
  }

  private async reconcilePluginWorkloadSdkOnly(recipe: WorkflowRecipeCRD): Promise<{
    phase: 'active' | 'awaiting_policy' | 'deploying' | 'failed' | 'provider_unavailable'
    message: string
    pluginWorkloadSdkBootstrapProof?: EagerSdkBootstrapProof
  }> {
    if (!this.workflowReconciler) {
      return {
        phase: 'failed',
        message: 'Plugin Workload SDK subsystem not initialized — missing clerum-wrc-signing-key',
      }
    }
    const runtimeScopeRecipeName = await this.workflowRuntimeScopeRecipeName(recipe)
    await this.bindCodexReconcileContext(recipe, runtimeScopeRecipeName)
    return this.workflowReconciler.reconcilePluginWorkloadSdkOnly(
      recipe.metadata.name,
      recipe.metadata.uid ?? '',
      recipe.metadata.namespace,
      recipe.spec,
      runtimeScopeRecipeName
    )
  }

  // ─── Webhook Gateway Reconcile ─────────────────────────────────────
  //
  // Per recipe with spec.webhooks[] non-empty:
  //   1. Validate W2 (workloadRef → deployment without transport). Failure
  //      surfaces WebhookHandlerInvalid + skips resource creation (fail closed).
  //   2. Verify every webhook secretRef exists in the recipe namespace and
  //      contains the named key. Missing → WebhookSecretMissing + skip
  //      resource creation. The reconciler also DELETES any pre-existing
  //      gateway resources so a recipe that previously deployed but lost a
  //      Secret stops accepting traffic.
  //   3. Build + apply Deployment, Service, ConfigMap, and 2 NetworkPolicies.
  //   4. Read back Deployment.status.readyReplicas; emit
  //      WebhookGatewayNotReady until ≥1 replica is Available.
  //
  // Returns:
  //   - handled=false → no webhooks declared; nothing to do.
  //   - handled=true, ready=true → gateway is up.
  //   - handled=true, ready=false → at least one condition set; recipe
  //     phase will be "degraded" until the next reconcile pass clears it.

  private async reconcileWebhookGateway(recipe: WorkflowRecipeCRD): Promise<{
    handled: boolean
    ready: boolean
    conditions: StatusCondition[]
    message?: string
  }> {
    const webhooks = recipe.spec.webhooks ?? []
    if (webhooks.length === 0) {
      // No webhooks → no resources to manage. Don't bother surfacing
      // "absence" as a condition; nothing to keep clean.
      return { handled: false, ready: true, conditions: [] }
    }

    const conditions: StatusCondition[] = []
    const now = new Date().toISOString()
    const ns = recipe.metadata.namespace
    const name = recipe.metadata.name
    const cond = (
      type: string,
      status: 'True' | 'False',
      reason: string,
      message: string
    ): StatusCondition => ({ type, status, reason, message, lastTransitionTime: now })

    // ─── Step 10.1: validate W2 ──────────────────────────────────────
    const validation = validateWebhooks(recipe, webhooks)
    if (validation.kind === 'invalid') {
      conditions.push(
        cond('WebhookHandlerInvalid', 'True', 'WorkloadRefInvalid', validation.message)
      )
      // Fail-closed: also delete any prior gateway resources so a recipe
      // that previously had a valid handler doesn't keep serving traffic
      // through stale infrastructure.
      await this.deleteWebhookGatewayResources(recipe).catch(() => undefined)
      return {
        handled: true,
        ready: false,
        conditions,
        message: `Webhook gateway disabled: ${validation.message}`,
      }
    }
    conditions.push(
      cond('WebhookHandlerInvalid', 'False', 'WorkloadRefValid', 'workloadRef references resolve')
    )

    // ─── Step 10.2: partition webhooks by Secret resolution ──────────
    // Each webhook can reference up to TWO Secret keys: verification.secretRef
    // and (for meta-hub-challenge) setupHandshake.secretRef. A webhook is
    // "resolved" only when every ref it declares exists in the namespace and
    // contains the named key. When a webhook is marked `optional: true` and
    // any of its refs fails to resolve, it transitions to dormant instead of
    // contributing to WebhookSecretMissing — the gateway is still built (the
    // entry is short-circuited to 410 by the gateway server). Required
    // (non-optional) webhooks with unresolved refs keep today's fail-closed
    // semantics — gateway deleted, recipe degraded.
    const missingRequired: string[] = []
    const dormantIds = new Set<string>()
    const dormantMessages: string[] = []
    for (const wh of webhooks) {
      const refs: Array<{ ref: { name: string; key: string }; label: string }> = []
      if (wh.verification.secretRef) {
        refs.push({ ref: wh.verification.secretRef, label: 'secretRef' })
      }
      if (wh.verification.setupHandshake?.secretRef) {
        refs.push({
          ref: wh.verification.setupHandshake.secretRef,
          label: 'setupHandshake.secretRef',
        })
      }
      const failures: string[] = []
      for (const { ref, label } of refs) {
        try {
          const secret = await this.coreApi.readNamespacedSecret({
            name: ref.name,
            namespace: ns,
          })
          // Webhook verifier/setup-handshake secrets authenticate external
          // traffic into a recipe-owned gateway, so they live behind the same
          // cross-recipe Secret boundary as envSecret refs: the Secret must
          // be shared OR owned by THIS recipe. A bare-named cross-recipe
          // Secret (e.g. another recipe's signing key) MUST NOT be rendered
          // into this recipe's gateway config.
          if (!isSecretAccessibleByRecipe(secret.metadata?.labels, recipe.metadata.name)) {
            const ownership = parseSecretOwnership(secret.metadata?.labels)
            failures.push(
              `${label} '${ref.name}' is not accessible to recipe '${recipe.metadata.name}' ` +
                `(ownership=${ownership.kind}; required label clerum.io/shared=true or ` +
                `clerum.io/owner-recipe=${recipe.metadata.name})`
            )
            continue
          }
          const data = secret.data ?? {}
          if (!data[ref.key]) {
            failures.push(`${label} '${ref.name}' has no key '${ref.key}'`)
          }
        } catch (error) {
          if (getErrorCode(error) === 404) {
            failures.push(`${label} '${ref.name}' not found in namespace '${ns}'`)
          } else {
            failures.push(`${label} '${ref.name}' could not be read: ${String(error)}`)
          }
        }
      }
      if (failures.length === 0) continue
      if (wh.optional) {
        dormantIds.add(wh.id)
        dormantMessages.push(
          `webhooks[${wh.id}] dormant: ${failures.join('; ')}` +
            ` (create the referenced Secret to activate)`
        )
      } else {
        for (const f of failures) {
          missingRequired.push(`webhooks[${wh.id}].${f}`)
        }
      }
    }
    if (missingRequired.length > 0) {
      const message = missingRequired.join('; ')
      conditions.push(cond('WebhookSecretMissing', 'True', 'SecretMissing', message))
      // Fail-closed: tear down a previously-running gateway so it stops
      // accepting traffic for non-optional webhooks that lost their Secret.
      await this.deleteWebhookGatewayResources(recipe).catch(() => undefined)
      return {
        handled: true,
        ready: false,
        conditions,
        message: `Webhook gateway disabled: ${message}`,
      }
    }
    conditions.push(
      cond(
        'WebhookSecretMissing',
        'False',
        'SecretsResolved',
        'All required webhook secretRef entries resolve'
      )
    )
    if (dormantIds.size > 0) {
      conditions.push(cond('WebhookDormant', 'True', 'DormantWebhooks', dormantMessages.join('; ')))
    } else {
      conditions.push(
        cond('WebhookDormant', 'False', 'NoDormantWebhooks', 'No optional webhooks are dormant')
      )
    }

    // ─── Step 10.3: build + apply gateway resources ──────────────────
    const built = buildWebhookGatewayResources({
      recipe,
      webhooks,
      targetNamespace: ns,
      handlers: validation.handlers,
      image: this.config.webhookGatewayImage,
      monitoringNamespace: this.config.monitoringNamespace,
      webhookIngressNamespace: this.config.webhookIngressNamespace,
      dormantWebhookIds: dormantIds,
    })

    await this.applyWebhookGatewayResources(recipe, built)

    // ─── Step 10.4: track Deployment readiness ───────────────────────
    let ready = false
    try {
      const dep = await this.appsApi.readNamespacedDeployment({
        name: gatewayResourceName(name),
        namespace: ns,
      })
      const readyReplicas = dep.status?.readyReplicas ?? 0
      ready = readyReplicas >= 1
    } catch (error) {
      console.warn(
        `[WR-Reconciler] Could not read webhook-gateway Deployment for "${name}":`,
        error
      )
    }
    if (ready) {
      conditions.push(
        cond('WebhookGatewayNotReady', 'False', 'GatewayAvailable', 'Deployment Available')
      )
      return { handled: true, ready: true, conditions }
    }
    conditions.push(
      cond(
        'WebhookGatewayNotReady',
        'True',
        'NotYetAvailable',
        'webhook-gateway Deployment has not reached readyReplicas >= 1 yet'
      )
    )
    return {
      handled: true,
      ready: false,
      conditions,
      message: 'Webhook gateway not yet ready',
    }
  }

  /**
   * Idempotent apply of the five gateway resources. Each one uses the
   * same create-or-replace pattern the rest of the reconciler does.
   */
  private async applyWebhookGatewayResources(
    recipe: WorkflowRecipeCRD,
    built: ReturnType<typeof buildWebhookGatewayResources>
  ): Promise<void> {
    const ns = recipe.metadata.namespace
    const recipeName = recipe.metadata.name

    // ConfigMap (config) — apply BEFORE Deployment so the volume mount succeeds.
    await this.createOrReplace(
      () => this.coreApi.createNamespacedConfigMap({ namespace: ns, body: built.configConfigMap }),
      async () => {
        const existing = await this.coreApi.readNamespacedConfigMap({
          name: gatewayConfigMapName(recipeName),
          namespace: ns,
        })
        built.configConfigMap.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.coreApi.replaceNamespacedConfigMap({
          name: gatewayConfigMapName(recipeName),
          namespace: ns,
          body: built.configConfigMap,
        })
      },
      `WebhookGateway ConfigMap "${gatewayConfigMapName(recipeName)}"`
    )

    await this.createOrReplace(
      () => this.appsApi.createNamespacedDeployment({ namespace: ns, body: built.deployment }),
      async () => {
        const existing = await this.appsApi.readNamespacedDeployment({
          name: gatewayResourceName(recipeName),
          namespace: ns,
        })
        built.deployment.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.appsApi.replaceNamespacedDeployment({
          name: gatewayResourceName(recipeName),
          namespace: ns,
          body: built.deployment,
        })
      },
      `WebhookGateway Deployment "${gatewayResourceName(recipeName)}"`
    )

    await this.createOrReplace(
      () => this.coreApi.createNamespacedService({ namespace: ns, body: built.service }),
      async () => {
        const existing = await this.coreApi.readNamespacedService({
          name: gatewayServiceName(recipeName),
          namespace: ns,
        })
        built.service.metadata!.resourceVersion = existing.metadata?.resourceVersion
        built.service.spec!.clusterIP = existing.spec?.clusterIP
        return this.coreApi.replaceNamespacedService({
          name: gatewayServiceName(recipeName),
          namespace: ns,
          body: built.service,
        })
      },
      `WebhookGateway Service "${gatewayServiceName(recipeName)}"`
    )

    for (const policy of [
      built.proxyIngressPolicy,
      built.handlerEgressPolicy,
      built.handlerIngressPolicy,
    ]) {
      const policyName = policy.metadata!.name!
      await this.createOrReplace(
        () => this.networkingApi.createNamespacedNetworkPolicy({ namespace: ns, body: policy }),
        async () => {
          const existing = await this.networkingApi.readNamespacedNetworkPolicy({
            name: policyName,
            namespace: ns,
          })
          policy.metadata!.resourceVersion = existing.metadata?.resourceVersion
          return this.networkingApi.replaceNamespacedNetworkPolicy({
            name: policyName,
            namespace: ns,
            body: policy,
          })
        },
        `WebhookGateway NetworkPolicy "${policyName}"`
      )
    }
  }

  /**
   * Idempotent delete of all gateway resources. Used when the recipe
   * fails the W2/secret checks AFTER previously deploying — we don't
   * want to leave behind a half-broken gateway.
   */
  private async deleteWebhookGatewayResources(recipe: WorkflowRecipeCRD): Promise<void> {
    const ns = recipe.metadata.namespace
    const recipeName = recipe.metadata.name
    await this.safeDelete(
      () =>
        this.appsApi.deleteNamespacedDeployment({
          name: gatewayResourceName(recipeName),
          namespace: ns,
        }),
      `WebhookGateway Deployment "${gatewayResourceName(recipeName)}"`
    )
    await this.safeDelete(
      () =>
        this.coreApi.deleteNamespacedService({
          name: gatewayServiceName(recipeName),
          namespace: ns,
        }),
      `WebhookGateway Service "${gatewayServiceName(recipeName)}"`
    )
    await this.safeDelete(
      () =>
        this.coreApi.deleteNamespacedConfigMap({
          name: gatewayConfigMapName(recipeName),
          namespace: ns,
        }),
      `WebhookGateway ConfigMap "${gatewayConfigMapName(recipeName)}"`
    )
    for (const policyName of [
      proxyIngressNetworkPolicyName(recipeName),
      handlerEgressNetworkPolicyName(recipeName),
      handlerIngressNetworkPolicyName(recipeName),
    ]) {
      await this.safeDelete(
        () => this.networkingApi.deleteNamespacedNetworkPolicy({ name: policyName, namespace: ns }),
        `WebhookGateway NetworkPolicy "${policyName}"`
      )
    }
  }

  // ─── Workflow Workload Deployment ─────────────────────────────────
  //
  // Deploys workloads (Deployments, Services, McpServer CRDs) declared on a
  // workflow recipe. Steps in the workflow connect to these MCP servers by URL,
  // so they must exist before the coordinator executes. Non-fatal: errors are
  // logged but do not abort workflow execution — the coordinator will surface
  // a "Failed to connect" error if a server is unreachable.

  private async deployWorkflowWorkloads(
    recipe: WorkflowRecipeCRD,
    name: string
  ): Promise<{
    internalDependencyConditions: StatusCondition[]
    secretOwnershipConditions: StatusCondition[]
    workloadConditions: StatusCondition[]
  }> {
    const workloads = recipe.spec.workloads ?? []
    if (workloads.length === 0)
      return {
        internalDependencyConditions: [],
        secretOwnershipConditions: [],
        workloadConditions: [],
      }
    if (!(await this.recipeStillActive(recipe))) {
      console.warn(
        `[WR-Reconciler] Skipping workflow workload deploy for "${name}"; recipe is gone or deleting`
      )
      return {
        internalDependencyConditions: [],
        secretOwnershipConditions: [],
        workloadConditions: [],
      }
    }

    const isolationLevel: SecurityIsolationLevel = recipe.spec.security?.isolationLevel ?? 'minimal'
    const sortOrder = sortDependencies(
      workloads.map(w => ({ id: w.id, dependsOn: w.dependsOn ?? [] }))
    )

    // Issue #637 — classify Secret ownership ONCE, up front, BEFORE MCP
    // delegation or workload render (same invariant as the non-workflow flow).
    // The verdict gates the transport McpServer CRD copy AND the render loop;
    // reading it only after pre-deploy would let a foreign credential reach HCC
    // (which never re-checks ownership) before the gate ran.
    const secretKeys = await this.readReferencedSecrets(recipe)
    const secretOwnership = this.partitionWorkloadsBySecretOwnership(recipe, secretKeys)
    if (secretOwnership.errored) {
      throw new RetryableReconcileError(
        `Secret ownership could not be verified for workflow "${name}" ` +
          `(transient read error) — requeuing before delegating or rendering workloads`
      )
    }

    // Pre-deploy McpServer CRDs for network isolation.
    // MCP batch targets `this.config.namespace` (= mcp-server), not the
    // recipe's own namespace, so HCC can reconcile the child server objects.
    const hasTransport = workloads.some(w => w.transport)
    let preDeployedServers: string[] = []
    const mcpBatchNs = this.config.namespace
    if (hasTransport) {
      try {
        preDeployedServers = await preDeployMcpServers(
          this.delegationDeps,
          recipe,
          mcpBatchNs,
          secretKeys
        )
      } catch (err) {
        console.error(`[WR-Reconciler] Pre-deploy MCP failed for workflow "${name}":`, err)
        // Eventually-consistent HCC handshake (see the non-workflow pre-deploy
        // step). Throw RetryableReconcileError so the workflow deploy path
        // (which maps it to `degraded`) retries instead of failing the run.
        throw new RetryableReconcileError(
          `Pre-deploy failed for workflow "${name}". ` +
            `WRC cannot start transport workloads until HCC can reconcile child McpServers: ${String(err)}`,
          { cause: err }
        )
      }
    }
    if (preDeployedServers.length > 0) {
      await this.waitForTransportNetworkReadiness(recipe, preDeployedServers, mcpBatchNs)
    }
    if (!(await this.recipeStillActive(recipe))) {
      console.warn(
        `[WR-Reconciler] Skipping workflow workload materialization for "${name}"; recipe is gone or deleting`
      )
      return {
        internalDependencyConditions: [],
        secretOwnershipConditions: [],
        workloadConditions: [],
      }
    }

    // Provision the OAuth broker token Secret before workloads so the
    // RECIPE_OAUTH_BROKER_TOKEN secretKeyRef resolves on first pod start.
    // Non-fatal — same rationale as the non-workflow branch above. The
    // periodic rotation loop will retry on its own cadence.
    try {
      await this.ensureOAuthBrokerTokenSecret(recipe)
    } catch (err) {
      console.warn(
        `[WR-Reconciler] Broker-token issuance failed during workflow reconcile for "${name}" (will retry via rotation loop): ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Create/update workload resources in dependency order. Secret ownership was
    // already classified and fail-closed up front (secretKeys / secretOwnership
    // above). A denied workload is not rendered and is torn down; the denial
    // manifests as an unrendered workload (its dependent steps fail to connect)
    // plus the per-workload log below, so the workflow degrades without leaking a
    // foreign credential.
    for (const workloadId of sortOrder) {
      const workload = workloads.find(w => w.id === workloadId)!
      if (secretOwnership.deniedWorkloadIds.has(workload.id)) {
        console.error(
          `[WR-Reconciler] EnvSecretOwnershipDenied for workflow workload "${workloadId}" in ` +
            `"${name}": ${secretOwnership.messageByWorkload.get(workloadId) ?? 'foreign Secret reference'}`
        )
        try {
          await this.teardownDeniedWorkload(workload, recipe, secretKeys)
        } catch (err) {
          // Issue #637 — fail-loud + fail-closed. A denied workflow workload whose
          // teardown failed must NOT be left as a silent swallow (the prior
          // foreign-credentialed pod may still be live). Degrade + requeue so the
          // steady-state ownership backstop (workflowNeedsOwnershipBackstop) and this
          // retry re-attempt the revocation. The caller's catch converts a
          // RetryableReconcileError into a degraded result that the watcher requeues.
          throw new RetryableReconcileError(
            `Issue #637: teardown of denied workflow workload "${workloadId}" failed; ` +
              `requeueing to retry revocation: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          )
        }
        continue
      }
      try {
        switch (workload.type) {
          case 'deployment':
            if (workload.transport?.type !== 'stdio') {
              await this.ensureDeployment(
                workload as DeploymentDef,
                recipe,
                isolationLevel,
                secretKeys
              )
            }
            break
          case 'statefulset':
            await this.ensureStatefulSet(
              workload as StatefulSetDef,
              recipe,
              isolationLevel,
              secretKeys
            )
            break
          case 'cronjob':
            await this.ensureCronJob(workload as CronJobDef, recipe, isolationLevel, secretKeys)
            break
          case 'job':
            await this.ensureJob(workload as JobDef, recipe, isolationLevel, secretKeys)
            break
          case 'daemonset':
            await this.ensureDaemonSet(workload as DaemonSetDef, recipe, isolationLevel, secretKeys)
            break
        }
      } catch (err) {
        console.error(
          `[WR-Reconciler] Failed to deploy workload "${workloadId}" for workflow "${name}":`,
          err
        )
        if (workload.type === 'statefulset') {
          throw err
        }
      }
    }

    // Create Services for workloads with ports
    for (const workload of workloads) {
      const svc = rb.buildService(workload, recipe)
      if (!svc) continue
      const svcNs = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
      const svcName = svc.metadata!.name!
      this.adjustManifestNamespace(
        svc,
        svcNs,
        recipe.metadata.namespace ?? this.config.sandboxNamespace
      )
      try {
        await this.createOrReplace(
          () => this.coreApi.createNamespacedService({ namespace: svcNs, body: svc }),
          async () => {
            const existing = await this.coreApi.readNamespacedService({
              name: svcName,
              namespace: svcNs,
            })
            svc.metadata!.resourceVersion = existing.metadata?.resourceVersion
            svc.spec!.clusterIP = existing.spec?.clusterIP
            return this.coreApi.replaceNamespacedService({
              name: svcName,
              namespace: svcNs,
              body: svc,
            })
          },
          `Service "${svcName}"`
        )
      } catch (err) {
        console.error(
          `[WR-Reconciler] Service creation failed for workload "${workload.id}" in workflow "${name}":`,
          err
        )
      }
    }

    // Sandbox UI egress policy + symmetric ingress on internal-egress
    // targets (no-op when spec.ui is unset; idempotent)
    try {
      await this.reconcileUiEgressPolicy(recipe)
      await this.reconcileUiIngressPolicies(recipe)
      await this.reconcileOAuthBrokerEgressPolicy(recipe)
    } catch (err) {
      console.error(
        `[WR-Reconciler] UI egress/ingress policies failed for workflow "${name}":`,
        err
      )
      throw err
    }

    // Per-workload egressBindings → NetworkPolicies (idempotent; no-op when
    // no workload declares egressBindings).
    try {
      await this.reconcileWorkloadEgressPolicies(recipe)
    } catch (err) {
      console.error(`[WR-Reconciler] Workload egress policies failed for workflow "${name}":`, err)
      throw err
    }

    const internalDependencyConditions = await this.reconcileInternalDependencyPolicies(recipe)
    const internalDependencyNotReady = internalDependencyConditions.some(c => c.status === 'False')
    if (internalDependencyNotReady) {
      throw new InternalDependencyReconcileError(
        internalDependencyConditions.find(c => c.status === 'False')?.message ??
          'Internal dependencies are not ready',
        internalDependencyConditions
      )
    }

    // MCP delegation — finalize Context allowlist and McpServer CRDs.
    // Children live in `mcp-server` (mcpBatchNs), not the recipe's own ns.
    if (hasTransport) {
      if (!(await this.recipeStillActive(recipe))) {
        console.warn(
          `[WR-Reconciler] Skipping workflow MCP delegation for "${name}"; recipe is gone or deleting`
        )
        return {
          internalDependencyConditions,
          secretOwnershipConditions: secretOwnership.conditions,
          workloadConditions: [],
        }
      }
      try {
        const delegated = await delegateTransportWorkloads(
          this.delegationDeps,
          recipe,
          mcpBatchNs,
          secretKeys
        )
        if (delegated.length > 0) {
          console.log(
            `[WR-Reconciler] MCP delegation for workflow "${name}": ${delegated.join(', ')}`
          )
        }
      } catch (err) {
        console.error(`[WR-Reconciler] MCP delegation failed for workflow "${name}":`, err)
        // Same eventually-consistent HCC handshake as the non-workflow
        // delegation step: degrade + retry instead of failing the run.
        throw new RetryableReconcileError(
          `MCP delegation failed for workflow "${name}". ` +
            `WRC cannot run transport workloads without persisted child McpServers and Context allowlists: ${String(err)}`,
          { cause: err }
        )
      }
    }

    return {
      internalDependencyConditions,
      secretOwnershipConditions: secretOwnership.conditions,
      workloadConditions: [],
    }
  }

  // ─── Delete Pipeline ──────────────────────────────────────────────

  async reconcileDelete(recipe: WorkflowRecipeCRD): Promise<void> {
    const name = recipe.metadata.name

    console.log(`[WR-Reconciler] Deleting resources for "${name}"`)
    this.secretReverseIndex?.delete(name)

    // ─── Workflow Delete (Stage 1) ────────────────────────────────────
    const isWorkflow = recipe.spec.steps !== undefined && recipe.spec.steps.length > 0
    if (isWorkflow && this.workflowReconciler) {
      // Fence the SDK capability before the workflow deletion pipeline removes
      // the shared mcp-host/token resources. Hybrid recipes must not bypass
      // broker revocation merely because they also have coordinator state.
      if (recipe.spec.pluginWorkloadSdk || recipe.status?.pluginWorkloadSdk) {
        await this.cleanupPluginWorkloadSdkOrThrow(name, { preserveWorkflowRuntime: true })
      }
      await this.workflowReconciler.reconcileDelete(name, recipe.metadata.namespace, recipe.spec)
      await this.cleanupDelegationIfNeeded(recipe)
      await this.cleanupDeclaredRuntimeResources(recipe)
      return
    }

    // Use the durable validated status marker as well as the current spec:
    // a capability may have been removed in an update before Kubernetes emits
    // the final delete event, and cleanup must still revoke its host tokens.
    if (recipe.spec.pluginWorkloadSdk || recipe.status?.pluginWorkloadSdk) {
      await this.cleanupPluginWorkloadSdkOrThrow(name)
    }

    await this.cleanupDelegationIfNeeded(recipe)
    await this.cleanupDeclaredRuntimeResources(recipe)
  }

  private async cleanupDelegationIfNeeded(recipe: WorkflowRecipeCRD): Promise<void> {
    const name = recipe.metadata.name
    const hasTransportWorkloads = (recipe.spec.workloads ?? []).some(w => w.transport)
    if (!hasTransportWorkloads) return

    try {
      await cleanupDelegation(this.delegationDeps, recipe, this.config.namespace)
    } catch (error) {
      console.error(`[WR-Reconciler] Delegation cleanup failed for "${name}":`, error)
      throw error
    }
  }

  /**
   * Compute teardown for a terminal workflow run — frees CPU/RAM held by a
   * finished run's pods while PRESERVING its artifacts (artifact-reader pod +
   * workflow-output PVC) and the run-scoped CR + DB history.
   *
   * Gated to RUN-SCOPED recipes only (those carrying the
   * `clerum.io/workflow-run-id` label). Long-lived recipes — eager
   * pluginWorkloadSdk hosts, trigger infrastructure, classic non-run recipes —
   * never carry that label and are left untouched.
   *
   * Best-effort and idempotent: deleting already-gone pods is a 404 no-op, and
   * any failure is logged + swallowed so the terminal status patch still lands.
   * NEVER deletes the artifact-reader, the PVC, the CR, or the DB run row — the
   * CR's finalizer cascade (reconcileDelete) at archive-cron TTL owns those.
   */
  private async teardownTerminalRunComputeIfRunScoped(recipe: WorkflowRecipeCRD): Promise<void> {
    const name = recipe.metadata.name
    const runId = recipe.metadata.labels?.[WORKFLOW_RUN_ID_LABEL]?.trim()
    if (!runId) return // not a run-scoped recipe — leave long-lived infra alone

    // Each step is independently best-effort: an error in one MUST NOT skip the
    // others (thermo-nuclear/sec-context-depth finding — a shared try would let
    // a blip in step 1 leak the transport Deployment). All failures are logged
    // and swallowed so the terminal status patch still lands; the archive-cron
    // finalizer cascade is the backstop for anything left behind.
    const completed: string[] = []
    const failures: string[] = []
    const workflowReconciler = this.workflowReconciler

    // 1. Compute pods in sandbox-recipes: coordinator, mcp-host, snippet-runner.
    //    Artifact-reader is deliberately EXCLUDED so /output stays downloadable.
    if (workflowReconciler) {
      try {
        await workflowReconciler.teardownComputePodsForTerminalRun(name)
        completed.push('compute-pods(coordinator,mcp-host,snippet-runner)')
      } catch (error) {
        failures.push('compute-pods')
        console.error(
          `[WR-Reconciler] Terminal compute-pod teardown failed for "${name}" (run ${runId}):`,
          error
        )
      }
    }

    // 2. Cross-namespace transport runtime in mcp-server (e.g. web-search).
    //    HTTP/SSE transports are managed:false → the Deployment is WRC-owned,
    //    so HCC does NOT garbage-collect it (only stdio managed:true Deployments
    //    are HCC-owned). We therefore delete BOTH:
    //      (a) the McpServer CRD + transport Service + Context entry, via the
    //          same cleanupDelegation path reconcileDelete uses; and
    //      (b) the WRC-owned transport Deployment(s) directly (step 3) — without
    //          this the ~100m web-search pod lingers until the 30-day TTL.
    try {
      await this.cleanupDelegationIfNeeded(recipe)
      if ((recipe.spec.workloads ?? []).some(w => w.transport)) {
        completed.push('mcp-server-delegation(McpServer-crd,service,context)')
      }
    } catch (error) {
      failures.push('mcp-server-delegation')
      console.error(
        `[WR-Reconciler] Terminal delegation cleanup failed for "${name}" (run ${runId}):`,
        error
      )
    }

    // 3. WRC-owned transport Deployment(s) in mcp-server. See step 2 rationale.
    try {
      const targeted = await this.deleteTransportRuntimeWorkloads(recipe)
      if (targeted.length > 0) {
        completed.push(`transport-deployments-targeted(${targeted.join(',')})`)
      }
    } catch (error) {
      failures.push('transport-deployments')
      console.error(
        `[WR-Reconciler] Terminal transport-Deployment teardown failed for "${name}" (run ${runId}):`,
        error
      )
    }

    console.log(
      `[WR-Reconciler] Workflow "${name}" terminal (run ${runId}) — cleanup attempted [${completed.join('; ') || 'nothing'}]` +
        `${failures.length ? `; failed (left for archive-cron) [${failures.join(', ')}]` : ''}` +
        `; preserved artifact-reader + output PVC + output-anchor + CR + DB`
    )
  }

  /**
   * Delete the run's WRC-owned TRANSPORT runtime workloads (the MCP servers
   * such as web-search) in the mcp-server namespace, freeing their pods.
   *
   * SCOPE / SAFETY (adversarial guard — never over-delete):
   * - Only workloads with a `transport` field (the MCP servers). Non-transport
   *   workloads are left to the CR finalizer's `cleanupDeclaredRuntimeResources`.
   * - StatefulSets and any workload declaring `volumeClaimTemplates` are SKIPPED
   *   so a PVC-backed transport workload can never trigger data loss (#558).
   * - The resource name is the RUN-SCOPED name (`status.workloadInstances` /
   *   UID-derived hash via resolveWorkloadRuntimeResourceName), so a delete
   *   cannot reach a sibling run's or the parent recipe's workloads.
   * - The namespace is `resolveWorkloadNamespace(workload)` which, for transport
   *   workloads, is the mcp-server namespace.
   * - `deleteWorkload`→`safeDelete` swallows 404, so this is idempotent and a
   *   no-op once the Deployment is gone.
   *
   * Returns the list of resolved Deployment names targeted (for logs). A
   * non-404 delete error is logged by safeDelete and left for archive-cron.
   */
  private async deleteTransportRuntimeWorkloads(recipe: WorkflowRecipeCRD): Promise<string[]> {
    const targeted: string[] = []
    for (const workload of recipe.spec.workloads ?? []) {
      if (!workload.transport) continue
      // Defense in depth: never delete a stateful/PVC-backed workload here.
      if (workload.type === 'statefulset') continue
      if ((workload as { volumeClaimTemplates?: unknown[] }).volumeClaimTemplates?.length) continue

      const ns = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
      const resourceName = rb.resolveWorkloadRuntimeResourceName(recipe, workload)
      await this.deleteWorkload(workload.type, resourceName, ns)
      targeted.push(resourceName)
    }
    return targeted
  }

  private async cleanupDeclaredRuntimeResources(recipe: WorkflowRecipeCRD): Promise<void> {
    const name = recipe.metadata.name

    // Sort dependencies and reverse for deletion order
    const sortOrder = sortDependencies(
      (recipe.spec.workloads ?? []).map(w => ({
        id: w.id,
        dependsOn: w.dependsOn ?? [],
      }))
    )
    const deleteOrder = [...sortOrder].reverse()

    // Delete workloads in reverse dependency order — each in its resolved namespace
    for (const workloadId of deleteOrder) {
      const workload = (recipe.spec.workloads ?? []).find(w => w.id === workloadId)!
      const ns = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
      const resourceName = rb.resolveWorkloadRuntimeResourceName(recipe, workload)
      await this.deleteWorkload(workload.type, resourceName, ns)

      // Delete associated service if it exists
      if (rb.buildService(workload, recipe)) {
        await this.safeDelete(
          () => this.coreApi.deleteNamespacedService({ name: resourceName, namespace: ns }),
          `Service "${resourceName}" in ${ns}`
        )
      }
    }

    // Delete resources — each in its resolved namespace.
    // PVCs: honor clerum.io/pvc-retention annotation (default: "retain").
    const pvcRetention = recipe.metadata.annotations?.['clerum.io/pvc-retention'] ?? 'retain'
    if (await this.hasVerifiedInheritedParentResources(recipe)) {
      console.log(`[WR-Reconciler] Skipping inherited parent resources for child "${name}"`)
      return
    }

    if (recipe.spec.resources) {
      for (const res of recipe.spec.resources) {
        const resNs = this.resolveResourceNamespace(
          res,
          recipe.spec.workloads ?? [],
          recipe.spec.ui?.workloadRef
        )
        // Physical (recipe-scoped) name — delete MUST target this, not the raw
        // logical id, now that resources are scoped (issue #571).
        const resName = rb.resolveResourceName(recipe, res.id)
        switch (res.type) {
          case 'secret':
            await this.deleteResourceIfOwned(
              () => this.coreApi.readNamespacedSecret({ name: resName, namespace: resNs }),
              () => this.coreApi.deleteNamespacedSecret({ name: resName, namespace: resNs }),
              recipe,
              `Secret "${res.id}" in ${resNs}`
            )
            break
          case 'configmap':
            await this.deleteResourceIfOwned(
              () => this.coreApi.readNamespacedConfigMap({ name: resName, namespace: resNs }),
              () => this.coreApi.deleteNamespacedConfigMap({ name: resName, namespace: resNs }),
              recipe,
              `ConfigMap "${res.id}" in ${resNs}`
            )
            break
          case 'pvc':
            if (pvcRetention === 'delete') {
              await this.deleteResourceIfOwned(
                () =>
                  this.coreApi.readNamespacedPersistentVolumeClaim({
                    name: resName,
                    namespace: resNs,
                  }),
                () =>
                  this.coreApi.deleteNamespacedPersistentVolumeClaim({
                    name: resName,
                    namespace: resNs,
                  }),
                recipe,
                `PVC "${res.id}" in ${resNs}`
              )
            } else {
              console.log(
                `[WR-Reconciler] Retaining PVC "${res.id}" (pvc-retention: ${pvcRetention})`
              )
            }
            break
        }
      }
    }

    // The OAuth broker token Secret + its egress NetworkPolicy (Path B) carry
    // no ownerReference, so they are reaped explicitly here. safeDelete
    // swallows 404 when the recipe never used background OAuth.
    await this.safeDelete(
      () =>
        this.coreApi.deleteNamespacedSecret({
          name: rb.oauthBrokerTokenSecretName(recipe.metadata.name),
          namespace: this.config.sandboxNamespace,
        }),
      `Secret "${rb.oauthBrokerTokenSecretName(recipe.metadata.name)}" in ${this.config.sandboxNamespace}`
    )
    await this.safeDelete(
      () =>
        this.networkingApi.deleteNamespacedNetworkPolicy({
          name: rb.oauthBrokerEgressPolicyName(recipe.metadata.name),
          namespace: this.config.sandboxNamespace,
        }),
      `NetworkPolicy "${rb.oauthBrokerEgressPolicyName(recipe.metadata.name)}" in ${this.config.sandboxNamespace}`
    )

    await this.cleanupInternalDependencyPolicies(recipe)

    // Delete headless services for StatefulSets — each in its resolved namespace
    for (const w of recipe.spec.workloads ?? []) {
      if (w.type === 'statefulset') {
        const svcName = rb.resolveStatefulSetHeadlessServiceName(recipe, w as StatefulSetDef)
        const ns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
        await this.safeDelete(
          () => this.coreApi.deleteNamespacedService({ name: svcName, namespace: ns }),
          `Headless Service "${svcName}" in ${ns}`
        )
      }
    }

    // The ui-egress NetworkPolicy lives in sandbox-ui (cross-namespace from the
    // CRD), so K8s GC does not reap it via the Recipe's ownerReference. Always
    // attempt deletion — safeDelete swallows 404 when no policy was created.
    const uiPolicyName = `ui-egress-${recipe.metadata.name}`
    await this.safeDelete(
      () =>
        this.networkingApi.deleteNamespacedNetworkPolicy({
          name: uiPolicyName,
          namespace: this.config.sandboxUiNamespace,
        }),
      `NetworkPolicy "${uiPolicyName}" in ${this.config.sandboxUiNamespace}`
    )

    // The symmetric ui-ingress NetworkPolicies carry no ownerReference (same
    // rationale as ui-egress — the policy namespace need not match the CRD's),
    // so delete them explicitly: one per distinct internal-egress target.
    const uiIngressTargets = new Set(
      (recipe.spec.ui?.egress?.internal ?? []).map(rule => rule.workloadRef)
    )
    for (const workloadId of uiIngressTargets) {
      const npName = rb.uiIngressPolicyName(recipe.metadata.name, workloadId)
      await this.safeDelete(
        () =>
          this.networkingApi.deleteNamespacedNetworkPolicy({
            name: npName,
            namespace: this.config.sandboxNamespace,
          }),
        `NetworkPolicy "${npName}" in ${this.config.sandboxNamespace}`
      )
    }
  }

  // ─── Create-or-Replace Pattern ────────────────────────────────────

  /**
   * Create-or-replace a managed object. When `idempotency` is supplied, the
   * desired manifest is stamped with a spec-hash annotation and, on the
   * already-exists (409) path, the existing object's stamped hash is compared to
   * the desired hash — if they match the replace PUT is SKIPPED entirely.
   *
   * This is what stops the generation churn: WRC reconciles every workload on a
   * periodic resync, and an unconditional full replace re-defaults server-managed
   * fields, bumping metadata.generation with no real change (→ a degraded↔active
   * status flap and a downstream HCC NetworkPolicy no-op write storm). Skipping
   * unchanged writes makes the reconcile idempotent. See specHash.ts.
   */
  private async createOrReplace(
    createFn: () => Promise<unknown>,
    replaceFn: () => Promise<unknown>,
    label: string,
    idempotency?: {
      manifest: { metadata?: { annotations?: { [key: string]: string } } }
      readExisting: () => Promise<{ metadata?: { annotations?: { [key: string]: string } } } | null>
    }
  ): Promise<void> {
    if (idempotency) stampSpecHash(idempotency.manifest)
    try {
      await createFn()
      console.log(`[WR-Reconciler] Created ${label}`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 409) {
        if (idempotency && (await this.applyIsNoop(idempotency))) {
          console.log(`[WR-Reconciler] ${label} unchanged (spec-hash match); skipping update`)
          return
        }
        try {
          await replaceFn()
          console.log(`[WR-Reconciler] Updated ${label}`)
        } catch (updateError) {
          console.error(`[WR-Reconciler] Failed to update ${label}:`, updateError)
          throw updateError
        }
      } else {
        console.error(`[WR-Reconciler] Failed to create ${label}:`, error)
        throw error
      }
    }
  }

  /**
   * True when the existing object already carries the desired spec-hash, so the
   * replace would be a no-op. A read failure returns false (fall through to
   * replace) — never skip an update we cannot prove is unnecessary.
   */
  private async applyIsNoop(idempotency: {
    manifest: { metadata?: { annotations?: { [key: string]: string } } }
    readExisting: () => Promise<{ metadata?: { annotations?: { [key: string]: string } } } | null>
  }): Promise<boolean> {
    try {
      const existing = await idempotency.readExisting()
      return specHashUnchanged(idempotency.manifest, existing ?? null)
    } catch {
      return false
    }
  }

  private stableComparableString(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) {
      return `[${value.map(v => this.stableComparableString(v)).join(',')}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${this.stableComparableString(child)}`)
    return `{${entries.join(',')}}`
  }

  private comparable(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  }

  private equalComparable(left: unknown, right: unknown): boolean {
    return (
      this.stableComparableString(this.comparable(left)) ===
      this.stableComparableString(this.comparable(right))
    )
  }

  private removeVolatileMetadataFields(metadata: unknown): unknown {
    if (!metadata || typeof metadata !== 'object') return metadata
    const out = { ...(metadata as Record<string, unknown>) }
    for (const field of [
      'resourceVersion',
      'uid',
      'generation',
      'creationTimestamp',
      'deletionTimestamp',
      'managedFields',
      'selfLink',
      'ownerReferences',
    ]) {
      delete out[field]
    }
    if (out.annotations && typeof out.annotations === 'object') {
      const annotations = { ...(out.annotations as Record<string, unknown>) }
      delete annotations[SPEC_HASH_ANNOTATION]
      if (Object.keys(annotations).length > 0) out.annotations = annotations
      else delete out.annotations
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  private normalizeStatefulSetVolumeClaimTemplates(templates: unknown): unknown {
    const templatesComparable =
      (this.comparable(templates) as Array<Record<string, unknown>> | undefined) ?? []
    return templatesComparable.map(template => {
      const metadata = (template.metadata ?? {}) as Record<string, unknown>
      const spec = (template.spec ?? {}) as Record<string, unknown>
      if (spec?.volumeMode === 'Filesystem') delete spec.volumeMode
      if (Array.isArray(spec.accessModes)) {
        spec.accessModes = [...spec.accessModes].sort()
      }
      return {
        metadata: { name: metadata.name },
        spec,
      }
    })
  }

  private normalizePodTemplate(template: unknown): unknown {
    const normalized = this.comparable(template) as
      | {
          metadata?: unknown
          spec?: Record<string, unknown>
        }
      | undefined
    if (!normalized) return normalized
    normalized.metadata = this.removeVolatileMetadataFields(normalized.metadata)
    const spec = normalized.spec
    if (spec) {
      if (spec.restartPolicy === 'Always') delete spec.restartPolicy
      if (spec.dnsPolicy === 'ClusterFirst') delete spec.dnsPolicy
      if (spec.schedulerName === 'default-scheduler') delete spec.schedulerName
      if (spec.terminationGracePeriodSeconds === 30) delete spec.terminationGracePeriodSeconds
      if (spec.enableServiceLinks === true) delete spec.enableServiceLinks
      for (const key of ['containers', 'initContainers']) {
        for (const container of (spec[key] as Array<Record<string, unknown>> | undefined) ?? []) {
          if (container.terminationMessagePath === '/dev/termination-log') {
            delete container.terminationMessagePath
          }
          if (container.terminationMessagePolicy === 'File')
            delete container.terminationMessagePolicy
          if (
            container.imagePullPolicy === 'IfNotPresent' ||
            container.imagePullPolicy === 'Always'
          ) {
            delete container.imagePullPolicy
          }
        }
      }
    }
    return normalized
  }

  private statefulSetImmutableDriftFields(
    desired: k8s.V1StatefulSet,
    existing: k8s.V1StatefulSet
  ): string[] {
    const desiredSpec = (desired.spec ?? {}) as k8s.V1StatefulSetSpec
    const existingSpec = (existing.spec ?? {}) as k8s.V1StatefulSetSpec
    const fields: string[] = []
    if (!this.equalComparable(desiredSpec.selector, existingSpec.selector))
      fields.push('spec.selector')
    if (!this.equalComparable(desiredSpec.serviceName, existingSpec.serviceName)) {
      fields.push('spec.serviceName')
    }
    if (
      !this.equalComparable(
        desiredSpec.podManagementPolicy ?? 'OrderedReady',
        existingSpec.podManagementPolicy ?? 'OrderedReady'
      )
    ) {
      fields.push('spec.podManagementPolicy')
    }
    if (
      !this.equalComparable(
        this.normalizeStatefulSetVolumeClaimTemplates(desiredSpec.volumeClaimTemplates),
        this.normalizeStatefulSetVolumeClaimTemplates(existingSpec.volumeClaimTemplates)
      )
    ) {
      fields.push('spec.volumeClaimTemplates')
    }
    return fields
  }

  private buildStatefulSetMutableSpecPatch(
    desired: k8s.V1StatefulSet,
    existing: k8s.V1StatefulSet
  ): Record<string, unknown> {
    const desiredSpec = (desired.spec ?? {}) as k8s.V1StatefulSetSpec
    const existingSpec = (existing.spec ?? {}) as k8s.V1StatefulSetSpec
    const desiredSpecRecord = desiredSpec as unknown as Record<string, unknown>
    const existingSpecRecord = existingSpec as unknown as Record<string, unknown>
    const patch: Record<string, unknown> = {}

    if (!this.equalComparable(desiredSpec.replicas, existingSpec.replicas)) {
      patch.replicas = desiredSpec.replicas
    }
    if (
      desiredSpec.template !== undefined &&
      !this.equalComparable(
        this.normalizePodTemplate(desiredSpec.template),
        this.normalizePodTemplate(existingSpec.template)
      )
    ) {
      patch.template = desiredSpec.template
    }
    for (const key of [
      'ordinals',
      'updateStrategy',
      'revisionHistoryLimit',
      'persistentVolumeClaimRetentionPolicy',
      'minReadySeconds',
    ]) {
      const desiredValue = desiredSpecRecord[key]
      if (
        desiredValue !== undefined &&
        !this.equalComparable(desiredValue, existingSpecRecord[key])
      ) {
        patch[key] = desiredValue
      }
    }
    return patch
  }

  private immutableStatefulSetDriftError(
    name: string,
    namespace: string,
    fields: string[]
  ): ImmutableStatefulSetDriftError {
    const message =
      `ImmutableStatefulSetDrift: StatefulSet "${name}" in ${namespace} has immutable drift in ` +
      `${fields.join(', ')}; WRC will not full-replace StatefulSets. ` +
      'Recreate through an explicit data-safe migration.'
    return new ImmutableStatefulSetDriftError(message, {
      type: 'StatefulSetImmutableDrift',
      status: 'True',
      reason: 'ImmutableStatefulSetDrift',
      message,
      lastTransitionTime: new Date().toISOString(),
    })
  }

  private async createOrPatchStatefulSet(
    statefulSet: k8s.V1StatefulSet,
    namespace: string,
    name: string
  ): Promise<void> {
    const desiredHash = stampSpecHash(statefulSet)
    try {
      await this.appsApi.createNamespacedStatefulSet({ namespace, body: statefulSet })
      console.log(`[WR-Reconciler] Created StatefulSet "${name}" in ${namespace}`)
      return
    } catch (error: unknown) {
      if (getErrorCode(error) !== 409) {
        console.error(
          `[WR-Reconciler] Failed to create StatefulSet "${name}" in ${namespace}:`,
          error
        )
        throw error
      }
    }

    const existing = await this.appsApi.readNamespacedStatefulSet({ name, namespace })
    if (existing.metadata?.annotations?.[SPEC_HASH_ANNOTATION] === desiredHash) {
      console.log(
        `[WR-Reconciler] StatefulSet "${name}" in ${namespace} unchanged (spec-hash match); skipping update`
      )
      return
    }

    const immutableDriftFields = this.statefulSetImmutableDriftFields(statefulSet, existing)
    if (immutableDriftFields.length > 0) {
      throw this.immutableStatefulSetDriftError(name, namespace, immutableDriftFields)
    }

    const specPatch = this.buildStatefulSetMutableSpecPatch(statefulSet, existing)
    const patchBody: {
      metadata: { annotations: Record<string, string> }
      spec?: Record<string, unknown>
    } = {
      metadata: { annotations: { [SPEC_HASH_ANNOTATION]: desiredHash } },
    }
    if (Object.keys(specPatch).length > 0) patchBody.spec = specPatch

    await this.appsApi.patchNamespacedStatefulSet(
      { name, namespace, body: patchBody },
      {
        middleware: [
          k8s.setHeaderMiddleware('Content-Type', 'application/strategic-merge-patch+json'),
        ],
      }
    )
    const patchKind = patchBody.spec ? 'metadata+mutable spec' : 'metadata'
    console.log(`[WR-Reconciler] Patched StatefulSet "${name}" in ${namespace} (${patchKind})`)
  }

  private async safeDelete(deleteFn: () => Promise<unknown>, label: string): Promise<void> {
    try {
      await deleteFn()
      console.log(`[WR-Reconciler] Deleted ${label}`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[WR-Reconciler] ${label} already gone`)
      } else {
        console.error(`[WR-Reconciler] Failed to delete ${label}:`, error)
      }
    }
  }

  /**
   * Issue #637 — like `safeDelete` but RE-THROWS a non-404 failure. Used ONLY by the
   * denied-workload teardown (revocation) path: a real delete failure (RBAC 403,
   * apiserver 5xx) must propagate so the caller requeues and retries, instead of the
   * silent swallow reporting a false "revoked" status over a still-live
   * foreign-credentialed pod. The 404 branch still returns cleanly (idempotent).
   */
  private async deleteOrThrow(deleteFn: () => Promise<unknown>, label: string): Promise<void> {
    try {
      await deleteFn()
      console.log(`[WR-Reconciler] Deleted ${label}`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[WR-Reconciler] ${label} already gone`)
        return
      }
      console.error(`[WR-Reconciler] Failed to delete ${label}:`, error)
      throw error
    }
  }

  /**
   * Best-effort, ownership-gated delete for a declared `spec.resources[]` object
   * (issue #571 defense-in-depth). Reads the object first and only deletes it when
   * it carries this recipe's `clerum.io/recipe` label — so a poisoned
   * `status.resourceInstances` (e.g. under a misconfigured RBAC) can never make the
   * delete target another recipe's resource. Like `safeDelete`, it NEVER throws:
   * this runs inside the delete finalizer, and blocking on a transient read would
   * leave the recipe stuck Terminating. A read failure (404 or transient) skips the
   * delete — fail-safe: never delete what we cannot verify as our own.
   */
  private async deleteResourceIfOwned(
    read: () => Promise<{ metadata?: { labels?: { [key: string]: string } } }>,
    del: () => Promise<unknown>,
    recipe: WorkflowRecipeCRD,
    label: string
  ): Promise<void> {
    let existing: { metadata?: { labels?: { [key: string]: string } } }
    try {
      existing = await read()
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[WR-Reconciler] ${label} already gone`)
      } else {
        console.error(`[WR-Reconciler] Skipping delete of ${label} — ownership read failed:`, error)
      }
      return
    }
    const owner = existing.metadata?.labels?.['clerum.io/recipe']
    if (owner !== recipe.metadata.name) {
      console.log(
        `[WR-Reconciler] Skipping delete of ${label} — owned by "${owner ?? 'unset'}", not "${recipe.metadata.name}" (issue #571)`
      )
      return
    }
    await this.safeDelete(del, label)
  }

  /**
   * Reconcile the per-recipe `ui-egress-<recipeName>` NetworkPolicy in
   * `sandboxUiNamespace`. Ensures the policy converges with `recipe.spec.ui`:
   *   - spec.ui set   → create-or-replace the policy
   *   - spec.ui unset → delete any leftover policy from a prior reconcile
   *
   * The policy lives in a different namespace from the WorkflowRecipe CRD, so
   * it carries no ownerReference and relies on this method (and reconcileDelete)
   * for cleanup.
   */
  // issue #299 Phase 2 — resolve provider-mode declarations against the
  // clerum-provider-netblocks catalog (read at most once per call). ANY failure
  // THROWS (H3-by-throw): the reconciler's existing throw path retains the live
  // policy and surfaces the failure — a CM outage becomes LKG, never egress loss.
  // PR335-WRC-002: results are POSITIONALLY ALIGNED with `declared` (never
  // FQDN-keyed) so a same-FQDN exact-host sibling on another port cannot
  // inherit provider CIDRs and same-FQDN multi-provider declarations each keep
  // their OWN category ranges (no last-write-wins).
  private async resolveProviderRangesPerDeclaration(
    declared: Array<{ fqdn: string; provider?: { name: string; categories?: string[] } }>,
    label: string
  ): Promise<Array<string[] | undefined>> {
    const out: Array<string[] | undefined> = new Array(declared.length).fill(undefined)
    const wanting = declared.map((d, i) => ({ d, i })).filter(x => x.d.provider)
    if (wanting.length === 0) return out
    let cm: k8s.V1ConfigMap
    try {
      cm = await this.coreApi.readNamespacedConfigMap({
        name: 'clerum-provider-netblocks',
        namespace: this.config.controlPlaneNamespace,
      })
    } catch (err) {
      throw egressResolutionError(
        `${label} provider netblocks catalog unavailable`,
        wanting.map(({ d }) => ({
          fqdn: d.fqdn,
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
        }))
      )
    }
    const parsed = parseProviderNetblocks(cm.data)
    // PR335-M2: a malformed catalog otherwise surfaces downstream only as a bare
    // "category not present" — carry the parse errors into the failure message so
    // the failed phase reports the actual catalog defect.
    const catalogNote =
      parsed.errors.length > 0 ? ` (catalog malformed: ${parsed.errors.join('; ')})` : ''
    const failures: Array<{ fqdn: string; error: string; retryable: boolean }> = []
    for (const { d, i } of wanting) {
      const resolved = resolveProviderRanges({
        fqdn: d.fqdn,
        declaredName: d.provider!.name,
        declaredCategories: d.provider!.categories,
        curatedProviders: providerNames,
        registryLookup: lookupFqdnProvider(d.fqdn),
        cmCategories: parsed.categories,
        bounds: providerBounds(d.provider!.name),
      })
      if (resolved.kind === 'invalid') {
        failures.push({ fqdn: d.fqdn, error: resolved.reasons.join('; '), retryable: false })
      } else {
        out[i] = resolved.ranges
      }
    }
    if (failures.length > 0) {
      throw egressResolutionError(`${label} provider declaration invalid${catalogNote}`, failures)
    }
    return out
  }

  // issue #299 Phase 2 — stamp the provenance annotation (EXCLUDED from the WRC
  // write gate, which compares the spec-derived egressSignature only). Pure audit
  // view; unchanged when no provider ranges exist (byte-identical /32 mode).
  // PR335-WRC-002: takes the declared array + the index-aligned ranges so the
  // annotation reflects exactly the declarations that resolved (format stays
  // `fqdn=cidr,cidr;...` — substring-compatible with the e2e greps).
  private withProviderProvenance(
    annotations: Record<string, string>,
    declared: Array<{ fqdn: string }>,
    providerRanges: Array<string[] | undefined>
  ): Record<string, string> {
    const pairs = declared
      .map((d, i) => ({ fqdn: d.fqdn, ranges: providerRanges[i] }))
      .filter(
        (p): p is { fqdn: string; ranges: string[] } =>
          p.ranges !== undefined && p.ranges.length > 0
      )
    if (pairs.length === 0) return annotations
    const value = [...new Set(pairs.map(p => `${p.fqdn}=${p.ranges.join(',')}`))].sort().join(';')
    return { ...annotations, 'clerum.io/egress-provider-ranges': value }
  }

  // issue #299 Phase 2 — H7: log the drift canary on transition (or at most once
  // per hour per policy) so chronic drift does not spam the log. The paging alert
  // is an ops concern (deferred). `fqdn` labels are declared hosts, never IPs.
  private providerDriftLastWarned = new Map<string, number>()
  private warnProviderDrift(
    policyName: string,
    namespace: string,
    uncoveredByFqdn: Record<string, string[]>
  ): void {
    const fqdns = Object.keys(uncoveredByFqdn)
    const key = `${namespace}/${policyName}`
    if (fqdns.length === 0) {
      this.providerDriftLastWarned.delete(key)
      return
    }
    const now = Date.now()
    // PR335 re-review: expire throttle entries older than the window. An entry with
    // age >= the window can never suppress a warn (the check below), so removal is
    // behavior-identical — and deleted recipes / removed provider bindings stop
    // leaking map keys (there is no per-reconcile desiredPolicyNames sweep in WRC).
    for (const [k, t] of this.providerDriftLastWarned) {
      if (now - t >= 3_600_000) this.providerDriftLastWarned.delete(k)
    }
    const last = this.providerDriftLastWarned.get(key)
    if (last !== undefined && now - last < 3_600_000) return
    this.providerDriftLastWarned.set(key, now)
    const detail = fqdns.map(f => `${f}: ${uncoveredByFqdn[f].join(', ')}`).join('; ')
    console.warn(
      `[WR-Reconciler] provider-range drift on ${namespace}/${policyName}: ${detail} — ` +
        `declared ranges may be stale or a host mis-mapped (issue #299)`
    )
  }

  // issue #299 Phase 2 seam rule (docs/architecture/issue-299-phase2-dns-failure-seam.md).
  // Partition permanent (non-retryable) egress failures into those that must still
  // FAIL LOUD (fatal) and those EXEMPTED because the fqdn is a provider binding with a
  // valid catalog — those render catalog-only, matching HCC's shipped catch-path
  // behavior (host-context-controller/src/networkPolicyReconciler.ts:1225-1271 →
  // externalEgressAccumulator.ts:138 unconditional union).
  //
  // G1: keys on the STRUCTURED `failureKind === 'absent'` — never a blocked answer,
  //     never a parsed error string. A blocked answer stays fatal.
  // G2: the exemption is quantified POSITIONALLY over `providerRanges` (index-aligned
  //     with `externals`): a fqdn is exempt only if it is declared as a provider AND
  //     EVERY declaration carrying it is provider-backed with a non-empty catalog. One
  //     exact-host sibling on the same fqdn (empty providerRanges[i]) forces the whole
  //     fqdn back to fatal — this is what closes the round-4 co-declared-exact-host
  //     leak (commit 36b36497) structurally, keyed on declarations not fqdns.
  private partitionPermanentEgressFailures(
    externals: Array<{ fqdn: string }>,
    providerRanges: Array<string[] | undefined>,
    failures: EgressResolutionFailure[]
  ): { fatal: EgressResolutionFailure[]; exempted: EgressResolutionFailure[] } {
    const fullyProviderBacked = (fqdn: string): boolean =>
      externals.some((e, i) => e.fqdn === fqdn && (providerRanges[i]?.length ?? 0) > 0) &&
      externals.every((e, i) => e.fqdn !== fqdn || (providerRanges[i]?.length ?? 0) > 0)
    const isExempt = (f: EgressResolutionFailure): boolean =>
      f.failureKind === 'absent' && fullyProviderBacked(f.fqdn)
    const permanent = failures.filter(f => !f.retryable)
    return {
      fatal: permanent.filter(f => !isExempt(f)),
      exempted: permanent.filter(isExempt),
    }
  }

  // G3 observability (drift-canary parity: metric + throttled warn, NO status
  // condition — matches externalEgressProviderDriftTotal). The exemption removes the
  // terminal `failed` phase, so a provider host served catalog-only while its DNS is
  // sinkholed must still be visible/alertable.
  private permanentDnsExemptedLastWarned = new Map<string, number>()
  private recordPermanentDnsExemptions(
    recipeName: string,
    policyName: string,
    namespace: string,
    exempted: EgressResolutionFailure[]
  ): void {
    const key = `${namespace}/${policyName}`
    if (exempted.length === 0) {
      this.permanentDnsExemptedLastWarned.delete(key)
      return
    }
    for (const f of exempted) {
      externalEgressPermanentDnsExemptedTotal.inc({ recipe: recipeName, fqdn: f.fqdn })
    }
    const now = Date.now()
    // Expire stale throttle entries (age >= window can never suppress a warn), so a
    // deleted recipe / removed binding stops leaking map keys — same pattern as the
    // drift throttle above.
    for (const [k, t] of this.permanentDnsExemptedLastWarned) {
      if (now - t >= 3_600_000) this.permanentDnsExemptedLastWarned.delete(k)
    }
    const last = this.permanentDnsExemptedLastWarned.get(key)
    if (last !== undefined && now - last < 3_600_000) return
    this.permanentDnsExemptedLastWarned.set(key, now)
    const detail = exempted.map(f => `${f.fqdn} (${f.error})`).join('; ')
    console.warn(
      `[WR-Reconciler] ${namespace}/${policyName}: serving provider catalog-only despite a ` +
        `permanent DNS failure: ${detail} — the residual /32 window will decay to catalog-only ` +
        `until DNS recovers (issue #299 seam rule)`
    )
  }

  private async reconcileUiEgressPolicy(recipe: WorkflowRecipeCRD): Promise<void> {
    const policyName = `ui-egress-${recipe.metadata.name}`
    const ns = this.config.sandboxUiNamespace

    const externals = recipe.spec.ui?.egress?.external ?? []
    const label = `WorkflowRecipe "${recipe.metadata.name}" ui external egress`
    const { resolved, failures } = await resolveExternalEgress(externals, this.fqdnLookup)
    this.recordExternalEgressTtl(resolved)

    // issue #299 Phase 2 seam rule (docs/architecture/issue-299-phase2-dns-failure-seam.md).
    // Resolve provider ranges from the catalog FIRST (H3-by-throw: an invalid/empty
    // catalog or CM outage throws HERE — row 9 — before any exemption is computed),
    // so the permanent-failure gate below can render a provider binding's catalog
    // CIDRs even when its DNS answer is permanently ABSENT (NXDOMAIN/no-records),
    // matching HCC's shipped catch-path behavior. This is index-aligned with
    // `externals` (positional per PR335-WRC-002) and reused by the accumulator below.
    const providerRanges =
      externals.length > 0
        ? await this.resolveProviderRangesPerDeclaration(
            externals.map(e => ({ fqdn: e.fqdn, provider: e.provider })),
            label
          )
        : []

    // Seam rule: a permanent (non-retryable) failure fails the recipe loud UNLESS it
    // is an ABSENT answer for a fully-provider-backed fqdn (G1 structured `blocked`
    // discriminator + G2 positional every-quantifier). A BLOCKED answer, or ANY
    // exact-host sibling on the same fqdn, keeps the whole-policy throw — H3-by-throw
    // retains the live NP, so even an exempted sibling does not render that round.
    const { fatal, exempted } = this.partitionPermanentEgressFailures(
      externals,
      providerRanges,
      failures
    )
    if (fatal.length > 0) {
      throw egressResolutionError(`${label} resolution failed`, fatal)
    }
    this.recordPermanentDnsExemptions(recipe.metadata.name, policyName, ns, exempted)

    let effectiveResolved: rb.ResolvedExternalEgressInput[] = resolved
    let stateAnnotations: Record<string, string> | undefined
    let existing: k8s.V1NetworkPolicy | null = null
    let egressRenewalDue = false
    // H-E: the write gate compares rendered spec.egress (ipBlock cidr+port, no
    // fqdn), so a rename old.example.com→new.example.com onto the SAME ip/port is
    // spec-identical and would be skipped, discarding the re-attributed state
    // annotation and losing the overlap grace when the new name later rotates.
    // acc.changed is over (fqdn,ip,port,protocol), so it catches the rename.
    let egressStateChanged = false
    // R1-M2: read the live policy for ALL cases, not only external egress, so an
    // internal-only sibling policy (ui.egress.internal[] with no external[]) can
    // hit the no-op gate below instead of being rewritten on every reconcile —
    // which the 60s external-egress refresh loop amplifies for mixed recipes. For
    // external egress it also seeds the accumulator's rehydration (H5).
    existing = await this.readNetworkPolicyOrNull(policyName, ns)
    if (externals.length > 0) {
      // providerRanges resolved above (seam-rule reorder) — reused here.
      // issue #299: fold this DNS snapshot into the accumulated sliding-window
      // set persisted on the live policy's annotations (rehydrate H5).
      const acc = accumulateExternalEgress({
        externals: externals.map((e, i) => ({
          fqdn: e.fqdn,
          port: e.port,
          providerRanges: providerRanges[i],
        })),
        resolveResult: { resolved, failures },
        previousAnnotations: existing?.metadata?.annotations,
        now: Date.now(),
        config: {
          overlapMs: this.config.externalEgressOverlapSeconds * 1000,
          maxEntries: this.config.externalEgressMaxEntries,
        },
      })
      // Bootstrap fail-closed: a transient resolver failure with NOTHING to
      // serve must not author an empty policy. PR335 Fix 2: key on acc.resolved
      // (catalog range rules + residual /32 window), NOT acc.entries — provider
      // catalog CIDRs are partitioned OUT of the /32 window and live only in
      // acc.resolved, so a transient DNS failure with catalog CIDRs in hand must
      // still render them. With no provider declared, resolved mirrors entries
      // (no rangeRules), so Phase-1 behavior is unchanged.
      if (acc.resolved.length === 0 && failures.length > 0) {
        throw egressResolutionError(
          `WorkflowRecipe "${recipe.metadata.name}" ui external egress resolution failed`,
          failures
        )
      }
      // Audit L3: a transient failure of a newly-added FQDN (with resolving
      // siblings) does not throw and freezes nothing — surface it so the missing
      // egress until the next refresh is not silent.
      if (failures.length > 0) {
        console.warn(
          `[WR-Reconciler] ${policyName}: ${failures.length} external egress FQDN(s) failed to resolve this round; policy written without them until the next refresh converges: ${failures
            .map(f => `${f.fqdn} (${f.retryable ? 'transient' : 'permanent'})`)
            .join(', ')}`
        )
      }
      this.warnEgressAccumulator(policyName, acc)
      // Defense-in-depth (audit M3): rehydrated IPs bypass the fresh CIDR gate,
      // so re-validate the effective set against blocked ranges before rendering.
      effectiveResolved = acc.resolved.filter(
        r => !isBlockedExternalIPv4(r.cidr.replace(/\/\d+$/, ''))
      )
      stateAnnotations = this.withProviderProvenance(acc.annotations, externals, providerRanges)
      egressRenewalDue = acc.renewalDue
      egressStateChanged = acc.changed
      for (const [driftFqdn, driftIps] of Object.entries(acc.uncoveredFreshIpsByFqdn)) {
        if (driftIps.length > 0) {
          externalEgressProviderDriftTotal.inc({ recipe: recipe.metadata.name, fqdn: driftFqdn })
        }
      }
      this.warnProviderDrift(policyName, ns, acc.uncoveredFreshIpsByFqdn)

      this.assertClusterEnforcesExternalEgress(
        recipe,
        'WRC sandbox-ui external egress policy is ready to apply'
      )
    }

    const policy = rb.buildUiEgressNetworkPolicy(
      recipe,
      ns,
      this.config.sandboxNamespace,
      effectiveResolved,
      stateAnnotations
    )

    if (!policy) {
      await this.safeDelete(
        () => this.networkingApi.deleteNamespacedNetworkPolicy({ name: policyName, namespace: ns }),
        `NetworkPolicy "${policyName}" in ${ns}`
      )
      return
    }

    // issue #299: NO-OP when the accumulated egress set and rules are already
    // live — a TTL-only refresh must not churn the apiserver/dataplane. But DO
    // write when the persisted window is aging (renewalDue, audit M1), even if
    // the set is unchanged, so a stable-then-rotated IP keeps its overlap grace.
    if (!this.egressWriteNeeded(existing, policy) && !egressRenewalDue && !egressStateChanged) {
      console.log(
        `[WR-Reconciler] NetworkPolicy "${policyName}" in ${ns} egress set unchanged — no-op`
      )
      return
    }

    await this.createOrReplace(
      () =>
        this.networkingApi.createNamespacedNetworkPolicy({
          namespace: ns,
          body: policy,
        }),
      async () => {
        const existing = await this.networkingApi.readNamespacedNetworkPolicy({
          name: policyName,
          namespace: ns,
        })
        policy.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.networkingApi.replaceNamespacedNetworkPolicy({
          name: policyName,
          namespace: ns,
          body: policy,
        })
      },
      `NetworkPolicy "${policyName}" in ${ns}`
    )
  }

  /**
   * Reconcile the symmetric ingress NetworkPolicies for
   * `spec.ui.egress.internal[]`. `reconcileUiEgressPolicy` only opens the
   * egress side on the sandbox-ui pod; each declared target workload also
   * needs an ingress allowance or it stays behind `deny-all-<ns>` and
   * UI→backend traffic is dropped.
   *
   * Converges with the spec: one `ui-ingress-<recipe>-<workload>` policy per
   * distinct `internal[].workloadRef` (ports aggregated), and any workload
   * no longer referenced has its stale policy reaped — mirrors the
   * ingress-side handling in `reconcileWorkloadEgressPolicies`.
   */
  private async reconcileUiIngressPolicies(recipe: WorkflowRecipeCRD): Promise<void> {
    const ns = this.config.sandboxNamespace
    const internal = recipe.spec.ui?.egress?.internal ?? []

    // Aggregate declared ports per target workload.
    const portsByWorkload = new Map<string, Set<number>>()
    for (const rule of internal) {
      const ports = portsByWorkload.get(rule.workloadRef) ?? new Set<number>()
      ports.add(rule.port)
      portsByWorkload.set(rule.workloadRef, ports)
    }

    for (const w of recipe.spec.workloads ?? []) {
      const ports = portsByWorkload.get(w.id)
      if (!ports || ports.size === 0) {
        await this.deleteUiIngressIfExists(recipe.metadata.name, w.id, ns)
        continue
      }
      const policy = rb.buildUiIngressNetworkPolicy(
        recipe,
        w.id,
        [...ports],
        ns,
        this.config.sandboxUiNamespace
      )
      if (!policy) {
        await this.deleteUiIngressIfExists(recipe.metadata.name, w.id, ns)
        continue
      }
      await this.applyNetworkPolicy(policy, ns)
    }
  }

  private async deleteUiIngressIfExists(
    recipeName: string,
    workloadId: string,
    namespace: string
  ): Promise<void> {
    const name = rb.uiIngressPolicyName(recipeName, workloadId)
    await this.safeDelete(
      () => this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace }),
      `NetworkPolicy "${name}" in ${namespace}`
    )
  }

  private internalDependencyCondition(
    status: 'True' | 'False' | 'Unknown',
    reason:
      | 'Reconciled'
      | 'InvalidInternalDependency'
      | 'OwnershipConflict'
      | 'PolicyApplyFailed'
      | 'NotEvaluated',
    message: string
  ): StatusCondition {
    return {
      type: 'InternalDependenciesReady',
      status,
      reason,
      message,
      lastTransitionTime: new Date().toISOString(),
    }
  }

  private async reconcileInternalDependencyPolicies(
    recipe: WorkflowRecipeCRD
  ): Promise<StatusCondition[]> {
    const workloads = recipe.spec.workloads ?? []
    if (workloads.length === 0) {
      return [
        this.internalDependencyCondition(
          'Unknown',
          'NotEvaluated',
          'WorkflowRecipe has no workloads to evaluate for internal dependencies'
        ),
      ]
    }

    const evaluation = evaluateInternalDependencies({
      recipe,
      workloads,
      uiWorkloadId: recipe.spec.ui?.workloadRef,
      // Only the WRC runtime namespace is strict for inferred internal dependencies.
      // mcp-server is shared/HCC-owned for unresolved MCP FQDNs, and sandbox-ui
      // stays on the explicit UI egress/ingress lane.
      strictUnknownTargetNamespaces: [this.config.sandboxNamespace],
      resolveNamespace: workload =>
        this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef),
    })

    if (evaluation.issues.length > 0) {
      const reason: InternalDependencyIssueReason = evaluation.issues.some(
        issue => issue.reason === 'OwnershipConflict'
      )
        ? 'OwnershipConflict'
        : 'InvalidInternalDependency'
      try {
        await this.pruneStaleInternalDependencyPolicies(recipe, new Map())
      } catch (error) {
        return [
          this.internalDependencyCondition(
            'False',
            'PolicyApplyFailed',
            `Failed to prune stale internal-dependency policies for WorkflowRecipe "${recipe.metadata.name}": ${String(error)}`
          ),
        ]
      }
      return [
        this.internalDependencyCondition(
          'False',
          reason,
          evaluation.issues.map(issue => issue.message).join('; ')
        ),
      ]
    }

    const workloadById = new Map(workloads.map(workload => [workload.id, workload]))
    const targetsBySource = new Map<
      string,
      Array<{
        targetWorkloadId: string
        targetNamespace: string
        port: number
        protocol: 'TCP' | 'UDP'
      }>
    >()
    const sourcesByTarget = new Map<
      string,
      Array<{
        sourceWorkloadId: string
        sourceNamespace: string
        port: number
        protocol: 'TCP' | 'UDP'
      }>
    >()

    for (const dep of evaluation.dependencies) {
      const targets = targetsBySource.get(dep.sourceWorkloadId) ?? []
      targets.push({
        targetWorkloadId: dep.targetWorkloadId,
        targetNamespace: dep.targetNamespace,
        port: dep.port,
        protocol: dep.protocol,
      })
      targetsBySource.set(dep.sourceWorkloadId, targets)

      const sources = sourcesByTarget.get(dep.targetWorkloadId) ?? []
      sources.push({
        sourceWorkloadId: dep.sourceWorkloadId,
        sourceNamespace: dep.sourceNamespace,
        port: dep.port,
        protocol: dep.protocol,
      })
      sourcesByTarget.set(dep.targetWorkloadId, sources)
    }

    const desiredByNamespace = new Map<string, Set<string>>()
    const rememberDesired = (policy: k8s.V1NetworkPolicy): void => {
      const namespace = policy.metadata?.namespace
      const name = policy.metadata?.name
      if (!namespace || !name) return
      const names = desiredByNamespace.get(namespace) ?? new Set<string>()
      names.add(name)
      desiredByNamespace.set(namespace, names)
    }

    try {
      for (const [sourceWorkloadId, targets] of targetsBySource.entries()) {
        const source = workloadById.get(sourceWorkloadId)
        if (!source) continue
        const sourceNamespace = this.resolveWorkloadNamespace(source, recipe.spec.ui?.workloadRef)
        const policy = buildInternalDependencyEgressNetworkPolicy(
          source,
          recipe,
          sourceNamespace,
          targets
        )
        if (!policy) continue
        rememberDesired(policy)
        await this.applyNetworkPolicy(policy, sourceNamespace)
      }

      for (const [targetWorkloadId, sources] of sourcesByTarget.entries()) {
        const target = workloadById.get(targetWorkloadId)
        if (!target) continue
        const targetNamespace = this.resolveWorkloadNamespace(target, recipe.spec.ui?.workloadRef)
        const policy = buildInternalDependencyIngressNetworkPolicy(
          target,
          recipe,
          targetNamespace,
          sources
        )
        if (!policy) continue
        rememberDesired(policy)
        await this.applyNetworkPolicy(policy, targetNamespace)
      }

      await this.pruneStaleInternalDependencyPolicies(recipe, desiredByNamespace)
    } catch (error) {
      const reason =
        error instanceof NetworkPolicyOwnershipConflictError
          ? 'OwnershipConflict'
          : 'PolicyApplyFailed'
      return [
        this.internalDependencyCondition(
          'False',
          reason,
          `Failed to reconcile WRC internal-dependency NetworkPolicies for WorkflowRecipe "${recipe.metadata.name}": ${String(error)}`
        ),
      ]
    }

    return [
      this.internalDependencyCondition(
        'True',
        'Reconciled',
        evaluation.dependencies.length === 0
          ? 'No WRC internal dependencies declared or inferred'
          : `Reconciled ${evaluation.dependencies.length} WRC internal dependency rule(s)`
      ),
    ]
  }

  private async cleanupInternalDependencyPolicies(recipe: WorkflowRecipeCRD): Promise<void> {
    await this.pruneStaleInternalDependencyPolicies(recipe, new Map())
  }

  private async pruneStaleInternalDependencyPolicies(
    recipe: WorkflowRecipeCRD,
    desiredByNamespace: Map<string, Set<string>>
  ): Promise<void> {
    const namespaces = new Set<string>([
      this.config.sandboxNamespace,
      this.config.namespace,
      this.config.sandboxUiNamespace,
      ...desiredByNamespace.keys(),
    ])
    const labelSelector = [
      'clerum.io/managed-by=workflow-recipes',
      `${NETWORK_POLICY_TYPE_LABEL}=${INTERNAL_DEPENDENCY_POLICY_TYPE}`,
      `clerum.io/recipe=${recipe.metadata.name}`,
    ].join(',')

    for (const namespace of namespaces) {
      const list = (await this.networkingApi.listNamespacedNetworkPolicy({
        namespace,
        labelSelector,
      })) as k8s.V1NetworkPolicyList
      const desiredNames = desiredByNamespace.get(namespace) ?? new Set<string>()
      for (const policy of list.items ?? []) {
        const name = policy.metadata?.name
        if (!name || desiredNames.has(name)) continue
        try {
          await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace })
          console.log(
            `[WR-Reconciler] Deleted stale internal-dependency NetworkPolicy "${name}" in ${namespace}`
          )
        } catch (error) {
          if (getErrorCode(error) !== 404) throw error
        }
      }
    }
  }

  /**
   * Reconcile per-workload egress NetworkPolicies for each workload that
   * declares `egressBindings[]`. Also emits the symmetric ingress policy
   * on any sibling target that other workloads point at, so cluster-local
   * `<svc>.<ns>.svc.cluster.local` rules open both sides without authors
   * having to re-declare in `spec.bindings[]`.
   *
   * MCP workloads (with `transport`) are skipped — their egress is
   * configured by HCC via the McpServer CRD path. UI workloads use
   * `spec.ui.egress.*` and are handled by reconcileUiEgressPolicy.
   *
   * FQDN resolution fails closed. A stale or partial NetworkPolicy would be a
   * silent authorization drift, so any unresolved or blocked hostname fails
   * the reconcile before policy apply.
   */
  private async reconcileWorkloadEgressPolicies(recipe: WorkflowRecipeCRD): Promise<void> {
    const workloads = recipe.spec.workloads ?? []
    if (workloads.length === 0) return
    const uiWorkloadId = recipe.spec.ui?.workloadRef

    // Aggregate ingress sources keyed by target workload id. Filled as we
    // walk each source workload's cluster-local bindings.
    const ingressSourcesByTarget = new Map<string, rb.WorkloadIngressSource[]>()

    for (const w of workloads) {
      // Skip MCP + UI workloads — covered by other code paths.
      if (w.transport) continue
      if (uiWorkloadId && w.id === uiWorkloadId) continue
      const wlNs = this.resolveWorkloadNamespace(w, uiWorkloadId)
      const bindings = w.egressBindings ?? []
      if (bindings.length === 0) {
        // Reap any policy left over from a previous reconcile that DID
        // have bindings — keeps the policy set in lockstep with the spec.
        await this.deleteWorkloadEgressIfExists(recipe.metadata.name, w.id, wlNs)
        continue
      }

      // Split into cluster-local sibling targets vs external FQDNs.
      const externalDeclared: {
        fqdn: string
        port: number
        provider?: { name: string; categories?: string[] }
      }[] = []
      for (const b of bindings) {
        if (!b.dns || b.port == null) continue
        const port = b.port
        const resolved = rb.resolveClusterLocalBinding(b.dns, recipe, wlNs)
        if (resolved && resolved.kind === 'cluster-local') {
          const sources = ingressSourcesByTarget.get(resolved.workloadId) ?? []
          sources.push({
            fromWorkloadId: w.id,
            fromNamespace: wlNs,
            port,
            protocol: (b.protocol ?? 'TCP') as 'TCP' | 'UDP',
          })
          ingressSourcesByTarget.set(resolved.workloadId, sources)
        } else if (!resolved) {
          // null = treat as external FQDN
          externalDeclared.push({
            fqdn: b.dns,
            port,
            provider: b.egressClass === 'provider' ? b.provider : undefined,
          })
        }
        // resolved.kind === 'mismatch' is unreachable here — validation
        // ran upstream and would have thrown.
      }

      const wlLabel = `WorkflowRecipe "${recipe.metadata.name}" workload "${w.id}" egress`
      const wlPolicyName = rb.workloadEgressPolicyName(recipe.metadata.name, w.id)
      const { resolved: resolvedExternal, failures } = await resolveExternalEgress(
        externalDeclared.map(e => ({ fqdn: e.fqdn, port: e.port })),
        this.fqdnLookup
      )
      this.recordExternalEgressTtl(resolvedExternal)

      // issue #299 Phase 2 seam rule (docs/architecture/issue-299-phase2-dns-failure-seam.md).
      // Mirror of the UI path: resolve provider ranges FIRST (invalid/empty catalog or
      // CM outage throws here — row 9), then exempt an ABSENT permanent failure for a
      // fully-provider-backed fqdn so its catalog renders (matching HCC); a BLOCKED
      // answer or any exact-host sibling keeps the whole-policy throw (H3-by-throw).
      const providerRanges =
        externalDeclared.length > 0
          ? await this.resolveProviderRangesPerDeclaration(
              externalDeclared.map(e => ({ fqdn: e.fqdn, provider: e.provider })),
              wlLabel
            )
          : []
      const { fatal, exempted } = this.partitionPermanentEgressFailures(
        externalDeclared,
        providerRanges,
        failures
      )
      if (fatal.length > 0) {
        throw egressResolutionError(`${wlLabel} resolution failed`, fatal)
      }
      this.recordPermanentDnsExemptions(recipe.metadata.name, wlPolicyName, wlNs, exempted)

      let effectiveExternal: rb.ResolvedExternalEgressInput[] = resolvedExternal
      let wlStateAnnotations: Record<string, string> | undefined
      let existingWlPolicy: k8s.V1NetworkPolicy | null = null
      let wlEgressRenewalDue = false
      let wlEgressStateChanged = false // H-E: catch fqdn-attribution-only changes
      // R1-M2: read the live policy for ALL cases so an internal-only (cluster-
      // local) workload egress policy hits the no-op gate instead of churning
      // every reconcile; for external egress it also seeds rehydration (H5).
      existingWlPolicy = await this.readNetworkPolicyOrNull(wlPolicyName, wlNs)
      if (externalDeclared.length > 0) {
        // providerRanges resolved above (seam-rule reorder) — reused here.
        // issue #299: accumulate the sliding-window egress set (rehydrate H5).
        const acc = accumulateExternalEgress({
          externals: externalDeclared.map((e, i) => ({
            fqdn: e.fqdn,
            port: e.port,
            providerRanges: providerRanges[i],
          })),
          resolveResult: { resolved: resolvedExternal, failures },
          previousAnnotations: existingWlPolicy?.metadata?.annotations,
          now: Date.now(),
          config: {
            overlapMs: this.config.externalEgressOverlapSeconds * 1000,
            maxEntries: this.config.externalEgressMaxEntries,
          },
        })
        // Bootstrap fail-closed: transient failure with nothing to serve.
        // PR335 Fix 2: key on acc.resolved (catalog range rules + residual /32
        // window), NOT acc.entries — provider catalog CIDRs are partitioned OUT
        // of the /32 window and live only in acc.resolved. With no provider
        // declared, resolved mirrors entries, so Phase-1 behavior is unchanged.
        if (acc.resolved.length === 0 && failures.length > 0) {
          throw egressResolutionError(
            `WorkflowRecipe "${recipe.metadata.name}" workload "${w.id}" egress resolution failed`,
            failures
          )
        }
        // Audit L3 (mirrors the ui.egress path): a transient failure of a newly-
        // added FQDN with resolving siblings does not throw and freezes nothing —
        // surface it so the missing egress until the next refresh is not silent.
        if (failures.length > 0) {
          console.warn(
            `[WR-Reconciler] ${wlPolicyName}: ${failures.length} external egress FQDN(s) failed to resolve this round; policy written without them until the next refresh converges: ${failures
              .map(f => `${f.fqdn} (${f.retryable ? 'transient' : 'permanent'})`)
              .join(', ')}`
          )
        }
        this.warnEgressAccumulator(wlPolicyName, acc)
        // Defense-in-depth (audit M3): re-validate rehydrated IPs vs blocked ranges.
        effectiveExternal = acc.resolved.filter(
          r => !isBlockedExternalIPv4(r.cidr.replace(/\/\d+$/, ''))
        )
        wlStateAnnotations = this.withProviderProvenance(
          acc.annotations,
          externalDeclared,
          providerRanges
        )
        wlEgressRenewalDue = acc.renewalDue
        wlEgressStateChanged = acc.changed
        for (const [driftFqdn, driftIps] of Object.entries(acc.uncoveredFreshIpsByFqdn)) {
          if (driftIps.length > 0) {
            externalEgressProviderDriftTotal.inc({ recipe: recipe.metadata.name, fqdn: driftFqdn })
          }
        }
        this.warnProviderDrift(wlPolicyName, wlNs, acc.uncoveredFreshIpsByFqdn)

        this.assertClusterEnforcesExternalEgress(
          recipe,
          `WRC workload "${w.id}" external egress policy is ready to apply`
        )
      }

      const policy = rb.buildWorkloadEgressNetworkPolicy(
        w,
        recipe,
        wlNs,
        effectiveExternal,
        wlStateAnnotations
      )
      if (!policy) {
        await this.deleteWorkloadEgressIfExists(recipe.metadata.name, w.id, wlNs)
        continue
      }
      // issue #299: NO-OP when the accumulated set and rules are already live —
      // but still write when the persisted window is aging (renewalDue, M1).
      if (
        !this.egressWriteNeeded(existingWlPolicy, policy) &&
        !wlEgressRenewalDue &&
        !wlEgressStateChanged
      ) {
        console.log(
          `[WR-Reconciler] NetworkPolicy "${wlPolicyName}" in ${wlNs} egress set unchanged — no-op`
        )
        continue
      }
      await this.applyNetworkPolicy(policy, wlNs)
    }

    // Now ingress side: for each target workload that any sibling pointed
    // at, build/apply the ingress policy; for everyone else, clear stale.
    for (const w of workloads) {
      if (w.transport) continue
      if (uiWorkloadId && w.id === uiWorkloadId) continue
      const wlNs = this.resolveWorkloadNamespace(w, uiWorkloadId)
      const sources = ingressSourcesByTarget.get(w.id) ?? []
      if (sources.length === 0) {
        await this.deleteWorkloadIngressIfExists(recipe.metadata.name, w.id, wlNs)
        continue
      }
      const policy = rb.buildWorkloadIngressNetworkPolicy(w, recipe, wlNs, sources)
      if (!policy) {
        await this.deleteWorkloadIngressIfExists(recipe.metadata.name, w.id, wlNs)
        continue
      }
      await this.applyNetworkPolicy(policy, wlNs)
    }
  }

  private assertInternalDependencyPolicyOwnership(
    desired: k8s.V1NetworkPolicy,
    existing: k8s.V1NetworkPolicy,
    namespace: string
  ): void {
    const desiredLabels = desired.metadata?.labels ?? {}
    if (desiredLabels[NETWORK_POLICY_TYPE_LABEL] !== INTERNAL_DEPENDENCY_POLICY_TYPE) return

    const existingLabels = existing.metadata?.labels ?? {}
    const desiredName = desired.metadata?.name ?? '<unknown>'
    const desiredRecipe = desiredLabels['clerum.io/recipe']
    const ownsSameLane =
      existingLabels['clerum.io/managed-by'] === 'workflow-recipes' &&
      existingLabels[NETWORK_POLICY_TYPE_LABEL] === INTERNAL_DEPENDENCY_POLICY_TYPE &&
      existingLabels['clerum.io/recipe'] === desiredRecipe

    if (!ownsSameLane) {
      throw new NetworkPolicyOwnershipConflictError(
        `Refusing to replace NetworkPolicy "${desiredName}" in ${namespace}: existing policy is not the WRC internal-dependency policy for WorkflowRecipe "${desiredRecipe}"`
      )
    }
  }

  /**
   * Read a NetworkPolicy for rehydration/no-op, returning null when it does not
   * yet exist. Fails LOUD on any non-404 read error (issue #299): a rehydration
   * we cannot perform must not silently blank the accumulated egress state.
   */
  private async readNetworkPolicyOrNull(
    name: string,
    namespace: string
  ): Promise<k8s.V1NetworkPolicy | null> {
    try {
      return await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) return null
      throw error
    }
  }

  /**
   * True when the live policy differs from the desired one and must be written
   * (issue #299 NO-OP gate). Compares the accumulated-state fingerprint AND the
   * enforced egress rules, so a change to either the external IP set OR the
   * internal (sibling) rules still triggers a write — only a byte-for-byte match
   * is a no-op.
   */
  /**
   * The smallest DNS TTL (ms) observed so far across external-egress
   * resolutions, or Infinity if none. The k8s refresh loop reads this to advance
   * to <= TTL/2 (H2, issue #299).
   */
  get externalEgressRefreshMinTtlMs(): number {
    return this.externalEgressMinObservedTtlMs
  }

  /**
   * Ratchet the observed-min-TTL down from this round's resolved entries. Only
   * positive TTLs count (an empty/A-less answer yields ttlSeconds 0, which is not
   * a real refresh cadence).
   */
  private recordExternalEgressTtl(resolved: Array<{ ttlSeconds: number }>): void {
    for (const r of resolved) {
      if (r.ttlSeconds > 0) {
        this.externalEgressMinObservedTtlMs = Math.min(
          this.externalEgressMinObservedTtlMs,
          r.ttlSeconds * 1000
        )
      }
    }
  }

  private egressWriteNeeded(
    existing: k8s.V1NetworkPolicy | null,
    desired: k8s.V1NetworkPolicy
  ): boolean {
    if (!existing) return true
    // Decide the write off the ENFORCED rules (the ipBlock set + ports), NOT the
    // raw state annotation: serializeState embeds expiresAt/lastObservedAt, which
    // renew on every OK tick, so comparing the annotation string would rewrite
    // the policy every refresh even when the IP set is identical — an apiserver /
    // dataplane write-storm (issue #299 audit F2). H4: a timestamp-only refresh
    // must be a no-op.
    if (egressSignature(existing) !== egressSignature(desired)) {
      return true
    }
    // Rules are identical. Persist the new-format state annotation exactly once to
    // migrate an EXTERNAL-egress policy that predates it, so a controller restart
    // can rehydrate the accumulated window; thereafter (annotation present, egress
    // unchanged) it is a no-op. R1-M2: gate on the DESIRED carrying a state
    // annotation — an internal-only policy never has one, so without this guard it
    // would return true forever and be rewritten every reconcile (mirrors HCC's
    // externalEgressWriteNeeded).
    const desiredState = desired.metadata?.annotations?.[STATE_ANNOTATION]
    return Boolean(desiredState) && !existing.metadata?.annotations?.[STATE_ANNOTATION]
  }

  /**
   * Surface the accumulator's staleness/pressure alarms (issue #299): a frozen
   * FQDN means the resolver is transiently failing and we are serving last-known
   * IPs (fail-static, H1); an over-cap eviction means the pool exceeded the
   * alarm cap and least-recently-observed entries were dropped (H3).
   */
  private warnEgressAccumulator(policyName: string, acc: AccumulateOutput): void {
    if (acc.frozenFqdns.length > 0) {
      console.warn(
        `[WR-Reconciler] ${policyName}: egress set FROZEN (fail-static) for ${acc.frozenFqdns.join(
          ', '
        )} — DNS resolution is transiently failing; serving last-known IPs, not pruning.`
      )
    }
    if (acc.overCap) {
      console.warn(
        `[WR-Reconciler] ${policyName}: egress set hit the maxEntries cap — evicted ${acc.evicted.length} least-recently-observed entr${
          acc.evicted.length === 1 ? 'y' : 'ies'
        } (never rejecting the policy).`
      )
    }
  }

  private async applyNetworkPolicy(policy: k8s.V1NetworkPolicy, namespace: string): Promise<void> {
    const policyName = policy.metadata!.name!
    await this.createOrReplace(
      () =>
        this.networkingApi.createNamespacedNetworkPolicy({
          namespace,
          body: policy,
        }),
      async () => {
        const existing = await this.networkingApi.readNamespacedNetworkPolicy({
          name: policyName,
          namespace,
        })
        this.assertInternalDependencyPolicyOwnership(policy, existing, namespace)
        policy.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.networkingApi.replaceNamespacedNetworkPolicy({
          name: policyName,
          namespace,
          body: policy,
        })
      },
      `NetworkPolicy "${policyName}" in ${namespace}`
    )
  }

  private coordinatorGfsNetworkPolicy(recipe: WorkflowRecipeCRD): k8s.V1NetworkPolicy {
    return buildCoordinatorGfsNetworkPolicy({
      recipeName: recipe.metadata.name,
      sandboxNamespace: this.config.sandboxNamespace,
    })
  }

  private buildWorkflowRuntimeSpec(recipe: WorkflowRecipeCRD) {
    const computedMcpServers = (recipe.spec.workloads ?? [])
      .filter(workload => workload.transport != null && workload.port != null)
      .map(workload => ({
        id: workload.id,
        endpoint: `http://${mcpServerName(recipe.metadata.name, workload.id, recipe)}.${this.config.namespace}.svc.cluster.local:${workload.port!}${workload.transport?.path ?? '/mcp'}`,
      }))
    const mergedMcpServers = new Map<string, { id: string; endpoint: string }>()
    for (const server of (recipe.spec.mcpServers ?? []) as Array<{
      id: string
      endpoint?: string
    }>) {
      if (server.id && server.endpoint) {
        mergedMcpServers.set(server.id, { id: server.id, endpoint: server.endpoint })
      }
    }
    for (const server of computedMcpServers) mergedMcpServers.set(server.id, server)

    let unresolvedMcpServerMessage: string | undefined
    for (const step of recipe.spec.steps ?? []) {
      for (const serverId of (step as { mcpServers?: string[] }).mcpServers ?? []) {
        if (!mergedMcpServers.has(serverId)) {
          unresolvedMcpServerMessage = `Step "${step.id}" references MCP server "${serverId}" not found in MCP workloads or mcpServers (with endpoint)`
          break
        }
      }
      if (unresolvedMcpServerMessage) break
    }

    return {
      unresolvedMcpServerMessage,
      workflowRuntimeSpec: {
        coordinatorImage: recipe.spec.coordinatorImage,
        agent: recipe.spec.agent as import('../workflow/types').AgentSpec | undefined,
        inputContract: recipe.spec.inputContract,
        steps: recipe.spec.steps! as import('../workflow/types').StepSpec[],
        mcpServers: [...mergedMcpServers.values()] as Array<{ id: string; endpoint: string }>,
        output: recipe.spec.output as import('../workflow/types').OutputSpec | undefined,
        runtimeEgress: recipe.spec.runtimeEgress,
        resources: recipe.spec.resources,
        gfs: recipe.spec.gfs,
        workloads: recipe.spec.workloads,
        triggers: recipe.spec.triggers,
        scheduling: recipe.spec.scheduling,
        pluginWorkloadSdk: recipe.spec.pluginWorkloadSdk,
      },
    }
  }

  private async ensureCoordinatorGfsNetworkPolicyIfEnabled(
    recipe: WorkflowRecipeCRD
  ): Promise<void> {
    if ((recipe.spec.gfs?.publishTargets ?? []).length === 0) return

    const namespace = this.config.sandboxNamespace
    const policy = this.coordinatorGfsNetworkPolicy(recipe)
    const name = policy.metadata!.name!
    await this.createOrReplace(
      () => this.networkingApi.createNamespacedNetworkPolicy({ namespace, body: policy }),
      async () => {
        const existing = await this.networkingApi.readNamespacedNetworkPolicy({
          name,
          namespace,
        })
        this.assertCoordinatorGfsNetworkPolicyOwnership(existing, recipe.metadata.name, namespace)
        const desiredLabels = policy.metadata?.labels ?? {}
        const existingLabels = existing.metadata?.labels ?? {}
        const labelsMatch = Object.entries(desiredLabels).every(
          ([key, value]) => existingLabels[key] === value
        )
        if (labelsMatch && JSON.stringify(existing.spec) === JSON.stringify(policy.spec)) {
          return existing
        }
        policy.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.networkingApi.replaceNamespacedNetworkPolicy({
          name,
          namespace,
          body: policy,
        })
      },
      `NetworkPolicy "${name}" in ${namespace}`
    )
  }

  private async revokeCoordinatorGfsNetworkPolicyIfDisabled(
    recipe: WorkflowRecipeCRD
  ): Promise<void> {
    if ((recipe.spec.gfs?.publishTargets ?? []).length > 0) return

    await this.revokeCoordinatorGfsNetworkPolicy(recipe)
  }

  private async revokeCoordinatorGfsNetworkPolicy(recipe: WorkflowRecipeCRD): Promise<void> {
    const namespace = this.config.sandboxNamespace
    const policy = this.coordinatorGfsNetworkPolicy(recipe)
    const name = policy.metadata!.name!
    let existing: k8s.V1NetworkPolicy
    try {
      existing = await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) return
      throw error
    }
    this.assertCoordinatorGfsNetworkPolicyOwnership(existing, recipe.metadata.name, namespace)
    const uid = existing.metadata?.uid
    const resourceVersion = existing.metadata?.resourceVersion
    if (!uid || !resourceVersion) {
      throw new NetworkPolicyOwnershipConflictError(
        `Refusing to delete NetworkPolicy "${name}" in ${namespace}: live object identity is incomplete`
      )
    }
    await this.deleteOrThrow(
      () =>
        this.networkingApi.deleteNamespacedNetworkPolicy({
          name,
          namespace,
          body: { preconditions: { uid, resourceVersion } },
        }),
      `NetworkPolicy "${name}" in ${namespace}`
    )
  }

  private assertCoordinatorGfsNetworkPolicyOwnership(
    existing: k8s.V1NetworkPolicy,
    recipeName: string,
    namespace: string
  ): void {
    const labels = existing.metadata?.labels ?? {}
    if (labels['clerum.io/managed-by'] === 'wrc' && labels['clerum.io/recipe'] === recipeName) {
      return
    }
    throw new NetworkPolicyOwnershipConflictError(
      `Refusing to mutate NetworkPolicy "${recipeName}-coordinator-to-gfs" in ${namespace}: existing policy is not owned by WRC for WorkflowRecipe "${recipeName}"`
    )
  }

  private async deleteWorkloadEgressIfExists(
    recipeName: string,
    workloadId: string,
    namespace: string
  ): Promise<void> {
    const name = rb.workloadEgressPolicyName(recipeName, workloadId)
    await this.safeDelete(
      () => this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace }),
      `NetworkPolicy "${name}" in ${namespace}`
    )
  }

  private async deleteWorkloadIngressIfExists(
    recipeName: string,
    workloadId: string,
    namespace: string
  ): Promise<void> {
    const name = rb.workloadIngressPolicyName(recipeName, workloadId)
    await this.safeDelete(
      () => this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace }),
      `NetworkPolicy "${name}" in ${namespace}`
    )
  }

  // ─── Workload Ensure Methods ──────────────────────────────────────

  /**
   * Read every Secret referenced by any workload's `envSecret.name` and
   * return the key-set per Secret. Used to decide which `optional: true`
   * envSecret keys to project into the pod spec. Also updates the Secret
   * reverse index so the Secret watcher can fan reconciles out when a
   * referenced Secret's key-set changes.
   *
   * Ownership enforcement (Path B → multi-tenant): a Secret is honored as
   * an envSecret source only when it carries either `clerum.io/shared=true`
   * or `clerum.io/owner-recipe=<this recipe's name>`. An inaccessible
   * Secret is treated as empty — optional keys silently drop, required
   * keys keep their secretKeyRef so the kubelet surfaces a clear
   * CreateContainerConfigError instead of silently injecting another
   * recipe's credential. Webhook secretRefs are not subject to this check
   * here; the webhook path does its own point-in-time read and is a
   * separate audit surface.
   */
  private async readReferencedSecrets(recipe: WorkflowRecipeCRD): Promise<rb.SecretKeysByName> {
    // Every Secret a workload references BY NAME and the builder may project:
    // `envSecret` (env vars) and `imagePullSecrets` (registry creds). Both are
    // ownership-gated (Issue #637) — a recipe may only project Secrets it owns
    // or that are explicitly shared.
    //
    // Layer 0 scope note (Issue #637): `envSecret` and `imagePullSecrets` are the
    // only WORKLOAD-PROJECTION Secret-ref surfaces this audit gates. ONE other
    // author-controllable Secret-ref surface exists in the CRD schema — snippet
    // steps' `run.capabilities.secrets[].secretRef` — but it is gated SEPARATELY,
    // at run-start, by `validateSnippetSecretRefs` (in the inner workflow
    // reconciler), which routes it through the SAME `classifySecretAccess`
    // chokepoint and fails closed before any snippet-runner pod is created. Those
    // pods are ephemeral and run-start-gated, so snippet secrets are intentionally
    // NOT part of this steady-state workload revocation; a mid-run re-label of an
    // already-running snippet pod (which legitimately owned the Secret at run
    // start) is a known LOW residual tracked as a follow-up, not a create-time
    // bypass. `env[].valueFrom.secretKeyRef`, `envFrom[].secretRef`,
    // `volumes[].secret`, projected-volume secret sources, and author-defined
    // init/sidecar/ephemeral containers are NOT in the schema, so they need no gate
    // here. If ANY of them is ever added to the CRD, this ownership audit MUST be
    // re-run and that new surface routed through the same classification (see plan
    // Addendum 1 §A).
    const referencedNames = new Set<string>()
    for (const w of recipe.spec.workloads ?? []) {
      if (w.envSecret?.name) referencedNames.add(w.envSecret.name)
      for (const pull of w.imagePullSecrets ?? []) referencedNames.add(pull)
    }
    // Indexed names also include webhook secrets so the Secret watcher can fan
    // reconciles out for every surface (envSecret, imagePullSecrets, webhooks).
    // The reconciler's webhook path does its own point-in-time read; the index
    // is only used for triggering re-reconciles on Secret events (revocation).
    const indexedNames = new Set<string>(referencedNames)
    for (const wh of recipe.spec.webhooks ?? []) {
      if (wh.verification.secretRef?.name) {
        indexedNames.add(wh.verification.secretRef.name)
      }
      if (wh.verification.setupHandshake?.secretRef?.name) {
        indexedNames.add(wh.verification.setupHandshake.secretRef.name)
      }
    }
    this.secretReverseIndex?.set(recipe.metadata.name, indexedNames)
    if (referencedNames.size === 0) return new Map()

    // Each referenced Secret resolves in the namespace its REFERENCING WORKLOAD
    // runs in (Issue #637 Critical 2): transport → mcp-server, ui → sandbox-ui,
    // the rest → sandbox-recipes. Ownership must be classified in THAT namespace —
    // the one the pod actually mounts the Secret from.
    //
    // The SAME Secret name can resolve to DIFFERENT namespaces across a recipe's
    // workloads, so we must classify it in EVERY namespace it is referenced from
    // and combine fail-closed (denied > error > accessible > missing). A first-wins
    // name→namespace map would classify the name in only ONE namespace; an attacker
    // listing a transport workload first would have a foreign Secret that lives in
    // sandbox-recipes classified in mcp-server (404 → missing), leaving the
    // non-transport pod free to project it (cross-namespace bypass — @claude review).
    // Classification stays delegated to the single classifySecretAccess chokepoint.
    const nameToNamespaces = new Map<string, Set<string>>()
    const addRef = (name: string, ns: string) => {
      const set = nameToNamespaces.get(name) ?? new Set<string>()
      set.add(ns)
      nameToNamespaces.set(name, set)
    }
    for (const w of recipe.spec.workloads ?? []) {
      const wns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
      if (w.envSecret?.name) addRef(w.envSecret.name, wns)
      for (const pull of w.imagePullSecrets ?? []) addRef(pull, wns)
    }
    const read = (name: string, namespace: string) =>
      this.coreApi.readNamespacedSecret({ name, namespace })
    const accessByName = new Map<string, rb.SecretAccess>()
    for (const [name, namespaces] of nameToNamespaces) {
      let combined: rb.SecretAccess | undefined
      for (const secretNs of namespaces) {
        const access = await classifySecretAccess(
          read,
          getErrorCode,
          name,
          secretNs,
          recipe.metadata.name
        )
        combined = combined ? combineSecretAccess(combined, access) : access
        if (access.state === 'denied') {
          console.error(
            `[WR-Reconciler] Refusing to project Secret "${name}" (ns ${secretNs}) into recipe "${recipe.metadata.name}" — not owned or shared; label clerum.io/shared=true or clerum.io/owner-recipe=${recipe.metadata.name}`
          )
        } else if (access.state === 'error') {
          console.warn(
            `[WR-Reconciler] Secret "${name}" (ns ${secretNs}) ownership could not be verified for recipe "${recipe.metadata.name}" — failing closed and requeuing`
          )
        }
      }
      // combined is always defined: every name has ≥1 referencing namespace.
      accessByName.set(name, combined ?? { state: 'error' })
    }
    return accessByName
  }

  /**
   * Issue #637 — partition workloads by whether their name-based Secret refs
   * (`envSecret` + `imagePullSecrets`) are accessible to this recipe. A workload
   * referencing an ownership-denied Secret is failed closed: not rendered + torn
   * down, and the recipe surfaces `EnvSecretOwnershipDenied` / NotReady so the
   * operator can label the Secret. A transient read error (`error` — ownership
   * could not be verified) sets `errored` so the caller requeues the whole
   * reconcile rather than risk leaking a foreign Secret OR bricking a healthy
   * recipe on an apiserver blip.
   */
  private partitionWorkloadsBySecretOwnership(
    recipe: WorkflowRecipeCRD,
    secretKeys: rb.SecretKeysByName
  ): {
    deniedWorkloadIds: Set<string>
    messageByWorkload: Map<string, string>
    conditions: StatusCondition[]
    errored: boolean
  } {
    const now = new Date().toISOString()
    const deniedWorkloadIds = new Set<string>()
    const messageByWorkload = new Map<string, string>()
    const deniedDetails: string[] = []
    let errored = false
    let hasAnyRef = false

    for (const w of recipe.spec.workloads ?? []) {
      const refs: string[] = []
      if (w.envSecret?.name) refs.push(w.envSecret.name)
      for (const pull of w.imagePullSecrets ?? []) refs.push(pull)
      if (refs.length > 0) hasAnyRef = true

      const deniedRefs: string[] = []
      for (const name of refs) {
        const state = secretKeys.get(name)?.state
        if (state === 'denied') deniedRefs.push(name)
        else if (state === 'error') errored = true
      }
      if (deniedRefs.length > 0) {
        deniedWorkloadIds.add(w.id)
        const msg =
          `Secret(s) ${deniedRefs.map(n => `"${n}"`).join(', ')} not owned by recipe ` +
          `"${recipe.metadata.name}" — label clerum.io/shared=true or ` +
          `clerum.io/owner-recipe=${recipe.metadata.name} to grant access`
        messageByWorkload.set(w.id, msg)
        deniedDetails.push(`workload "${w.id}": ${msg}`)
      }
    }

    const cond = (status: 'True' | 'False', reason: string, message: string): StatusCondition => ({
      type: 'EnvSecretOwnershipDenied',
      status,
      reason,
      message,
      lastTransitionTime: now,
    })
    const conditions: StatusCondition[] =
      deniedWorkloadIds.size > 0
        ? [cond('True', 'SecretOwnershipDenied', deniedDetails.join('; '))]
        : hasAnyRef
          ? [cond('False', 'NoForeignSecretRefs', 'All referenced Secrets are owned or shared')]
          : []

    return { deniedWorkloadIds, messageByWorkload, conditions, errored }
  }

  /**
   * Issue #637 — steady-state workflow revocation enforcement.
   *
   * A running workflow's reconcile short-circuits (the skip-guards in
   * `computeRecipePhase`) BEFORE the Step 8 ownership gate, to protect the
   * coordinator's 409-free window. That left a revocation hole: a Secret
   * re-labeled foreign mid-run was never torn down, because the SecretWatcher
   * fan-out routes through that same short-circuited reconcile. This helper runs
   * ONLY the ownership gate + targeted teardown of denied workloads — it does NOT
   * redeploy workloads or touch the coordinator, so the 409-window is preserved.
   *
   * Calling `readReferencedSecrets` also re-seeds the `SecretReverseIndex`, so
   * watcher coverage survives a WRC restart for in-flight workflow recipes (the
   * index is otherwise populated only on the first-deploy path, which a running
   * workflow skips).
   *
   * Fail-closed parity with the deploy path (which throws RetryableReconcileError
   * on `errored`): a Secret read failure, an `error`-state classification, OR a
   * failed teardown all set `needsRequeue` so the caller requeues and RETRIES,
   * rather than silently skipping or — worse — reporting `hadDenied` (which would
   * write `EnvSecretOwnershipDenied=True` while the foreign credential is still
   * live because the delete actually failed). `hadDenied` is returned ONLY when
   * every denied workload was torn down successfully.
   */
  private async enforceActiveWorkflowSecretOwnership(recipe: WorkflowRecipeCRD): Promise<{
    conditions: StatusCondition[]
    hadDenied: boolean
    needsRequeue: boolean
    requeueReason?: string
  }> {
    const clean = { conditions: [] as StatusCondition[], hadDenied: false, needsRequeue: false }
    const hasSecretRefs = (recipe.spec.workloads ?? []).some(
      w => !!w.envSecret?.name || (w.imagePullSecrets ?? []).length > 0
    )
    if (!hasSecretRefs) return clean

    let secretKeys: rb.SecretKeysByName
    try {
      secretKeys = await this.readReferencedSecrets(recipe)
    } catch (error) {
      // Read failed — do NOT silently skip (that would leave a foreign Secret
      // projected with a healthy status). Requeue and retry, matching the deploy
      // path's fail-closed contract for an unverifiable Secret.
      console.warn(
        `[WR-Reconciler] Issue #637: ownership recheck read failed for "${recipe.metadata.name}" — requeuing: ${String(error)}`
      )
      return { ...clean, needsRequeue: true, requeueReason: 'Secret read failed' }
    }

    const secretOwnership = this.partitionWorkloadsBySecretOwnership(recipe, secretKeys)
    if (secretOwnership.errored) {
      // A referenced Secret's ownership could not be verified (transient non-404
      // read). Requeue rather than risk leaking a foreign Secret — same contract
      // the deploy path enforces via RetryableReconcileError.
      return {
        ...clean,
        needsRequeue: true,
        requeueReason: 'Secret ownership could not be verified (transient read error)',
      }
    }
    if (secretOwnership.deniedWorkloadIds.size === 0) {
      return { conditions: secretOwnership.conditions, hadDenied: false, needsRequeue: false }
    }

    const failedTeardowns: string[] = []
    for (const workload of recipe.spec.workloads ?? []) {
      if (!secretOwnership.deniedWorkloadIds.has(workload.id)) continue
      console.warn(
        `[WR-Reconciler] Issue #637: revoking steady workflow workload "${workload.id}" of ` +
          `"${recipe.metadata.name}" — ${
            secretOwnership.messageByWorkload.get(workload.id) ?? 'foreign Secret ref'
          }`
      )
      try {
        await this.teardownDeniedWorkload(workload, recipe, secretKeys)
      } catch (error) {
        // Teardown FAILED (e.g. RBAC 403 / apiserver 5xx). The foreign credential
        // is still live, so we must NOT report the workload as revoked. Requeue so
        // the next pass retries; the EnvSecretOwnershipDenied condition is written
        // only once teardown actually succeeds.
        failedTeardowns.push(workload.id)
        console.error(
          `[WR-Reconciler] Issue #637: teardown FAILED for denied workload "${workload.id}" of ` +
            `"${recipe.metadata.name}" — requeuing: ${String(error)}`
        )
      }
    }
    if (failedTeardowns.length > 0) {
      return {
        ...clean,
        needsRequeue: true,
        requeueReason: `teardown failed for ${failedTeardowns.join(', ')}`,
      }
    }
    return { conditions: secretOwnership.conditions, hadDenied: true, needsRequeue: false }
  }

  /**
   * Issue #637 — run steady-state ownership enforcement at a reconcile
   * short-circuit and convert the outcome into a `ReconcileResult` the caller
   * returns directly, or `null` to let the caller fall through to its normal
   * (cheap) steady return. Centralizes the requeue/denial result shaping so all
   * four steady short-circuits (awaiting-trigger, in-progress, active, terminal)
   * stay fail-closed-consistent.
   */
  private async revokeOrRequeueSteadyWorkflow(
    recipe: WorkflowRecipeCRD,
    phase: RecipePhase
  ): Promise<ReconcileResult | null> {
    const outcome = await this.enforceActiveWorkflowSecretOwnership(recipe)
    if (outcome.needsRequeue) {
      // Could not verify or could not tear down — requeue (transient) rather than
      // report a clean or revoked status. `skipStatusPatch` + `requeueAfterMs`
      // schedules a deterministic retry without writing a misleading condition.
      return {
        phase,
        message: `EnvSecretOwnershipDenied recheck deferred: ${outcome.requeueReason} — requeuing`,
        workloadStatuses: [],
        requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
        skipStatusPatch: true,
      }
    }
    if (outcome.hadDenied) {
      return {
        phase,
        message: 'EnvSecretOwnershipDenied: foreign Secret ref revoked on steady workflow',
        workloadStatuses: [],
        secretOwnershipConditions: outcome.conditions,
      }
    }
    return null
  }

  /**
   * Fail-closed teardown of a workload whose Secret ref is ownership-denied.
   * Stateful/PVC-backed workloads are NOT deleted (data-loss guard, parity with
   * deleteTransportRuntimeWorkloads) — they are left NotReady and the operator
   * must rotate the (potentially compromised) Secret; see plan §10.
   */
  private async teardownDeniedWorkload(
    workload: WorkloadDef,
    recipe: WorkflowRecipeCRD,
    secretKeys: rb.SecretKeysByName
  ): Promise<void> {
    // Issue #637 — for transport workloads the McpServer CRD + transport Service
    // (in mcp-server) carry the projected envSecret/imagePullSecrets to HCC. The
    // create-time skip only stops NEW foreign refs; on REVOCATION an already
    // materialized McpServer CRD keeps feeding the foreign credential until it is
    // removed. These objects are not stateful, so this runs even when the workload
    // itself is PVC-backed and left running below. Idempotent (404-tolerant).
    if (workload.transport) {
      await deleteTransportDelegation(this.delegationDeps, recipe, workload, this.config.namespace)
    }
    const ns = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)

    // Issue #637 — stateful workloads must NOT be deleted (data-loss guard): the
    // StatefulSet object and its PVCs are preserved. Instead RE-RENDER the
    // StatefulSet without the denied Secret ref (buildEnvVars drops a 'denied'
    // secretKeyRef) and delete ONLY the managed Pod(s) so they restart from the
    // credential-free template. This stops continued injection; the operator must
    // still rotate the (potentially compromised) Secret to fully remediate.
    if (workload.type === 'statefulset') {
      const isolationLevel: SecurityIsolationLevel =
        recipe.spec.security?.isolationLevel ?? 'minimal'
      await this.ensureStatefulSet(workload as StatefulSetDef, recipe, isolationLevel, secretKeys)
      await this.deleteStatefulSetManagedPods(workload as StatefulSetDef, recipe, ns)
      return
    }
    // A non-StatefulSet workload that nonetheless declares volumeClaimTemplates is
    // malformed for K8s; keep the data-loss guard rather than guess a safe re-render.
    if ((workload as { volumeClaimTemplates?: unknown[] }).volumeClaimTemplates?.length) return

    const resourceName = rb.resolveWorkloadRuntimeResourceName(recipe, workload)
    // Issue #637 — throwOnError so a non-404 delete failure (RBAC 403 / apiserver 5xx)
    // PROPAGATES: the denied-workload teardown callers (deploy non-workflow ~1879,
    // deploy workflow ~2632, steady enforcer ~3997) requeue and retry instead of
    // writing a false "revoked" status over a still-live foreign credential. Brings
    // Deployment/CronJob/Job/DaemonSet to parity with the StatefulSet/transport paths,
    // which already re-throw non-404.
    await this.deleteWorkload(workload.type, resourceName, ns, { throwOnError: true })
  }

  /**
   * Issue #637 — delete ONLY the Pods managed by a StatefulSet (selector
   * `app=<resourceName>`, matching buildStatefulSet's selector), never the PVCs
   * (a separate API object, not part of the Pod collection) nor the StatefulSet
   * itself. The StatefulSet controller recreates the Pods from the freshly
   * re-rendered, credential-free template. Idempotent (404-tolerant).
   */
  private async deleteStatefulSetManagedPods(
    workload: StatefulSetDef,
    recipe: WorkflowRecipeCRD,
    namespace: string
  ): Promise<void> {
    const resourceName = rb.resolveStatefulSetResourceName(recipe, workload.id)
    try {
      await this.coreApi.deleteCollectionNamespacedPod({
        namespace,
        labelSelector: `app=${resourceName}`,
      })
      console.log(
        `[WR-Reconciler] Issue #637: deleted StatefulSet "${resourceName}" managed Pods in ` +
          `${namespace} (Secret ownership revoked); PVCs and StatefulSet preserved`
      )
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
  }

  private async ensureDeployment(
    w: DeploymentDef,
    recipe: WorkflowRecipeCRD,
    level: SecurityIsolationLevel,
    secretKeys?: rb.SecretKeysByName
  ): Promise<void> {
    const manifest = rb.buildDeployment(w, recipe, level, secretKeys, {
      pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
    })
    const ns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
    const resourceName = manifest.metadata!.name!
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    await this.createOrReplace(
      () => this.appsApi.createNamespacedDeployment({ namespace: ns, body: manifest }),
      async () => {
        const existing = await this.appsApi.readNamespacedDeployment({
          name: resourceName,
          namespace: ns,
        })
        manifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.appsApi.replaceNamespacedDeployment({
          name: resourceName,
          namespace: ns,
          body: manifest,
        })
      },
      `Deployment "${resourceName}" in ${ns}`,
      {
        manifest,
        readExisting: () =>
          this.appsApi.readNamespacedDeployment({ name: resourceName, namespace: ns }),
      }
    )
  }

  private async ensureStatefulSet(
    w: StatefulSetDef,
    recipe: WorkflowRecipeCRD,
    level: SecurityIsolationLevel,
    secretKeys?: rb.SecretKeysByName
  ): Promise<void> {
    const { statefulSet, headlessService } = rb.buildStatefulSet(w, recipe, level, secretKeys, {
      pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
    })
    const ns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
    this.adjustManifestNamespace(
      statefulSet,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    this.adjustManifestNamespace(
      headlessService,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    const stsName = statefulSet.metadata!.name!
    await this.assertStatefulSetPvcOwnership(w, recipe, ns, stsName)

    // Headless service first
    await this.createOrReplace(
      () => this.coreApi.createNamespacedService({ namespace: ns, body: headlessService }),
      async () => {
        const svcName = headlessService.metadata!.name!
        const existing = await this.coreApi.readNamespacedService({ name: svcName, namespace: ns })
        headlessService.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.coreApi.replaceNamespacedService({
          name: svcName,
          namespace: ns,
          body: headlessService,
        })
      },
      `Headless Service "${headlessService.metadata!.name}" in ${ns}`,
      {
        manifest: headlessService,
        readExisting: () =>
          this.coreApi.readNamespacedService({
            name: headlessService.metadata!.name!,
            namespace: ns,
          }),
      }
    )
    // Then StatefulSet. StatefulSet immutable fields cannot be full-replaced
    // safely once PVC-backed workloads exist; patch only mutable fields and
    // surface immutable drift as status instead of retrying a doomed PUT.
    await this.createOrPatchStatefulSet(statefulSet, ns, stsName)
  }

  private statefulSetPvcNames(workload: StatefulSetDef, statefulSetName: string): string[] {
    const replicas = workload.replicas ?? 1
    const templates = workload.volumeClaimTemplates ?? []
    const checkCount = replicas * templates.length
    const maxCheckCount = this.config.workflowStatefulSetMaxPvcPreflightChecks
    if (checkCount > maxCheckCount) {
      throw new Error(
        `StatefulSet workload "${workload.id}" would require ${checkCount} PVC ownership checks; maximum is ${maxCheckCount}`
      )
    }

    const names: string[] = []
    for (const template of templates) {
      for (let ordinal = 0; ordinal < replicas; ordinal += 1) {
        names.push(`${template.name}-${statefulSetName}-${ordinal}`)
      }
    }
    return names
  }

  private async assertStatefulSetPvcOwnership(
    workload: StatefulSetDef,
    recipe: WorkflowRecipeCRD,
    namespace: string,
    statefulSetName: string
  ): Promise<void> {
    for (const pvcName of this.statefulSetPvcNames(workload, statefulSetName)) {
      let pvc: k8s.V1PersistentVolumeClaim
      try {
        pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
          name: pvcName,
          namespace,
        })
      } catch (error) {
        if (getErrorCode(error) === 404) continue
        throw error
      }

      const labels = pvc.metadata?.labels ?? {}
      const recipeLabel = labels['clerum.io/recipe']
      const workloadLabel = labels['clerum.io/workload']
      if (recipeLabel === recipe.metadata.name && workloadLabel === workload.id) continue

      const owner = recipeLabel
        ? `recipe "${recipeLabel}"`
        : 'an unlabeled or externally managed recipe'
      const ownerWorkload = workloadLabel ? ` workload "${workloadLabel}"` : ''
      throw new Error(
        `PersistentVolumeClaim "${pvcName}" in ${namespace} belongs to ${owner}${ownerWorkload}; refusing to mount it for recipe "${recipe.metadata.name}" workload "${workload.id}"`
      )
    }
  }

  private async ensureCronJob(
    w: CronJobDef,
    recipe: WorkflowRecipeCRD,
    level: SecurityIsolationLevel,
    secretKeys?: rb.SecretKeysByName
  ): Promise<void> {
    const manifest = rb.buildCronJob(w, recipe, level, secretKeys, {
      pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
    })
    const ns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
    const resourceName = manifest.metadata!.name!
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    await this.createOrReplace(
      () => this.batchApi.createNamespacedCronJob({ namespace: ns, body: manifest }),
      async () => {
        const existing = await this.batchApi.readNamespacedCronJob({
          name: resourceName,
          namespace: ns,
        })
        manifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.batchApi.replaceNamespacedCronJob({
          name: resourceName,
          namespace: ns,
          body: manifest,
        })
      },
      `CronJob "${resourceName}" in ${ns}`,
      {
        manifest,
        readExisting: () =>
          this.batchApi.readNamespacedCronJob({ name: resourceName, namespace: ns }),
      }
    )
  }

  private async ensureJob(
    w: JobDef,
    recipe: WorkflowRecipeCRD,
    level: SecurityIsolationLevel,
    secretKeys?: rb.SecretKeysByName
  ): Promise<void> {
    const manifest = rb.buildJob(w, recipe, level, secretKeys, {
      pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
    })
    const ns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
    const resourceName = manifest.metadata!.name!
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    await this.createOrReplace(
      () => this.batchApi.createNamespacedJob({ namespace: ns, body: manifest }),
      async () => {
        const existing = await this.batchApi.readNamespacedJob({
          name: resourceName,
          namespace: ns,
        })
        manifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.batchApi.replaceNamespacedJob({
          name: resourceName,
          namespace: ns,
          body: manifest,
        })
      },
      `Job "${resourceName}" in ${ns}`,
      {
        manifest,
        readExisting: () => this.batchApi.readNamespacedJob({ name: resourceName, namespace: ns }),
      }
    )
  }

  private async ensureDaemonSet(
    w: DaemonSetDef,
    recipe: WorkflowRecipeCRD,
    level: SecurityIsolationLevel,
    secretKeys?: rb.SecretKeysByName
  ): Promise<void> {
    const manifest = rb.buildDaemonSet(w, recipe, level, secretKeys, {
      pluginWorkloadSdkEnabled: this.config.pluginWorkloadSdkEnabled,
    })
    const ns = this.resolveWorkloadNamespace(w, recipe.spec.ui?.workloadRef)
    const resourceName = manifest.metadata!.name!
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    await this.createOrReplace(
      () => this.appsApi.createNamespacedDaemonSet({ namespace: ns, body: manifest }),
      async () => {
        const existing = await this.appsApi.readNamespacedDaemonSet({
          name: resourceName,
          namespace: ns,
        })
        manifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.appsApi.replaceNamespacedDaemonSet({
          name: resourceName,
          namespace: ns,
          body: manifest,
        })
      },
      `DaemonSet "${resourceName}" in ${ns}`,
      {
        manifest,
        readExisting: () =>
          this.appsApi.readNamespacedDaemonSet({ name: resourceName, namespace: ns }),
      }
    )
  }

  private async observeWorkloadStatus(
    workload: WorkloadDef,
    recipe: WorkflowRecipeCRD
  ): Promise<ReconcileResult['workloadStatuses'][number]> {
    const ns = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
    const name = rb.resolveWorkloadRuntimeResourceName(recipe, workload)

    switch (workload.type) {
      case 'deployment': {
        const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
        return this.deploymentWorkloadStatus(workload.id, name, workload.replicas ?? 1, deployment)
      }
      case 'statefulset': {
        const statefulSet = await this.appsApi.readNamespacedStatefulSet({ name, namespace: ns })
        const desired = workload.replicas ?? 1
        const ready = statefulSet.status?.readyReplicas ?? 0
        return this.replicaWorkloadStatus(workload.id, 'StatefulSet', name, ready, desired, {
          generation: statefulSet.metadata?.generation,
          observedGeneration: statefulSet.status?.observedGeneration,
        })
      }
      case 'daemonset': {
        const daemonSet = await this.appsApi.readNamespacedDaemonSet({ name, namespace: ns })
        const desired = daemonSet.status?.desiredNumberScheduled ?? 0
        const ready = daemonSet.status?.numberReady ?? 0
        return this.replicaWorkloadStatus(workload.id, 'DaemonSet', name, ready, desired, {
          generation: daemonSet.metadata?.generation,
          observedGeneration: daemonSet.status?.observedGeneration,
        })
      }
      case 'job': {
        const job = await this.batchApi.readNamespacedJob({ name, namespace: ns })
        const desired = job.spec?.completions ?? 1
        const succeeded = job.status?.succeeded ?? 0
        const failed = job.status?.failed ?? 0
        if (succeeded >= desired) {
          return { id: workload.id, phase: 'completed', ready: true }
        }
        if (failed > 0) {
          return {
            id: workload.id,
            phase: 'failed',
            ready: false,
            message: `Job "${name}" failed ${failed} time(s); succeeded ${succeeded}/${desired}`,
          }
        }
        return {
          id: workload.id,
          phase: 'running',
          ready: false,
          message: `Job "${name}" succeeded ${succeeded}/${desired}`,
        }
      }
      case 'cronjob': {
        const cronJob = await this.batchApi.readNamespacedCronJob({ name, namespace: ns })
        if (cronJob.spec?.suspend === true) {
          return {
            id: workload.id,
            phase: 'suspended',
            ready: false,
            message: `CronJob "${name}" is suspended`,
          }
        }
        return { id: workload.id, phase: 'scheduled', ready: true }
      }
    }
  }

  async observeCurrentWorkloadStatus(recipe: WorkflowRecipeCRD): Promise<ReconcileResult> {
    const workloadStatuses: ReconcileResult['workloadStatuses'] = []
    for (const workload of recipe.spec.workloads ?? []) {
      try {
        if (workload.transport?.type === 'stdio') {
          workloadStatuses.push({
            id: workload.id,
            phase: 'delegated',
            ready: true,
            message: 'HCC manages Deployment',
          })
        } else {
          workloadStatuses.push(await this.observeWorkloadStatus(workload, recipe))
        }
      } catch (error) {
        workloadStatuses.push({
          id: workload.id,
          phase: 'degraded',
          ready: false,
          message: `Workload status unavailable: ${String(error)}`,
        })
      }
    }

    return this.workloadStatusResult(workloadStatuses)
  }

  private workloadStatusResult(
    workloadStatuses: ReconcileResult['workloadStatuses']
  ): ReconcileResult {
    const allReady = workloadStatuses.every(status => status.ready)
    return {
      phase: allReady
        ? 'active'
        : workloadStatuses.some(status => status.phase === 'failed')
          ? 'failed'
          : 'degraded',
      message: allReady
        ? 'All workloads deployed'
        : workloadStatuses.some(status => status.phase === 'failed')
          ? 'Some workloads failed'
          : 'Some workloads not ready',
      workloadStatuses,
    }
  }

  private deploymentWorkloadStatus(
    workloadId: string,
    name: string,
    desired: number,
    deployment: k8s.V1Deployment
  ): ReconcileResult['workloadStatuses'][number] {
    const generation = deployment.metadata?.generation
    const observedGeneration = deployment.status?.observedGeneration
    const ready = deployment.status?.readyReplicas ?? 0
    const updated = deployment.status?.updatedReplicas ?? ready
    const available = deployment.status?.availableReplicas ?? ready
    const rolloutStale =
      generation !== undefined &&
      observedGeneration !== undefined &&
      observedGeneration < generation
    const progressDeadlineExceeded = deployment.status?.conditions?.some(
      condition =>
        condition.type === 'Progressing' &&
        condition.status === 'False' &&
        condition.reason === 'ProgressDeadlineExceeded'
    )

    // NOTE: do NOT gate readiness on `rolloutStale` (observedGeneration < generation).
    // WRC's non-idempotent full-replace apply re-defaults server-managed fields every
    // reconcile, bumping metadata.generation with no real change, so a fully-available
    // Deployment momentarily reports observedGeneration < generation. Gating on it here
    // produced a perpetual degraded↔active flap. Replica health (updated/ready/available)
    // is the real signal; `progressDeadlineExceeded` still catches genuinely stuck rollouts.
    const isReady =
      !progressDeadlineExceeded && updated >= desired && ready >= desired && available >= desired

    return {
      id: workloadId,
      phase: isReady ? 'deployed' : 'degraded',
      ready: isReady,
      ...(isReady
        ? {}
        : {
            message: [
              `Deployment "${name}" updated/ready/available/desired ${updated}/${ready}/${available}/${desired}`,
              rolloutStale ? `observedGeneration ${observedGeneration}/${generation}` : undefined,
              progressDeadlineExceeded ? 'ProgressDeadlineExceeded' : undefined,
            ]
              .filter(Boolean)
              .join('; '),
          }),
    }
  }

  private replicaWorkloadStatus(
    workloadId: string,
    kind: string,
    name: string,
    readyReplicas: number,
    desiredReplicas: number,
    rollout?: { generation?: number; observedGeneration?: number }
  ): ReconcileResult['workloadStatuses'][number] {
    const rolloutStale =
      rollout?.generation !== undefined &&
      rollout.observedGeneration !== undefined &&
      rollout.observedGeneration < rollout.generation
    // See deploymentWorkloadStatus: a transient observedGeneration lag must not degrade a
    // fully-ready workload. `rolloutStale` is retained only for the diagnostic message below.
    const ready = desiredReplicas > 0 && readyReplicas >= desiredReplicas
    return {
      id: workloadId,
      phase: ready ? 'deployed' : 'degraded',
      ready,
      ...(ready
        ? {}
        : {
            message: [
              `${kind} "${name}" readyReplicas ${readyReplicas}/${desiredReplicas}`,
              rolloutStale
                ? `observedGeneration ${rollout?.observedGeneration}/${rollout?.generation}`
                : undefined,
            ]
              .filter(Boolean)
              .join('; '),
          }),
    }
  }

  private async deleteWorkload(
    type: string,
    name: string,
    ns: string,
    opts: { throwOnError?: boolean } = {}
  ): Promise<void> {
    // Issue #637 — `throwOnError` re-throws a non-404 failure so the denied-workload
    // teardown (revocation) path requeues instead of reporting a false "revoked"
    // status over a live foreign-credentialed pod. Default (false) keeps the
    // best-effort swallow for finalizer/cleanup callers.
    const del = opts.throwOnError
      ? (fn: () => Promise<unknown>, label: string) => this.deleteOrThrow(fn, label)
      : (fn: () => Promise<unknown>, label: string) => this.safeDelete(fn, label)
    // `propagationPolicy: 'Background'` on Job/CronJob so deleting the controller also
    // reaps its running Pods — the apiserver default for a Job is `Orphan`, which would
    // leave a (possibly foreign-credentialed) Pod live after the controller object is
    // gone. Deployment/StatefulSet/DaemonSet already cascade by default, so they keep
    // the default delete (no behavior change for them).
    switch (type) {
      case 'deployment':
        await del(
          () => this.appsApi.deleteNamespacedDeployment({ name, namespace: ns }),
          `Deployment "${name}"`
        )
        break
      case 'statefulset':
        await del(
          () => this.appsApi.deleteNamespacedStatefulSet({ name, namespace: ns }),
          `StatefulSet "${name}"`
        )
        break
      case 'cronjob':
        await del(
          () =>
            this.batchApi.deleteNamespacedCronJob({
              name,
              namespace: ns,
              propagationPolicy: 'Background',
            }),
          `CronJob "${name}"`
        )
        break
      case 'job':
        await del(
          () =>
            this.batchApi.deleteNamespacedJob({
              name,
              namespace: ns,
              propagationPolicy: 'Background',
            }),
          `Job "${name}"`
        )
        break
      case 'daemonset':
        await del(
          () => this.appsApi.deleteNamespacedDaemonSet({ name, namespace: ns }),
          `DaemonSet "${name}"`
        )
        break
    }
  }

  // ─── Resource Ensure Methods ──────────────────────────────────────

  private async ensureRecipeResources(recipe: WorkflowRecipeCRD): Promise<void> {
    // INVARIANT: assignResourceInstances() must have run earlier in the same
    // reconcile so status.resourceInstances holds the resolved (scoped or
    // adopted-raw) name — every ensure*/build* below resolves via
    // rb.resolveResourceName which reads that map first (issue #571).
    for (const res of recipe.spec.resources ?? []) {
      switch (res.type) {
        case 'pvc':
          await this.ensurePVC(res, recipe)
          break
        case 'secret':
          await this.ensureSecret(res, recipe)
          break
        case 'configmap':
          await this.ensureConfigMap(res, recipe)
          break
      }
    }
  }

  private async ensurePVC(res: PvcResourceDef, recipe: WorkflowRecipeCRD): Promise<void> {
    const manifest = rb.buildPVC(res, recipe)
    // Canonical physical (recipe-scoped) name — single source of truth (issue #571).
    const name = rb.resolveResourceName(recipe, res.id)
    const ns = this.resolveResourceNamespace(
      res,
      recipe.spec.workloads ?? [],
      recipe.spec.ui?.workloadRef
    )
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    // PVCs: create only (never replace — immutable after creation)
    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim({ namespace: ns, body: manifest })
      console.log(`[WR-Reconciler] Created PVC "${res.id}" in ${ns}`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 409) {
        const existing = await this.coreApi.readNamespacedPersistentVolumeClaim({
          name,
          namespace: ns,
        })
        this.assertExistingResourcePvcOwnedByRecipe(existing, manifest, res, recipe, ns)
        console.log(`[WR-Reconciler] PVC "${res.id}" already exists in ${ns} (owned, skip)`)
      } else {
        throw error
      }
    }
  }

  private assertExistingResourcePvcOwnedByRecipe(
    existing: k8s.V1PersistentVolumeClaim,
    manifest: k8s.V1PersistentVolumeClaim,
    res: PvcResourceDef,
    recipe: WorkflowRecipeCRD,
    namespace: string
  ): void {
    const name = manifest.metadata?.name ?? res.id
    if (existing.metadata?.deletionTimestamp) {
      throw new Error(
        `Existing PVC "${name}" in ${namespace} for WorkflowRecipe "${recipe.metadata.name}" resource "${res.id}" is deleting; refusing to mount it until Kubernetes finishes deletion`
      )
    }

    const expectedLabels = manifest.metadata?.labels ?? {}
    const actualLabels = existing.metadata?.labels ?? {}
    const mismatched = Object.entries(expectedLabels)
      .filter(([key, value]) => actualLabels[key] !== value)
      .map(([key, value]) => `${key}=${value}`)

    if (mismatched.length > 0) {
      throw new Error(
        `Existing PVC "${name}" in ${namespace} is not owned by WorkflowRecipe "${recipe.metadata.name}" resource "${res.id}" (missing/mismatched labels: ${mismatched.join(', ')}); refusing to mount a possibly external claim`
      )
    }
  }

  private async ensureSecret(res: SecretResourceDef, recipe: WorkflowRecipeCRD): Promise<void> {
    const manifest = rb.buildSecret(res, recipe)
    // Canonical physical (recipe-scoped) name — single source of truth for
    // read/replace, never the raw logical id (issue #571).
    const name = rb.resolveResourceName(recipe, res.id)
    const ns = this.resolveResourceNamespace(
      res,
      recipe.spec.workloads ?? [],
      recipe.spec.ui?.workloadRef
    )
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    if (res.generateKeys && res.generateKeys.length > 0) {
      // Create-only semantics: random credentials are generated once and must not be
      // rotated on subsequent reconcile loops (rotation would silently break running
      // workloads that have the original values mounted via envFrom/envSecret).
      await this.createOrReplace(
        () => this.coreApi.createNamespacedSecret({ namespace: ns, body: manifest }),
        async () => {
          // 409: a Secret already exists at the scoped name. Verify it is owned by
          // this recipe before trusting it (never silently inherit a foreign
          // Secret; issue #571), then skip replace to preserve the generated keys.
          const existing = await this.coreApi.readNamespacedSecret({ name, namespace: ns })
          this.assertExistingResourceOwnedByRecipe(existing, name, res.id, recipe, ns, 'Secret')
        },
        `Secret "${res.id}" in ${ns}`
      )
    } else {
      await this.createOrReplace(
        () => this.coreApi.createNamespacedSecret({ namespace: ns, body: manifest }),
        async () => {
          const existing = await this.coreApi.readNamespacedSecret({ name, namespace: ns })
          // Never overwrite a Secret owned by a different recipe (shared namespace
          // + any name collision; issue #571 security review).
          this.assertExistingResourceOwnedByRecipe(existing, name, res.id, recipe, ns, 'Secret')
          manifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
          return this.coreApi.replaceNamespacedSecret({
            name,
            namespace: ns,
            body: manifest,
          })
        },
        `Secret "${res.id}" in ${ns}`
      )
    }
  }

  /**
   * Refuse to mutate a pre-existing Secret/ConfigMap that is not owned by this
   * recipe (`clerum.io/recipe` label). Mirrors assertExistingResourcePvcOwnedByRecipe
   * for the create-or-replace path which (unlike PVCs) would otherwise overwrite.
   */
  private assertExistingResourceOwnedByRecipe(
    existing: { metadata?: { labels?: { [key: string]: string } } },
    physicalName: string,
    resourceId: string,
    recipe: WorkflowRecipeCRD,
    namespace: string,
    kind: string
  ): void {
    const owner = existing.metadata?.labels?.['clerum.io/recipe']
    if (owner !== recipe.metadata.name) {
      throw new Error(
        `Existing ${kind} "${physicalName}" in ${namespace} is not owned by WorkflowRecipe "${recipe.metadata.name}" resource "${resourceId}" (clerum.io/recipe=${owner ?? 'unset'}); refusing to overwrite a possibly external resource`
      )
    }
  }

  /**
   * Provisions the OAuth broker token Secret for a recipe that opts a client
   * into `backgroundAccess` (Path B, spec §9.2). Re-issues when the stored JWT
   * is missing or within OAUTH_BROKER_TOKEN_REFRESH_BEFORE_SECS of expiry. When
   * the recipe declares no backgroundAccess client (or lost its last one), the
   * Secret is reaped so it does not linger as a standing credential.
   *
   * Public so a periodic rotation loop can call it between reconcile events —
   * `k8s.Watch` is event-driven and a settled recipe gets no events, so without
   * this hook the 600 s JWT would expire and stay expired until something
   * poked the CRD.
   */
  async ensureOAuthBrokerTokenSecret(recipe: WorkflowRecipeCRD): Promise<void> {
    const recipeName = recipe.metadata.name
    const ns = this.config.sandboxNamespace
    const secretName = rb.oauthBrokerTokenSecretName(recipeName)

    if (!rb.recipeHasBackgroundAccessClient(recipe)) {
      await this.safeDelete(
        () => this.coreApi.deleteNamespacedSecret({ name: secretName, namespace: ns }),
        `Secret "${secretName}" in ${ns}`
      )
      return
    }

    let existing: k8s.V1Secret | null = null
    try {
      existing = await this.coreApi.readNamespacedSecret({ name: secretName, namespace: ns })
    } catch (err) {
      if (getErrorCode(err) !== 404) throw err
    }

    if (existing) {
      const raw = existing.data?.['broker-token']
      const jwt = raw ? Buffer.from(raw, 'base64').toString('utf-8') : ''
      const exp = decodeJwtExp(jwt)
      const nowSecs = Math.floor(Date.now() / 1000)
      if (exp !== 0 && exp - nowSecs >= OAUTH_BROKER_TOKEN_REFRESH_BEFORE_SECS) return
    }

    const recipeNamespace = recipe.metadata.namespace ?? ns
    const { brokerToken } = await issueOAuthBrokerToken(recipeNamespace, recipeName)
    const manifest = rb.buildOAuthBrokerTokenSecret(recipeName, brokerToken, ns)

    if (existing) {
      await this.coreApi.patchNamespacedSecret(
        { name: secretName, namespace: ns, body: { data: manifest.data } },
        { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
      )
      console.log(`[WR-Reconciler] Refreshed Secret "${secretName}" in ${ns}`)
      return
    }

    try {
      await this.coreApi.createNamespacedSecret({ namespace: ns, body: manifest })
      console.log(`[WR-Reconciler] Created Secret "${secretName}" in ${ns}`)
    } catch (err) {
      if (getErrorCode(err) !== 409) throw err
      console.log(`[WR-Reconciler] Secret "${secretName}" already exists in ${ns} (skip)`)
    }
  }

  /**
   * Reconciles the egress NetworkPolicy that lets background-OAuth workloads
   * reach the control-api broker route. sandbox-recipes is deny-all, so without
   * this the `/recipe-oauth/token` call is dropped. Reaped when no workload
   * opts in via `oauthClientRefs`. Path B, spec §9.2.
   */
  private async reconcileOAuthBrokerEgressPolicy(recipe: WorkflowRecipeCRD): Promise<void> {
    const ns = this.config.sandboxNamespace
    const policyName = rb.oauthBrokerEgressPolicyName(recipe.metadata.name)
    const optedIn = (recipe.spec.workloads ?? [])
      .filter(w => rb.workloadUsesBackgroundOauth(w, recipe))
      .map(w => w.id)
    const policy = rb.buildOAuthBrokerEgressNetworkPolicy(
      recipe,
      optedIn,
      ns,
      this.config.controlPlaneNamespace
    )
    if (!policy) {
      await this.safeDelete(
        () => this.networkingApi.deleteNamespacedNetworkPolicy({ name: policyName, namespace: ns }),
        `NetworkPolicy "${policyName}" in ${ns}`
      )
      return
    }
    await this.applyNetworkPolicy(policy, ns)
  }

  private async ensureConfigMap(
    res: ConfigMapResourceDef,
    recipe: WorkflowRecipeCRD
  ): Promise<void> {
    const manifest = rb.buildConfigMap(res, recipe)
    // Canonical physical (recipe-scoped) name — single source of truth for
    // read/replace, never the raw logical id (issue #571).
    const name = rb.resolveResourceName(recipe, res.id)
    const ns = this.resolveResourceNamespace(
      res,
      recipe.spec.workloads ?? [],
      recipe.spec.ui?.workloadRef
    )
    this.adjustManifestNamespace(
      manifest,
      ns,
      recipe.metadata.namespace ?? this.config.sandboxNamespace
    )
    await this.createOrReplace(
      () => this.coreApi.createNamespacedConfigMap({ namespace: ns, body: manifest }),
      async () => {
        const existing = await this.coreApi.readNamespacedConfigMap({ name, namespace: ns })
        // Never overwrite a ConfigMap owned by a different recipe (issue #571).
        this.assertExistingResourceOwnedByRecipe(existing, name, res.id, recipe, ns, 'ConfigMap')
        manifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
        return this.coreApi.replaceNamespacedConfigMap({
          name,
          namespace: ns,
          body: manifest,
        })
      },
      `ConfigMap "${res.id}" in ${ns}`
    )
  }

  // ─── Status Patch ─────────────────────────────────────────────────

  /** Persist reconcile result to the CRD status subresource. */
  /**
   * Build the Plugin Workload SDK status projection (owned conditions +
   * `status.pluginWorkloadSdk` value) from a reconcile result. Extracted so it
   * can be computed ONCE per reconcile by the watcher (issue #375): the watcher
   * attaches it to `result.pluginWorkloadSdkProjection` after `reconcile()`
   * returns, `shouldPatchRecipeStatus` reads it to detect an
   * awaiting_policy↔validated transition that no other diff would surface, and
   * `patchStatus` reuses it instead of recomputing. `providerUnavailable` is
   * derived here (not inferred from phase/message) so the SDK-only provider
   * health bit stays explicit.
   */
  projectPluginWorkloadSdk(
    recipe: WorkflowRecipeCRD,
    result: ReconcileResult,
    now: string = new Date().toISOString()
  ): PluginWorkloadSdkStatusProjection {
    return buildPluginWorkloadSdkStatus({
      spec: recipe.spec,
      existingConditions: recipe.status?.conditions,
      phase: result.phase,
      featureFlagEnabled: this.config.pluginWorkloadSdkEnabled,
      providerUnavailable:
        result.pluginWorkloadSdkProviderUnavailable === true ||
        (result.workflowConditions ?? []).some(
          condition =>
            condition.type === PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE &&
            condition.status === 'True'
        ),
      teardownConfirmed: result.pluginWorkloadSdkTeardownConfirmed === true,
      policyPending: result.pluginWorkloadSdkPolicyPending === true,
      bootstrapProof: result.pluginWorkloadSdkBootstrapProof,
      now,
      // issue #375 (R1): carry forward the stable validatedAt marker across
      // steady-state throttle patches instead of resetting it to `now`.
      existingCapability: recipe.status?.pluginWorkloadSdk,
    })
  }

  async patchStatus(recipe: WorkflowRecipeCRD, result: ReconcileResult): Promise<void> {
    const workloads = result.workloadStatuses.map(ws => {
      const def = (recipe.spec.workloads ?? []).find(w => w.id === ws.id)
      return {
        id: ws.id,
        type: def?.type ?? 'deployment',
        phase: ws.phase,
        ready: ws.ready,
        ...(ws.message && { message: ws.message }),
      }
    })

    // For workflow recipes with a real execution, initialize workflowExecution.phase to
    // "initializing" on the first status patch. Parent recipes that only registered
    // trigger infrastructure stay active without a live workflowExecution.
    const isWorkflow = recipe.spec.steps !== undefined && recipe.spec.steps.length > 0
    const needsWorkflowInit =
      isWorkflow && !result.clearWorkflowExecution && !recipe.status?.workflowExecution?.phase

    const now = new Date().toISOString()
    let existingWorkflowExecution: WorkflowRecipeStatus['workflowExecution'] =
      recipe.status?.workflowExecution
    const explicitWorkflowPhase = result.workflowPhase
    let workflowPhase =
      explicitWorkflowPhase ??
      (isWorkflow &&
      result.phase === 'failed' &&
      !isTerminalWorkflowStatusPhase(existingWorkflowExecution?.phase)
        ? 'failed'
        : needsWorkflowInit
          ? 'initializing'
          : undefined)

    if (isWorkflow && workflowPhase) {
      try {
        const liveRecipe = (await this.customApi.getNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: recipe.metadata.namespace,
          plural: WORKFLOWRECIPE_PLURAL,
          name: recipe.metadata.name,
        })) as WorkflowRecipeCRD
        const liveExecution = liveRecipe.status?.workflowExecution
        if (
          liveExecution?.phase &&
          workflowPhase === 'initializing' &&
          liveExecution.phase !== 'initializing'
        ) {
          existingWorkflowExecution = liveExecution
          workflowPhase = undefined
        } else if (
          isTerminalWorkflowStatusPhase(liveExecution?.phase) &&
          (!explicitWorkflowPhase || liveExecution?.phase !== workflowPhase)
        ) {
          existingWorkflowExecution = liveExecution
          workflowPhase = undefined
        } else if (liveExecution) {
          existingWorkflowExecution = liveExecution
        }
      } catch {
        // Best-effort race guard only; keep the original status patch path if
        // the live read fails.
      }
    }

    const shouldPatchWorkflowExecution = isWorkflow && workflowPhase

    // Merge owned condition groups into status.conditions[] by `type`.
    // Conditions owned by other components are preserved verbatim.
    const webhookMergedConditions = mergeWebhookConditions(
      recipe.status?.conditions,
      result.webhookConditions
    )
    const workflowOutputMergedConditions = mergeWorkflowOutputConditions(
      webhookMergedConditions ?? recipe.status?.conditions,
      result.workflowConditions
    )
    const internalDependencyMergedConditions = mergeInternalDependencyConditions(
      workflowOutputMergedConditions ?? webhookMergedConditions ?? recipe.status?.conditions,
      result.internalDependencyConditions
    )
    const secretOwnershipMergedConditions = mergeSecretOwnershipConditions(
      internalDependencyMergedConditions ??
        workflowOutputMergedConditions ??
        webhookMergedConditions ??
        recipe.status?.conditions,
      result.secretOwnershipConditions
    )
    const workloadReconcileMergedConditions = mergeWorkloadReconcileConditions(
      secretOwnershipMergedConditions ??
        internalDependencyMergedConditions ??
        workflowOutputMergedConditions ??
        webhookMergedConditions ??
        recipe.status?.conditions,
      result.workloadConditions
    )
    // Plugin Workload SDK conditions are derived so every status patch carries a
    // consistent projection of spec.pluginWorkloadSdk + feature flag, while the
    // SDK-only provider health bit is propagated explicitly through
    // ReconcileResult rather than inferred from a free-form phase/message. Reuse
    // the projection the watcher already computed for the patch decision
    // (issue #375) so the exact object that drove shouldPatchRecipeStatus is
    // what gets written; recompute only on paths that never attached one (e.g.
    // observeCurrentWorkloadStatus).
    const pluginSdkProjection =
      result.pluginWorkloadSdkProjection ?? this.projectPluginWorkloadSdk(recipe, result, now)
    const pluginSdkMergedConditions = mergePluginWorkloadSdkConditions(
      workloadReconcileMergedConditions ??
        secretOwnershipMergedConditions ??
        internalDependencyMergedConditions ??
        workflowOutputMergedConditions ??
        webhookMergedConditions ??
        recipe.status?.conditions,
      pluginSdkProjection.conditions
    )
    const mergedConditions =
      pluginSdkMergedConditions ??
      workloadReconcileMergedConditions ??
      secretOwnershipMergedConditions ??
      internalDependencyMergedConditions ??
      workflowOutputMergedConditions ??
      webhookMergedConditions

    const statusPatch = {
      status: {
        phase: result.phase,
        message: result.message,
        lastTransitionTime: now,
        ...(workloads.length > 0 && { workloads }),
        ...(mergedConditions !== undefined && { conditions: mergedConditions }),
        ...(pluginSdkProjection.capability !== undefined && {
          pluginWorkloadSdk: pluginSdkProjection.capability,
        }),
        ...(result.clearWorkflowExecution && { workflowExecution: null }),
        ...(shouldPatchWorkflowExecution && {
          workflowExecution: {
            ...existingWorkflowExecution,
            phase: workflowPhase,
            startedAt: existingWorkflowExecution?.startedAt ?? now,
            message: result.message,
            ...(isTerminalWorkflowStatusPhase(workflowPhase)
              ? { completedAt: existingWorkflowExecution?.completedAt ?? now }
              : {}),
          },
        }),
      },
    }

    await this.customApi.patchNamespacedCustomObjectStatus(
      {
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: recipe.metadata.namespace,
        plural: WORKFLOWRECIPE_PLURAL,
        name: recipe.metadata.name,
        body: statusPatch,
      },
      { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
    )

    console.log(
      `[WR-Reconciler] Status patched for "${recipe.metadata.name}": phase=${result.phase}`
    )
  }

  // ─── UUID Instance Assignment ──────────────────────────────────────

  /**
   * Assign UUID-based resource names to workflow workloads and persist
   * the mapping in status.workloadInstances BEFORE creating K8s resources.
   *
   * This ensures:
   * - UUIDs are generated ONCE and persisted before any K8s resource is created
   * - Re-reconciles reuse the same UUID from status (stable names)
   * - Two recipes with the same workload ID get different UUIDs
   * - Deletion uses the stored UUID name (no naming mismatch)
   */
  private async assignWorkloadInstances(
    recipe: WorkflowRecipeCRD,
    workloads: WorkloadDef[],
    options: { persist?: boolean } = {}
  ): Promise<Set<string>> {
    const instances: Record<string, string> = { ...(recipe.status?.workloadInstances ?? {}) }
    const newlyAssigned = new Set<string>()
    const shouldPersist = options.persist !== false

    for (const workload of workloads) {
      if (!instances[workload.id]) {
        instances[workload.id] = shouldPersist
          ? await this.resolveInitialWorkloadInstanceName(recipe, workload)
          : rb.resolveScopedWorkloadRuntimeResourceName(recipe, workload)
        newlyAssigned.add(workload.id)
      }
    }

    if (newlyAssigned.size === 0) {
      return newlyAssigned
    }

    recipe.status = { ...recipe.status, workloadInstances: instances } as typeof recipe.status

    if (shouldPersist) {
      await this.customApi.patchNamespacedCustomObjectStatus(
        {
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: recipe.metadata.namespace,
          plural: WORKFLOWRECIPE_PLURAL,
          name: recipe.metadata.name,
          body: { status: { workloadInstances: instances } },
        },
        { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
      )
      console.log(
        `[WR-Reconciler] Assigned workload instances for "${recipe.metadata.name}": ${JSON.stringify(instances)}`
      )
    }

    return newlyAssigned
  }

  private async resolveInitialWorkloadInstanceName(
    recipe: WorkflowRecipeCRD,
    workload: WorkloadDef
  ): Promise<string> {
    const scopedName = rb.resolveScopedWorkloadRuntimeResourceName(recipe, workload)
    const isWorkflowRecipe = Array.isArray(recipe.spec.steps) && recipe.spec.steps.length > 0
    const phase = recipe.status?.phase
    const mayHaveLegacyRawWorkload =
      phase === 'active' || phase === 'degraded' || phase === 'deploying'

    if (isWorkflowRecipe || !mayHaveLegacyRawWorkload) {
      return scopedName
    }

    if (workload.type === 'statefulset' && (workload.volumeClaimTemplates?.length ?? 0) > 0) {
      return scopedName
    }

    // issue #571: non-MCP Deployments are actively re-scoped (migration). The old
    // raw Deployment/Service is torn down by cleanupLegacyRawDeploymentResources
    // once the scoped workload reports ready (create-new → ready → delete-old, no
    // hard downtime). MCP workloads (transport) and other legacy types still adopt
    // the raw name — re-scoping an McpServer child cascades to HCC and is handled
    // in a dedicated follow-up.
    //
    // A Deployment that mounts a recipe PVC is EXCLUDED: re-scoping it would run the
    // new scoped pod and the old raw pod against the same ReadWriteOnce PVC
    // (Multi-Attach), deadlocking the rollout. Those keep the raw name like MCP
    // workloads (same follow-up).
    if (
      workload.type === 'deployment' &&
      !workload.transport &&
      !this.workloadMountsRecipePvc(workload, recipe)
    ) {
      // Logged once (only reached when no instance is recorded yet) — the single
      // observable marker that a fleet migration re-scoped this workload.
      console.log(
        `[WR-Reconciler] Migrating workload "${workload.id}" of recipe "${recipe.metadata.name}" to scoped name "${scopedName}" (issue #571)`
      )
      return scopedName
    }

    const namespace = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
    return (await this.legacyRawWorkloadExists(workload, namespace, recipe))
      ? workload.id
      : scopedName
  }

  /**
   * True when a workload mounts a recipe-declared PVC (spec.resources[].type=pvc).
   * Such Deployments are not actively re-scoped (issue #571) to avoid ReadWriteOnce
   * Multi-Attach deadlock between the old raw pod and the new scoped pod.
   */
  private workloadMountsRecipePvc(workload: WorkloadDef, recipe: WorkflowRecipeCRD): boolean {
    const pvcIds = new Set(
      (recipe.spec.resources ?? []).filter(r => r.type === 'pvc').map(r => r.id)
    )
    if (pvcIds.size === 0) return false
    return (workload.volumeMounts ?? []).some(vm => pvcIds.has(vm.name))
  }

  /**
   * Assign recipe-scoped names to `spec.resources[]` (PVC/Secret/ConfigMap) and
   * persist the mapping in status.resourceInstances BEFORE creating K8s resources
   * — the resource-side mirror of assignWorkloadInstances (issue #571).
   *
   * Without this, two recipes that both declare a generic resource id such as
   * `data` would target the same physical PVC/Secret/ConfigMap in a shared
   * namespace.
   */
  private async assignResourceInstances(
    recipe: WorkflowRecipeCRD,
    resources: ResourceDef[],
    options: { persist?: boolean } = {}
  ): Promise<Set<string>> {
    const instances: Record<string, string> = { ...(recipe.status?.resourceInstances ?? {}) }
    const newlyAssigned = new Set<string>()
    const shouldPersist = options.persist !== false

    for (const resource of resources) {
      if (!instances[resource.id]) {
        instances[resource.id] = shouldPersist
          ? await this.resolveInitialResourceInstanceName(recipe, resource)
          : rb.resolveScopedResourceName(recipe, resource.id)
        newlyAssigned.add(resource.id)
      }
    }

    if (newlyAssigned.size === 0) {
      return newlyAssigned
    }

    recipe.status = { ...recipe.status, resourceInstances: instances } as typeof recipe.status

    if (shouldPersist) {
      await this.customApi.patchNamespacedCustomObjectStatus(
        {
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: recipe.metadata.namespace,
          plural: WORKFLOWRECIPE_PLURAL,
          name: recipe.metadata.name,
          body: { status: { resourceInstances: instances } },
        },
        { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
      )
      console.log(
        `[WR-Reconciler] Assigned ${Object.keys(instances).length} resource instance(s) for "${recipe.metadata.name}"`
      )
    }

    return newlyAssigned
  }

  /**
   * First-assignment name for a resource id. New recipes always get a scoped
   * name; a legacy recipe (active/degraded/deploying) that already has a raw
   * PVC/Secret/ConfigMap of this id adopts the raw name so existing data —
   * PVCs in particular are retained and immutable — is not orphaned (D2).
   */
  private async resolveInitialResourceInstanceName(
    recipe: WorkflowRecipeCRD,
    resource: ResourceDef
  ): Promise<string> {
    const scopedName = rb.resolveScopedResourceName(recipe, resource.id)
    const phase = recipe.status?.phase
    // Phase-only gate ON PURPOSE — do NOT add an `isWorkflowRecipe` exclusion here
    // (unlike the workload path). Before issue #571, `spec.resources[]` were created
    // with the RAW `resource.id` for EVERY recipe type, including workflow recipes
    // (resource scoping is new in this PR). So a workflow recipe with a pre-existing
    // raw PVC/Secret/ConfigMap MUST still adopt it — excluding workflow recipes would
    // skip adoption, re-scope to a fresh name, and orphan the existing PVC data (D2).
    const mayHaveLegacyRawResource =
      phase === 'active' || phase === 'degraded' || phase === 'deploying'

    if (!mayHaveLegacyRawResource) {
      return scopedName
    }

    const namespace = this.resolveResourceNamespace(
      resource,
      recipe.spec.workloads ?? [],
      recipe.spec.ui?.workloadRef
    )
    return (await this.legacyRawResourceExists(resource, namespace, recipe))
      ? resource.id
      : scopedName
  }

  /**
   * True only when a raw-named resource exists AND is owned by THIS recipe
   * (`clerum.io/recipe` label). `sandbox-recipes` is shared across recipes, so
   * adopting a raw resource without the ownership check could overwrite (Secret/
   * ConfigMap) or lock onto (PVC) another recipe's resource — issue #571 security
   * review. A foreign or unlabeled resource is treated as "not adoptable" → the
   * recipe gets a fresh scoped name instead.
   */
  private async legacyRawResourceExists(
    resource: ResourceDef,
    namespace: string,
    recipe: WorkflowRecipeCRD
  ): Promise<boolean> {
    try {
      let existing: { metadata?: { labels?: { [key: string]: string } } }
      switch (resource.type) {
        case 'pvc':
          existing = await this.coreApi.readNamespacedPersistentVolumeClaim({
            name: resource.id,
            namespace,
          })
          break
        case 'secret':
          existing = await this.coreApi.readNamespacedSecret({ name: resource.id, namespace })
          break
        case 'configmap':
          existing = await this.coreApi.readNamespacedConfigMap({ name: resource.id, namespace })
          break
        default:
          return false
      }
      return existing.metadata?.labels?.['clerum.io/recipe'] === recipe.metadata.name
    } catch (err: unknown) {
      if (getErrorCode(err) === 404) {
        return false
      }
      throw err
    }
  }

  /**
   * True only when a raw-named workload exists AND is owned by THIS recipe
   * (`clerum.io/recipe`). `sandbox-recipes` is shared, so adopting a raw workload
   * without the ownership check could let one recipe adopt — and later tear down
   * (cleanupLegacyRaw*Resources) — another recipe's workload (issue #571 security
   * review). A foreign or unlabeled workload reports `false` → the recipe gets a
   * fresh scoped name instead.
   */
  private async legacyRawWorkloadExists(
    workload: WorkloadDef,
    namespace: string,
    recipe: WorkflowRecipeCRD
  ): Promise<boolean> {
    try {
      let existing: { metadata?: { labels?: { [key: string]: string } } }
      switch (workload.type) {
        case 'deployment':
          existing = await this.appsApi.readNamespacedDeployment({ name: workload.id, namespace })
          break
        case 'statefulset':
          existing = await this.appsApi.readNamespacedStatefulSet({ name: workload.id, namespace })
          break
        case 'daemonset':
          existing = await this.appsApi.readNamespacedDaemonSet({ name: workload.id, namespace })
          break
        case 'cronjob':
          existing = await this.batchApi.readNamespacedCronJob({ name: workload.id, namespace })
          break
        case 'job':
          existing = await this.batchApi.readNamespacedJob({ name: workload.id, namespace })
          break
        default:
          return false
      }
      return existing.metadata?.labels?.['clerum.io/recipe'] === recipe.metadata.name
    } catch (err: unknown) {
      if (getErrorCode(err) === 404) {
        return false
      }
      throw err
    }
  }

  private async cleanupLegacyRawStatefulSetResources(
    recipe: WorkflowRecipeCRD,
    workloadStatuses: NonNullable<ReconcileResult['workloadStatuses']>
  ): Promise<boolean> {
    // Only a legacy non-workflow recipe can carry raw-named workloads. Skip the
    // per-reconcile probing for workflow recipes and fresh recipes (issue #571).
    if (!this.mayHaveLegacyRawWorkloads(recipe)) return false

    let cleanupPending = false

    for (const workload of recipe.spec.workloads ?? []) {
      if (
        workload.type !== 'statefulset' ||
        (workload.volumeClaimTemplates?.length ?? 0) === 0 ||
        rb.resolveWorkloadRuntimeResourceName(recipe, workload) === workload.id
      ) {
        continue
      }

      const namespace = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
      const observedStatus = workloadStatuses.find(status => status.id === workload.id)
      const legacyRecipe = this.withoutWorkloadInstance(recipe, workload.id)
      const { headlessService } = rb.buildStatefulSet(workload, legacyRecipe)
      const legacyService = rb.buildService(workload, legacyRecipe)
      // Only the raw resources OWNED by this recipe are eligible for teardown —
      // never another recipe's StatefulSet/Service sharing the raw id (issue #571).
      const owned = await this.legacyRawStatefulSetResourcesOwned({
        namespace,
        statefulSetName: workload.id,
        headlessServiceName: headlessService.metadata!.name!,
        serviceName: legacyService?.metadata?.name,
        recipe,
      })
      const anyOwned = owned.statefulSet || owned.headlessService || owned.service

      if (!observedStatus?.ready) {
        if (anyOwned) {
          cleanupPending = true
          console.log(
            `[WR-Reconciler] Legacy StatefulSet cleanup for ${namespace}/${workload.id} deferred until scoped workload is ready`
          )
        }
        continue
      }

      if (!anyOwned) continue

      if (owned.statefulSet) {
        await this.deleteRequiredIfExists(
          () => this.appsApi.deleteNamespacedStatefulSet({ name: workload.id, namespace }),
          `legacy StatefulSet ${namespace}/${workload.id}`
        )
      }
      if (owned.headlessService) {
        await this.deleteRequiredIfExists(
          () =>
            this.coreApi.deleteNamespacedService({
              name: headlessService.metadata!.name!,
              namespace,
            }),
          `legacy StatefulSet headless Service ${namespace}/${headlessService.metadata!.name!}`
        )
      }
      if (owned.service && legacyService) {
        await this.deleteRequiredIfExists(
          () =>
            this.coreApi.deleteNamespacedService({
              name: legacyService.metadata!.name!,
              namespace,
            }),
          `legacy workload Service ${namespace}/${legacyService.metadata!.name!}`
        )
      }
    }

    return cleanupPending
  }

  /** A legacy non-workflow recipe (phase active/degraded/deploying) may still hold
   * raw-named workloads from before issue #571 — only those need migration probing. */
  private mayHaveLegacyRawWorkloads(recipe: WorkflowRecipeCRD): boolean {
    const isWorkflowRecipe = Array.isArray(recipe.spec.steps) && recipe.spec.steps.length > 0
    const phase = recipe.status?.phase
    const legacyPhase = phase === 'active' || phase === 'degraded' || phase === 'deploying'
    return !isWorkflowRecipe && legacyPhase
  }

  private async legacyRawStatefulSetResourcesOwned(args: {
    namespace: string
    statefulSetName: string
    headlessServiceName: string
    serviceName?: string
    recipe: WorkflowRecipeCRD
  }): Promise<{ statefulSet: boolean; headlessService: boolean; service: boolean }> {
    const probe = async (
      read: () => Promise<{ metadata?: { labels?: { [key: string]: string } } }>
    ): Promise<boolean> => {
      try {
        const existing = await read()
        return existing.metadata?.labels?.['clerum.io/recipe'] === args.recipe.metadata.name
      } catch (err: unknown) {
        if (getErrorCode(err) === 404) return false
        throw err
      }
    }

    const statefulSet = await probe(() =>
      this.appsApi.readNamespacedStatefulSet({
        name: args.statefulSetName,
        namespace: args.namespace,
      })
    )
    const headlessService = await probe(() =>
      this.coreApi.readNamespacedService({
        name: args.headlessServiceName,
        namespace: args.namespace,
      })
    )
    const service = args.serviceName
      ? await probe(() =>
          this.coreApi.readNamespacedService({
            name: args.serviceName!,
            namespace: args.namespace,
          })
        )
      : false

    return { statefulSet, headlessService, service }
  }

  /**
   * issue #571 — migrate legacy raw-named non-MCP Deployments to recipe-scoped
   * names. Mirrors cleanupLegacyRawStatefulSetResources: the scoped workload is
   * already materialized by the main ensure pass; here we tear the old raw
   * Deployment/Service down only once the scoped workload reports ready, so the
   * migration is create-new → ready → delete-old with no orphaning. While the
   * scoped workload is not yet ready the cleanup is deferred (requeue).
   */
  private async cleanupLegacyRawDeploymentResources(
    recipe: WorkflowRecipeCRD,
    workloadStatuses: NonNullable<ReconcileResult['workloadStatuses']>
  ): Promise<boolean> {
    // Workflow recipes and fresh recipes never had raw-named workloads — skip the
    // per-reconcile probing entirely (issue #571).
    if (!this.mayHaveLegacyRawWorkloads(recipe)) return false

    let cleanupPending = false

    for (const workload of recipe.spec.workloads ?? []) {
      // Gate keys off the PERSISTED runtime name, not a re-derivation of the assign
      // predicate, so it can never drift from resolveInitialWorkloadInstanceName: a
      // workload that adopted its raw name (MCP / PVC-mounting Deployment) has
      // runtime === id and is skipped; only an actually re-scoped Deployment passes.
      if (
        workload.type !== 'deployment' ||
        !!workload.transport ||
        rb.resolveWorkloadRuntimeResourceName(recipe, workload) === workload.id
      ) {
        continue
      }

      const namespace = this.resolveWorkloadNamespace(workload, recipe.spec.ui?.workloadRef)
      const observedStatus = workloadStatuses.find(status => status.id === workload.id)
      const legacyRecipe = this.withoutWorkloadInstance(recipe, workload.id)
      const legacyService = rb.buildService(workload, legacyRecipe)
      // Only the raw resources OWNED by this recipe are eligible for teardown —
      // never another recipe's resource that happens to share the raw id in the
      // shared sandbox-recipes namespace (issue #571 security review).
      const owned = await this.legacyRawDeploymentResourcesOwned({
        namespace,
        deploymentName: workload.id,
        serviceName: legacyService?.metadata?.name,
        recipe,
      })
      const anyOwned = owned.deployment || owned.service

      if (!observedStatus?.ready) {
        if (anyOwned) {
          cleanupPending = true
          console.log(
            `[WR-Reconciler] Legacy Deployment cleanup for ${namespace}/${workload.id} deferred until scoped workload is ready`
          )
        }
        continue
      }

      if (!anyOwned) continue

      if (owned.deployment) {
        await this.deleteRequiredIfExists(
          () => this.appsApi.deleteNamespacedDeployment({ name: workload.id, namespace }),
          `legacy Deployment ${namespace}/${workload.id}`
        )
      }
      if (owned.service && legacyService) {
        await this.deleteRequiredIfExists(
          () =>
            this.coreApi.deleteNamespacedService({
              name: legacyService.metadata!.name!,
              namespace,
            }),
          `legacy workload Service ${namespace}/${legacyService.metadata!.name!}`
        )
      }
    }

    return cleanupPending
  }

  /**
   * Probe whether the raw Deployment / Service exist AND are owned by this recipe
   * (`clerum.io/recipe` label). A foreign or unlabeled resource reports `false` so
   * the migration never tears down another recipe's workload (issue #571).
   */
  private async legacyRawDeploymentResourcesOwned(args: {
    namespace: string
    deploymentName: string
    serviceName?: string
    recipe: WorkflowRecipeCRD
  }): Promise<{ deployment: boolean; service: boolean }> {
    const ownedBy = (existing: { metadata?: { labels?: { [key: string]: string } } }): boolean =>
      existing.metadata?.labels?.['clerum.io/recipe'] === args.recipe.metadata.name

    let deployment = false
    try {
      const d = await this.appsApi.readNamespacedDeployment({
        name: args.deploymentName,
        namespace: args.namespace,
      })
      deployment = ownedBy(d)
    } catch (err: unknown) {
      if (getErrorCode(err) !== 404) throw err
    }

    let service = false
    if (args.serviceName) {
      try {
        const s = await this.coreApi.readNamespacedService({
          name: args.serviceName,
          namespace: args.namespace,
        })
        service = ownedBy(s)
      } catch (err: unknown) {
        if (getErrorCode(err) !== 404) throw err
      }
    }

    return { deployment, service }
  }

  private withoutWorkloadInstance(
    recipe: WorkflowRecipeCRD,
    workloadId: string
  ): WorkflowRecipeCRD {
    const workloadInstances = { ...(recipe.status?.workloadInstances ?? {}) }
    delete workloadInstances[workloadId]
    return {
      ...recipe,
      status: {
        ...(recipe.status as WorkflowRecipeStatus),
        workloadInstances,
      },
    }
  }

  private async deleteRequiredIfExists(
    deleteFn: () => Promise<unknown>,
    description: string
  ): Promise<void> {
    try {
      await deleteFn()
      console.log(`[WR-Reconciler] Deleted ${description}`)
    } catch (err: unknown) {
      if (getErrorCode(err) === 404) {
        return
      }
      throw err
    }
  }

  // ─── Validation ───────────────────────────────────────────────────

  private validateWorkflowStepLimit(recipe: WorkflowRecipeCRD): string | undefined {
    const stepCount = recipe.spec.steps?.length ?? 0
    if (stepCount <= this.config.maxWorkflowSteps) return undefined
    return `WorkflowRecipe has ${stepCount} steps, exceeding WRC_MAX_WORKFLOW_STEPS=${this.config.maxWorkflowSteps}`
  }

  private validateSpec(recipe: WorkflowRecipeCRD): void {
    // Workflow recipes may have steps[] without workloads[].
    if (
      (!recipe.spec.workloads || recipe.spec.workloads.length === 0) &&
      (!recipe.spec.steps || recipe.spec.steps.length === 0)
    ) {
      throw new Error('WorkflowRecipe must have at least one workload or step')
    }
    const stepLimitError = this.validateWorkflowStepLimit(recipe)
    if (stepLimitError) throw new Error(stepLimitError)
    // Plugin Workload SDK capability is validated regardless of the feature
    // flag — an invalid declaration must fail closed even while the flag is
    // off (the flag gates runtime enforcement, not authoring correctness).
    const pluginSdkErrors = validatePluginWorkloadSdkSpec(recipe.spec)
    if (pluginSdkErrors.length > 0) {
      throw new Error(`Invalid spec.pluginWorkloadSdk: ${pluginSdkErrors.join('; ')}`)
    }
    // Skip workload-specific validation if this is a workflow-only recipe
    if (!recipe.spec.workloads || recipe.spec.workloads.length === 0) return
    const ids = recipe.spec.workloads.map(w => w.id)
    const uniqueIds = new Set(ids)
    if (uniqueIds.size !== ids.length) {
      throw new Error('Workload IDs must be unique')
    }
    validateWorkloadBindings(recipe.spec.workloads, recipe.spec.bindings)

    // Transport workloads require port. contextRef is optional: omitted context
    // derives a private wf-<recipeName> Context during MCP delegation.
    const transportWorkloads = recipe.spec.workloads.filter(w => w.transport)
    for (const w of transportWorkloads) {
      if (!w.port) {
        throw new Error(
          `Workload "${w.id}" has transport but no port — port is required for MCP service discovery`
        )
      }
      // stdio transport is only valid on deployment workloads.
      if (w.transport!.type === 'stdio' && w.type !== 'deployment') {
        throw new Error(
          `Workload "${w.id}": stdio transport is only supported on "deployment" workloads, got "${w.type}"`
        )
      }
    }

    // Defense-in-depth validation for per-workload security overrides.
    // CRD OpenAPI validates minimum: 1, but we double-check in code
    const uiWorkloadId = recipe.spec.ui?.workloadRef
    // Build the oauthClients map once for cross-reference checks below.
    // CRD-level CEL enforces id-uniqueness within oauthClients[], so a Map
    // keyed by id is unambiguous.
    const oauthClientsById = new Map((recipe.spec.oauthClients ?? []).map(c => [c.id, c] as const))
    for (const w of recipe.spec.workloads) {
      const wlNs = this.resolveWorkloadNamespace(w, uiWorkloadId)
      validateWorkloadEgressBindings(w, recipe, wlNs)

      if (w.security?.runAsUser === 0) {
        throw new Error(`Workload "${w.id}": runAsUser=0 (root) is not allowed`)
      }
      if (w.security?.runAsGroup === 0) {
        throw new Error(`Workload "${w.id}": runAsGroup=0 (root group) is not allowed`)
      }
      if (w.security?.fsGroup === 0) {
        throw new Error(`Workload "${w.id}": fsGroup=0 (root group) is not allowed`)
      }
      if (w.security?.prepareVolumeOwnership) {
        if (!w.security.runAsUser) {
          throw new Error(
            `Workload "${w.id}": security.prepareVolumeOwnership requires security.runAsUser`
          )
        }
        if (!(w.volumeMounts ?? []).some(vm => !vm.readOnly)) {
          throw new Error(
            `Workload "${w.id}": security.prepareVolumeOwnership requires at least one writable volumeMount`
          )
        }
      }

      // oauthClientRefs are part of the authoring/security contract — refuse
      // misconfigured recipes here rather than partially rendering a workload
      // whose broker-token mount or egress rule was silently skipped by a
      // later runtime check.
      const refs = w.oauthClientRefs ?? []
      if (refs.length === 0) continue
      // CRD: "Only valid on non-MCP, non-UI workloads." MCP transport
      // workloads reach providers via the proxy; UI workloads use the
      // foreground end-user OAuth flow.
      if (w.transport) {
        throw new Error(
          `Workload "${w.id}": oauthClientRefs is not allowed on workloads with transport (MCP)`
        )
      }
      if (w.id === uiWorkloadId) {
        throw new Error(`Workload "${w.id}": oauthClientRefs is not allowed on the UI workload`)
      }
      const seen = new Set<string>()
      for (const ref of refs) {
        if (seen.has(ref)) {
          throw new Error(`Workload "${w.id}": oauthClientRefs contains duplicate id "${ref}"`)
        }
        seen.add(ref)
        const client = oauthClientsById.get(ref)
        if (!client) {
          throw new Error(
            `Workload "${w.id}": oauthClientRefs entry "${ref}" does not reference any spec.oauthClients[].id`
          )
        }
        if (client.backgroundAccess !== true) {
          throw new Error(
            `Workload "${w.id}": oauthClientRefs entry "${ref}" references spec.oauthClients[id=${ref}] which is not backgroundAccess: true — only background-enabled clients can be mounted into a workload`
          )
        }
      }
    }
  }
}
