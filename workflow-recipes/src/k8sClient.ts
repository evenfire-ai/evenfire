/**
 * Kubernetes client for watching WorkflowRecipe CRDs.
 * Follows the context-mapper/src/k8sClient.ts pattern.
 *
 * Production: Watches WorkflowRecipe CRDs via K8s Watch API with auto-reconnect.
 * Dev mode: Reads recipes from CLERUM_RECIPES env var JSON.
 *
 * Fase 4 (DB-first runs): the legacy `WorkflowRunReconciler` (CRD watch +
 * child creation + reaper) is replaced by `DbRunProcessor`, which consumes
 * `workflow_runs` rows via Postgres LISTEN/NOTIFY. The child-recipe creation
 * logic moves here as a `ChildRecipeCreator` adapter that closes over
 * `customApi`, keeping the processor fully K8s-unaware.
 */
import * as k8s from '@kubernetes/client-node'
import type { Pool } from 'pg'
import { loadConfig } from './config'
import { getPool, initDb } from './db'
import {
  type GovernedTraceReporter,
  type WorkflowInfrastructureTelemetryProjection,
  createGovernedTraceReporter,
} from './governedTraceReporter'
import { K8sSecretWatchLoop } from './k8sSecretWatchLoop'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from './reconciler/crdConstants'
import {
  type ChildRecipeCreator,
  type ChildRecipeExistenceChecker,
  type DbRunProcessor,
  type DbRunRow,
  createDbRunProcessor,
} from './reconciler/dbRunProcessor'
import { getErrorCode } from './reconciler/k8sErrors'
import { RecipeEventQueue } from './reconciler/recipeEventQueue'
import { recipeHasBackgroundAccessClient } from './reconciler/resourceBuilder'
import { SecretReverseIndex } from './reconciler/secretReverseIndex'
import { SecretWatcher } from './reconciler/secretWatcher'
import {
  type ReconcileResult,
  WorkflowRecipeReconciler,
} from './reconciler/workflowRecipeReconciler'
import {
  type StatusCondition,
  WorkflowRecipeCRD,
  WorkflowRecipeSpec,
  type WorkloadStatus,
} from './types'
import { createDbRunChildRecipe } from './workflow/dbRunChildRecipeCreator'
import type { JwtTokenFactory } from './workflow/jwtTokenFactory'

const PLURAL = 'workflowrecipes'
const MIN_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS = 5_000
const MAX_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS = 30_000
const WORKLOAD_STATUS_REFRESH_INTERVAL_MS = 30_000
const WORKFLOW_RUN_ID_LABEL = 'clerum.io/workflow-run-id'

export interface WorkflowRecipeWatchObject {
  metadata: {
    name: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    generation?: number
    deletionTimestamp?: string
    finalizers?: string[]
    annotations?: Record<string, string>
    labels?: Record<string, string>
    ownerReferences?: WorkflowRecipeCRD['metadata']['ownerReferences']
  }
  spec: WorkflowRecipeSpec
  status?: WorkflowRecipeCRD['status']
}

export function workflowRecipeFromWatchObject(
  apiObj: WorkflowRecipeWatchObject,
  fallbackNamespace: string
): WorkflowRecipeCRD {
  return {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}` as 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: apiObj.metadata.name,
      namespace: apiObj.metadata.namespace || fallbackNamespace,
      uid: apiObj.metadata.uid,
      resourceVersion: apiObj.metadata.resourceVersion,
      generation: apiObj.metadata.generation,
      finalizers: apiObj.metadata.finalizers,
      deletionTimestamp: apiObj.metadata.deletionTimestamp,
      annotations: apiObj.metadata.annotations,
      labels: apiObj.metadata.labels,
      ownerReferences: apiObj.metadata.ownerReferences,
    },
    spec: apiObj.spec,
    status: apiObj.status,
  }
}

export function shouldPatchRecipeStatus(
  recipe: WorkflowRecipeCRD,
  result: ReconcileResult
): boolean {
  if (result.skipStatusPatch) return false
  if (recipe.status?.phase !== result.phase) return true
  if (recipe.status?.message !== result.message) return true
  if (workloadStatusesChanged(recipe, result)) return true

  // Merge-patching status maps preserves fields omitted by the next patch.
  // Keep the SDK capability message aligned with its owned condition so a
  // previous status-only refresh cannot leave a contradictory
  // `state=validated` + `message=bootstrap not ready` record behind.
  if (pluginWorkloadSdkStatusMessageChanged(recipe)) return true

  if (
    ownedConditionsChanged(recipe.status?.conditions, result.internalDependencyConditions, [
      'InternalDependenciesReady',
    ])
  ) {
    return true
  }

  // Parent workflow recipes may remain active while stale execution status is
  // cleared. That still needs one status patch even though phase is unchanged.
  if (result.clearWorkflowExecution && recipe.status?.workflowExecution) return true

  return false
}

function pluginWorkloadSdkStatusMessageChanged(recipe: WorkflowRecipeCRD): boolean {
  const capability = recipe.status?.pluginWorkloadSdk
  if (!capability) return false
  const condition = recipe.status?.conditions?.find(
    candidate => candidate.type === 'PluginWorkloadSdkCapability'
  )
  if (typeof condition?.message !== 'string') return false
  return capability.message !== condition.message
}

function workflowRunIdForTelemetry(recipe: WorkflowRecipeCRD): string | undefined {
  const runId = recipe.metadata.labels?.[WORKFLOW_RUN_ID_LABEL]?.trim()
  return runId || undefined
}

export function reconcileOutcomeTelemetryProjection(
  recipe: WorkflowRecipeCRD,
  result: ReconcileResult,
  occurredAt = new Date().toISOString()
): WorkflowInfrastructureTelemetryProjection | undefined {
  const runId = workflowRunIdForTelemetry(recipe)
  if (!runId) return undefined
  return {
    sourceEventId: `workflow-reconcile:${recipe.metadata.namespace}:${recipe.metadata.name}:generation:${recipe.metadata.generation ?? 'unknown'}:${result.phase}`,
    occurredAt,
    telemetryType: 'reconcile_outcome',
    runId,
    payload: {
      phase: result.phase,
      status: result.skipStatusPatch ? 'skipped' : 'patched',
    },
  }
}

export function controllerErrorTelemetryProjection(
  recipe: WorkflowRecipeCRD,
  error: unknown,
  occurredAt = new Date().toISOString()
): WorkflowInfrastructureTelemetryProjection | undefined {
  const runId = workflowRunIdForTelemetry(recipe)
  if (!runId) return undefined
  const errorClass =
    error instanceof Error && error.name.trim()
      ? error.name
      : typeof error === 'object' && error !== null
        ? error.constructor?.name || 'unknown'
        : 'unknown'
  return {
    sourceEventId: `workflow-controller-error:${recipe.metadata.namespace}:${recipe.metadata.name}:generation:${recipe.metadata.generation ?? 'unknown'}:${errorClass}`,
    occurredAt,
    telemetryType: 'controller_error',
    runId,
    payload: {
      phase: recipe.status?.phase,
      status: 'error',
      error_class: errorClass,
    },
  }
}

function enqueueInfrastructureTelemetryBestEffort(
  traceReporter: GovernedTraceReporter | null,
  projection: WorkflowInfrastructureTelemetryProjection | undefined
): void {
  if (!traceReporter || !projection) return
  try {
    traceReporter.enqueueInfrastructureTelemetry(projection)
  } catch (error) {
    console.error('[WR-K8s] Infrastructure telemetry enqueue failed:', error)
  }
}

function workloadStatusesChanged(recipe: WorkflowRecipeCRD, result: ReconcileResult): boolean {
  const existing = normalizeExistingWorkloadStatuses(recipe.status?.workloads)
  const fresh = normalizeResultWorkloadStatuses(recipe, result)

  if (existing.length !== fresh.length) return true
  return fresh.some((status, index) => !sameWorkloadStatus(existing[index], status))
}

function normalizeExistingWorkloadStatuses(
  statuses: WorkloadStatus[] | undefined
): WorkloadStatus[] {
  return (statuses ?? []).map(status => ({
    id: status.id,
    type: status.type,
    phase: status.phase,
    ready: status.ready,
    message: status.message,
  }))
}

function normalizeResultWorkloadStatuses(
  recipe: WorkflowRecipeCRD,
  result: ReconcileResult
): WorkloadStatus[] {
  return result.workloadStatuses.map(status => {
    const def = (recipe.spec.workloads ?? []).find(workload => workload.id === status.id)
    return {
      id: status.id,
      type: def?.type ?? 'deployment',
      phase: status.phase,
      ready: status.ready,
      message: status.message,
    }
  })
}

function sameWorkloadStatus(a: WorkloadStatus, b: WorkloadStatus): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.phase === b.phase &&
    a.ready === b.ready &&
    a.message === b.message
  )
}

function ownedConditionsChanged(
  existing: StatusCondition[] | undefined,
  fresh: StatusCondition[] | undefined,
  ownedTypes: string[]
): boolean {
  const existingByType = new Map(existing?.map(condition => [condition.type, condition]) ?? [])
  const freshByType = new Map(fresh?.map(condition => [condition.type, condition]) ?? [])

  return ownedTypes.some(type => {
    const existingCondition = existingByType.get(type)
    const freshCondition = freshByType.get(type)
    if (!freshCondition) return existingCondition !== undefined
    if (!existingCondition) return true
    return !sameConditionSignal(existingCondition, freshCondition)
  })
}

function sameConditionSignal(a: StatusCondition, b: StatusCondition): boolean {
  return a.status === b.status && a.reason === b.reason && a.message === b.message
}

export function runtimeCredentialRefreshIntervalMs(config: {
  runtimeTokenRefreshBeforeSeconds: number
}): number {
  return Math.max(
    MIN_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS,
    Math.min(
      MAX_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS,
      Math.floor((config.runtimeTokenRefreshBeforeSeconds * 1_000) / 4)
    )
  )
}

export function workflowNeedsRuntimeCredentialRefresh(recipe: WorkflowRecipeCRD): boolean {
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  if (!isWorkflow || recipe.metadata.deletionTimestamp) return false

  const workflowPhase = recipe.status?.workflowExecution?.phase
  return (
    workflowPhase === 'initializing' ||
    workflowPhase === 'running' ||
    workflowPhase === 'recovering'
  )
}

export function workflowNeedsInfrastructureReconcile(recipe: WorkflowRecipeCRD): boolean {
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  if (recipe.metadata.deletionTimestamp) return false

  // SDK-only recipes are deliberately stepless, but their eager mcp-host and
  // bootstrap proof still need the full reconciler lane. The generic workload
  // status-refresh path cannot represent that proof and would overwrite a
  // validated SDK capability with BootstrapNotReady while leaving phase=active.
  // Keep this level-triggered retry independent from workflowExecution.
  if (!isWorkflow && recipe.spec.pluginWorkloadSdk) return true
  if (!isWorkflow) return false

  const workflowPhase = recipe.status?.workflowExecution?.phase
  if (workflowPhase === 'initializing' || workflowPhase === 'recovering') return true

  // Plugin Workload SDK eager path: the recipe sits in phase=active with no run
  // (workflowExecution cleared), but the WRC must keep reconciling so the eager
  // mcp-host stays alive (recreated after any pod death — restartPolicy: Never)
  // and, for promptBridge, its provider gets (re-)configured once Ready. Both
  // families (promptBridge AND clientNotifications-only) run the always-on eager
  // SDK mcp-host, so both must re-trigger. The reconcile + /configure are
  // idempotent, so a periodic level-triggered retry is safe. Without this, a
  // clientNotifications-only eager mcp-host whose pod dies is never recreated
  // until an unrelated spec edit, and promptBridge stays provider_unavailable.
  if (recipe.spec.pluginWorkloadSdk && workflowPhase === undefined) return true

  return false
}

export function workflowNeedsTerminalRunTeardown(recipe: WorkflowRecipeCRD): boolean {
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  if (!isWorkflow || recipe.metadata.deletionTimestamp) return false
  if (!recipe.metadata.labels?.['clerum.io/workflow-run-id']?.trim()) return false

  const workflowPhase = recipe.status?.workflowExecution?.phase
  return (
    workflowPhase === 'completed' || workflowPhase === 'failed' || workflowPhase === 'cancelled'
  )
}

export function workflowNeedsWorkloadStatusRefresh(recipe: WorkflowRecipeCRD): boolean {
  if (recipe.metadata.deletionTimestamp) return false
  if ((recipe.spec.steps ?? []).length > 0) return false
  // SDK-only recipes have capability state (including the eager bootstrap
  // proof) that is owned by the full reconciler. A status-only workload read
  // has no proof to carry and would corrupt the persisted SDK projection.
  if (recipe.spec.pluginWorkloadSdk) return false
  if ((recipe.spec.workloads ?? []).length === 0) return false

  return recipe.status?.phase === 'active' || recipe.status?.phase === 'degraded'
}

/**
 * Issue #637 — does this recipe project any name-based Secret (`envSecret` or
 * `imagePullSecrets`) that the ownership gate must keep re-validating? Used as a
 * periodic backstop: the SecretWatcher is the fast, event-driven revocation path,
 * but a deterministic re-classification every refresh interval guarantees a Secret
 * re-labeled foreign in ANY of the three runtime namespaces is revoked even if a
 * watch event was delayed or coalesced.
 */
export function recipeReferencesNamedSecrets(recipe: WorkflowRecipeCRD): boolean {
  return (recipe.spec.workloads ?? []).some(
    w => Boolean(w.envSecret?.name) || (w.imagePullSecrets?.length ?? 0) > 0
  )
}

/**
 * Issue #637 — a steady-state WORKFLOW recipe (steps>0) that projects a name-based
 * Secret needs the SAME periodic ownership re-classification that pure-workload
 * recipes already get through `workflowNeedsWorkloadStatusRefresh`. That predicate
 * deliberately excludes workflow recipes (their status is workflowExecution-driven,
 * not workload-observation-driven), so without this the periodic backstop covered
 * only non-workflow recipes: a Secret re-labeled foreign during a long-running
 * workflow was revoked solely by the event-driven SecretWatcher, with no
 * deterministic timer fallback if a watch event was delayed or coalesced. This gate
 * lets such workflow recipes through to an OWNERSHIP-ONLY re-reconcile (no workload
 * status patch), reusing the already-hardened steady-state revocation path
 * (`revokeOrRequeueSteadyWorkflow`).
 */
export function workflowNeedsOwnershipBackstop(recipe: WorkflowRecipeCRD): boolean {
  if (recipe.metadata.deletionTimestamp) return false
  if ((recipe.spec.steps ?? []).length === 0) return false
  return recipeReferencesNamedSecrets(recipe)
}

export interface WorkflowRecipeProvider {
  getAllRecipes(): WorkflowRecipeCRD[]
  start(): Promise<void>
  stop(): Promise<void>
  /** JWT signer initialized at startup (null if signing-key Secret is absent). */
  getTokenFactory(): JwtTokenFactory | null
  /** Best-effort governed trace reporter shared by WRC status paths. */
  getTraceReporter(): GovernedTraceReporter | null
  /** DB-first run processor — null in dev mode or when pool is unavailable. */
  getDbRunProcessor(): DbRunProcessor | null
}

// One refresh pass over every cached recipe that opts into backgroundAccess.
// Exported so a unit test can exercise it without booting the watcher / Watch.
export async function rotateBrokerTokensOnce(
  recipes: Iterable<WorkflowRecipeCRD>,
  refresh: (recipe: WorkflowRecipeCRD) => Promise<void>,
  onError?: (recipe: WorkflowRecipeCRD, err: unknown) => void
): Promise<void> {
  for (const recipe of recipes) {
    if (!recipeHasBackgroundAccessClient(recipe)) continue
    try {
      await refresh(recipe)
    } catch (err) {
      onError?.(recipe, err)
    }
  }
}

// JWT TTL=600s, refresh-before window=300s in the reconciler. 60s ticks give
// 5 chances to refresh before expiry and keep per-recipe load to one secret
// read + (rare) one write per minute.
const BROKER_TOKEN_ROTATION_INTERVAL_MS = 60_000

/**
 * Production watcher — watches WorkflowRecipe CRDs and triggers reconciliation.
 */
export class WorkflowRecipeWatcher implements WorkflowRecipeProvider {
  private watch: k8s.Watch
  private kc: k8s.KubeConfig
  private customApi: k8s.CustomObjectsApi
  private watchRequest: { abort: () => void } | null = null
  private recipes: Map<string, WorkflowRecipeCRD> = new Map()
  private reconciler: WorkflowRecipeReconciler
  private dbRunProcessor: DbRunProcessor | null = null
  private config = loadConfig()
  private stopped = false
  private runtimeCredentialRefreshTimer: ReturnType<typeof setInterval> | null = null
  private runtimeCredentialRefreshRunning = false
  private workloadStatusRefreshTimer: ReturnType<typeof setInterval> | null = null
  private workloadStatusRefreshRunning = false
  private eventQueue = new RecipeEventQueue((key, error) => {
    console.error(`[WR-K8s] Unhandled event failure for "${key}":`, error)
  })
  private secretReverseIndex = new SecretReverseIndex()
  private secretWatchLoops: K8sSecretWatchLoop[] = []
  private brokerRotationTimer: NodeJS.Timeout | null = null
  private traceReporter: GovernedTraceReporter | null = createGovernedTraceReporter(
    this.config.governedTracingEnabled
  )
  // Per-recipe deterministic retry for transient (skipStatusPatch) reconcile
  // results: no status patch ⇒ no MODIFIED event, so we must schedule the retry
  // ourselves with bounded exponential backoff. Cleared on any non-transient
  // result or DELETE.
  private transientRetries = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; attempts: number }
  >()
  private static readonly TRANSIENT_RETRY_MAX_MS = 60_000

  constructor(kc: k8s.KubeConfig, pool?: Pool | null) {
    this.kc = kc
    this.watch = new k8s.Watch(kc)
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi)
    this.reconciler = new WorkflowRecipeReconciler(kc, undefined, {
      secretReverseIndex: this.secretReverseIndex,
    })

    if (pool && this.config.db) {
      this.dbRunProcessor = createDbRunProcessor({
        instanceId: this.config.db.instanceId,
        pool,
        runPollMs: this.config.db.runPollMs,
        createChildRecipe: this.makeChildRecipeCreator(),
        childRecipeExists: this.makeChildRecipeExists(),
        onRunStarted: runId => {
          this.traceReporter?.enqueueWorkflowLifecycle({
            sourceEventId: `workflow-run:${runId}:start`,
            occurredAt: new Date().toISOString(),
            runId,
            eventType: 'run_start',
            payload: { phase: 'Running' },
          })
        },
        onRunTerminal: (runId, phase) => {
          this.traceReporter?.enqueueWorkflowLifecycle({
            sourceEventId: `workflow-run:${runId}:terminal`,
            occurredAt: new Date().toISOString(),
            runId,
            eventType: 'run_end',
            payload: { phase },
          })
        },
      })
    }
  }

  getAllRecipes(): WorkflowRecipeCRD[] {
    return [...this.recipes.values()]
  }

  getTokenFactory(): JwtTokenFactory | null {
    // Exposed by the reconciler once initializeWorkflow() has run.
    // Will be null until the signing-key Secret has been read successfully.
    return this.reconciler.tokenFactory
  }

  getTraceReporter(): GovernedTraceReporter | null {
    return this.traceReporter
  }

  getDbRunProcessor(): DbRunProcessor | null {
    return this.dbRunProcessor
  }

  /**
   * Builds the closure the DB run processor invokes when it needs to
   * materialize a child WorkflowRecipe for a Pending run. This is the ONLY
   * bridge between the DB-driven run lifecycle and the K8s API.
   */
  private makeChildRecipeCreator(): ChildRecipeCreator {
    return async (run: DbRunRow) => createDbRunChildRecipe(this.customApi, run)
  }

  private makeChildRecipeExists(): ChildRecipeExistenceChecker {
    return async ({ name, namespace }) => {
      try {
        await this.customApi.getNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: WORKFLOWRECIPE_PLURAL,
          name,
        })
        return true
      } catch (err) {
        if (getErrorCode(err) === 404) return false
        throw err
      }
    }
  }

  async start(): Promise<void> {
    console.log('[WR-K8s] Starting WorkflowRecipe watcher')

    // Initialize workflow subsystem by reading the signing key from control-plane.
    // Non-fatal: if the Secret doesn't exist, workflow recipes will gracefully fail
    // but traditional workload recipes continue to work.
    await this.tryInitializeWorkflow()

    await this.startWatch()
    await this.startSecretWatch()
    this.startBrokerTokenRotationLoop()
    this.startRuntimeCredentialRefreshLoop()
    this.startWorkloadStatusRefreshLoop()

    if (this.dbRunProcessor) {
      await this.dbRunProcessor.start()
    }
  }

  // Refreshes opted-in recipes' broker-token Secrets between CRD events.
  // Serializes per recipe through the same queue as watch events so a
  // refresh never races with an in-flight reconcile.
  private startBrokerTokenRotationLoop(): void {
    const tick = () => {
      void rotateBrokerTokensOnce(
        this.recipes.values(),
        recipe =>
          this.eventQueue.enqueue(recipe.metadata.name, () =>
            this.reconciler.ensureOAuthBrokerTokenSecret(recipe)
          ),
        (recipe, err) => {
          console.error(`[WR-K8s] Broker-token refresh failed for "${recipe.metadata.name}":`, err)
        }
      )
    }
    this.brokerRotationTimer = setInterval(tick, BROKER_TOKEN_ROTATION_INTERVAL_MS)
    // Node treats setInterval as a ref by default — without unref(), the loop
    // would keep the process alive during graceful shutdown windows.
    this.brokerRotationTimer.unref?.()
  }

  private async startSecretWatch(): Promise<void> {
    // Issue #637 — watch Secrets in EVERY namespace a recipe's workloads can mount
    // them from (transport → mcp-server, ui.workloadRef → sandbox-ui, rest →
    // sandbox-recipes), so a Secret created or re-labeled foreign in ANY of them
    // fans out a re-reconcile and the ownership gate re-evaluates (revocation /
    // deferred-foreign-creation). Watching only sandbox-recipes left an mcp-server
    // or sandbox-ui Secret change unobserved, so an already-rendered `missing`/
    // previously-allowed ref could turn foreign without re-classification.
    //
    // Each namespace gets its OWN SecretWatcher so the per-name last-seen dedup
    // state never collides across namespaces (the same Secret name can exist in
    // two of them); all share the reverse index + the enqueue callback. Fan-out is
    // by name, so a change over-triggers harmless re-reconciles at worst.
    const watchedNamespaces = [
      ...new Set([
        this.config.sandboxNamespace,
        this.config.namespace,
        this.config.sandboxUiNamespace,
      ]),
    ]
    for (const namespace of watchedNamespaces) {
      const handler = new SecretWatcher(this.secretReverseIndex, name =>
        this.triggerSecretDrivenReconcile(name)
      )
      const loop = new K8sSecretWatchLoop(this.kc, namespace, handler)
      this.secretWatchLoops.push(loop)
      await loop.start()
    }
  }

  /**
   * Enqueue a re-reconcile for a recipe whose referenced Secret's key-set
   * just changed. The cached recipe object is reused — no extra GET against
   * the apiserver. If the recipe is no longer in our cache (e.g. it was
   * deleted between the Secret event and the debounce fire), we skip.
   */
  private triggerSecretDrivenReconcile(recipeName: string): void {
    const recipe = this.recipes.get(recipeName)
    if (!recipe) return
    // Issue #637 — a Secret re-label does NOT bump the recipe's metadata.generation,
    // so a plain 'MODIFIED' event is classified status-only and short-circuits BEFORE
    // reconcile() (and thus before the ownership gate `revokeOrRequeueSteadyWorkflow`).
    // forceReconcile makes the event-driven revocation actually re-evaluate ownership;
    // without it a foreign re-label is only caught by the slower 30s periodic backstop,
    // not the ~10s watcher debounce this path exists to provide.
    this.eventQueue.enqueue(recipeName, () =>
      this.handleRecipeEvent('MODIFIED', recipe, { forceReconcile: true })
    )
  }

  private async tryInitializeWorkflow(): Promise<void> {
    const SIGNING_KEY_SECRET = 'clerum-wrc-signing-key'
    const SIGNING_KEY_NS = this.config.controlPlaneNamespace

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api)
      const secret = await coreApi.readNamespacedSecret({
        name: SIGNING_KEY_SECRET,
        namespace: SIGNING_KEY_NS,
      })

      const privateKeyB64 = secret.data?.['private.pem']
      const publicKeyB64 = secret.data?.['public.pem']
      if (!privateKeyB64) {
        console.warn(
          `[WR-K8s] Secret "${SIGNING_KEY_SECRET}" exists but missing private.pem key — workflow disabled`
        )
        return
      }
      if (!publicKeyB64) {
        console.warn(
          `[WR-K8s] Secret "${SIGNING_KEY_SECRET}" exists but missing public.pem key — JWT verification disabled`
        )
      }

      const privateKeyPem = Buffer.from(privateKeyB64, 'base64').toString('utf-8')
      const publicKeyPem = publicKeyB64
        ? Buffer.from(publicKeyB64, 'base64').toString('utf-8')
        : undefined
      await this.reconciler.initializeWorkflow(privateKeyPem, publicKeyPem)
      console.log('[WR-K8s] Workflow subsystem initialized from signing key')
    } catch (error: unknown) {
      const code = (error as { response?: { statusCode?: number } })?.response?.statusCode
      if (code === 404 || code === 403) {
        console.warn(
          `[WR-K8s] Signing key Secret not found or forbidden (${code}) — workflow disabled`
        )
      } else {
        console.warn('[WR-K8s] Failed to read signing key — workflow disabled:', error)
      }
    }
  }

  private async startWatch(): Promise<void> {
    // Design invariant: WorkflowRecipe CRDs are watched only in sandbox-recipes.
    // Transport workloads may render McpServer children in mcp-server, but the
    // recipe CRD itself is never stored or reconciled from that namespace.
    const path = `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${this.config.sandboxNamespace}/${PLURAL}`

    const watchCallback = (type: string, apiObj: WorkflowRecipeWatchObject) => {
      const recipe = workflowRecipeFromWatchObject(apiObj, this.config.sandboxNamespace)

      console.log(`[WR-K8s] Watch event: ${type} for "${recipe.metadata.name}"`)

      this.eventQueue.enqueue(recipe.metadata.name, () => this.handleRecipeEvent(type, recipe))
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      if (err) {
        console.error('[WR-K8s] Watch error:', err)
      }
      console.log('[WR-K8s] Watch ended, restarting...')
      setTimeout(() => this.startWatch(), err ? 5000 : 1000)
    }

    this.watchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
  }

  private async handleRecipeEvent(
    type: string,
    recipe: WorkflowRecipeCRD,
    options: { forceReconcile?: boolean } = {}
  ): Promise<void> {
    if (type === 'ADDED' || type === 'MODIFIED') {
      let dbSyncAttempted = false
      if (recipe.metadata.deletionTimestamp) {
        // Resource is being deleted — cleanup cross-namespace resources, then remove finalizer.
        console.log(`[WR-K8s] Finalizer cleanup for "${recipe.metadata.name}"`)
        try {
          await this.reconciler.reconcileDelete(recipe)
          await this.reconciler.removeFinalizer(recipe)
        } catch (error) {
          if (getErrorCode(error) === 404) {
            console.warn(
              `[WR-K8s] Finalizer cleanup skipped for "${recipe.metadata.name}"; recipe already gone`
            )
          } else {
            console.error(`[WR-K8s] Finalizer cleanup failed for "${recipe.metadata.name}":`, error)
          }
        }
        this.recipes.delete(recipe.metadata.name)
        return
      }

      if (
        type === 'MODIFIED' &&
        !options.forceReconcile &&
        this.isStatusOnlyModifiedEvent(recipe)
      ) {
        this.recipes.set(recipe.metadata.name, recipe)
        const needsTerminalRunTeardown = workflowNeedsTerminalRunTeardown(recipe)
        // A status-only MODIFIED event (generation unchanged) is exactly how a
        // workflow run's terminal completion and per-step transitions arrive —
        // Kubernetes bumps .metadata.generation only on .spec changes, never on
        // .status. Skipping the expensive full reconcile here is correct, but we
        // MUST still drive the CRD->DB sync, otherwise a completed run's DB row
        // stays Running forever (UI shows "running", dbRunProcessor keeps logging
        // "orphaned running run reclaimed"). syncFromRecipeExecution is DB-only
        // (no CRD patch ⇒ no MODIFIED event ⇒ no reconcile loop); on terminal it
        // flips Running→Succeeded|Failed|Canceled, on non-terminal it bumps the
        // last_reconciled_at heartbeat that suppresses orphan reclaim.
        if (this.dbRunProcessor) {
          try {
            await this.dbRunProcessor.syncFromRecipeExecution(recipe)
          } catch (error) {
            console.error(
              `[WR-K8s] DB sync failed for status-only event "${recipe.metadata.name}":`,
              error
            )
          } finally {
            dbSyncAttempted = true
          }
        }
        if (needsTerminalRunTeardown) {
          console.log(
            `[WR-K8s] Terminal run status-only event for "${recipe.metadata.name}" — forcing reconcile for compute teardown`
          )
        } else {
          return
        }
      }

      // Normal reconciliation — ensure finalizer first for cross-namespace safety.
      this.recipes.set(recipe.metadata.name, recipe)
      try {
        if (!(await this.reconciler.isRecipeStillActive(recipe))) {
          console.warn(
            `[WR-K8s] Skipping stale event for "${recipe.metadata.name}"; recipe is gone or deleting`
          )
          this.recipes.delete(recipe.metadata.name)
          return
        }
        if (this.dbRunProcessor && !dbSyncAttempted) {
          await this.dbRunProcessor.syncFromRecipeExecution(recipe)
        }
        await this.reconciler.ensureFinalizer(recipe)
        if (!(await this.reconciler.isRecipeStillActive(recipe))) {
          console.warn(
            `[WR-K8s] Skipping reconcile for "${recipe.metadata.name}"; recipe started deleting after finalizer check`
          )
          this.recipes.delete(recipe.metadata.name)
          return
        }
        const result = await this.reconciler.reconcile(recipe)
        // Patch only when observable status changes. This avoids reconcile loops
        // while still allowing active parent recipes to clear stale execution state.
        if (shouldPatchRecipeStatus(recipe, result)) {
          await this.reconciler.patchStatus(recipe, result)
          enqueueInfrastructureTelemetryBestEffort(
            this.traceReporter,
            reconcileOutcomeTelemetryProjection(recipe, result)
          )
        }
        // Transient (skipStatusPatch) results write no status ⇒ emit no MODIFIED
        // event, so schedule a deterministic backoff retry ourselves. Any other
        // result clears the per-recipe backoff.
        if (result.requeueAfterMs && !this.stopped) {
          this.scheduleTransientRetry(
            recipe.metadata.name,
            result.requeueAfterMs,
            result.requeueFixedInterval ?? false
          )
        } else {
          this.clearTransientRetry(recipe.metadata.name)
        }
      } catch (error) {
        if (getErrorCode(error) === 404) {
          console.warn(
            `[WR-K8s] Reconciliation skipped for "${recipe.metadata.name}"; recipe already gone`
          )
          this.recipes.delete(recipe.metadata.name)
          return
        }
        console.error(`[WR-K8s] Reconciliation failed for "${recipe.metadata.name}":`, error)
        enqueueInfrastructureTelemetryBestEffort(
          this.traceReporter,
          controllerErrorTelemetryProjection(recipe, error)
        )
      }
    } else if (type === 'DELETED') {
      // Resource is gone (finalizer already removed) — just clean cache.
      this.clearTransientRetry(recipe.metadata.name)
      this.recipes.delete(recipe.metadata.name)
    }
  }

  private isStatusOnlyModifiedEvent(recipe: WorkflowRecipeCRD): boolean {
    const cached = this.recipes.get(recipe.metadata.name)
    const cachedGeneration = cached?.metadata.generation
    const nextGeneration = recipe.metadata.generation
    return (
      cachedGeneration !== undefined &&
      nextGeneration !== undefined &&
      cachedGeneration === nextGeneration
    )
  }

  /**
   * Schedule a timer-driven re-enqueue for `name`. The retry re-reconciles the
   * cached recipe; if it is still transient/in-progress, handleRecipeEvent
   * reschedules. A non-transient result (or DELETE / stop) calls
   * clearTransientRetry and clears the entry.
   *
   * Two modes (single entry per recipe name, coalesced — any existing timer is
   * cleared before scheduling the next):
   *
   * - `fixedInterval === false` (default, transient ERROR path): bounded
   *   EXPONENTIAL backoff — `delay = min(baseMs * 2**attempts, MAX)` — and the
   *   attempt counter grows so genuine flakiness backs off toward the cap.
   *
   * - `fixedInterval === true` (steady-state PROGRESS path, phase==='deploying'
   *   waiting on a Pod we created): FIXED `delay = baseMs` with `attempts` RESET
   *   to 0. Progress is not an error and must not inherit the error backoff
   *   curve — exponential growth would stretch the poll cadence toward the cap
   *   and re-expose the 240s mcp-host readiness deadline this requeue beats.
   *   Resetting attempts means a later GENUINE transient error starts backoff
   *   fresh from base rather than from a counter inflated by normal progress.
   *
   * Exposed for tests via the watcher's event path.
   */
  private scheduleTransientRetry(name: string, baseMs: number, fixedInterval = false): void {
    const existing = this.transientRetries.get(name)
    // Fixed-interval (progress) requeues reset the backoff counter; transient
    // (error) requeues grow it.
    const attempts = fixedInterval ? 0 : (existing?.attempts ?? 0)
    if (existing) clearTimeout(existing.timer)
    const delay = fixedInterval
      ? baseMs
      : Math.min(baseMs * 2 ** attempts, WorkflowRecipeWatcher.TRANSIENT_RETRY_MAX_MS)
    const timer = setTimeout(() => {
      if (this.stopped) return
      const cached = this.recipes.get(name)
      if (!cached) {
        this.transientRetries.delete(name)
        return
      }
      const label = fixedInterval ? 'progress' : 'transient'
      console.log(`[WR-K8s] ${label} retry for "${name}" (attempt ${attempts + 1}, ${delay}ms)`)
      void this.eventQueue.enqueue(name, () =>
        this.handleRecipeEvent('MODIFIED', cached, { forceReconcile: true })
      )
    }, delay)
    timer.unref?.()
    // Fixed-interval progress requeues keep attempts pinned at 0 (no backoff);
    // transient-error requeues preserve a growing attempt count so they back off.
    // NOTE: a fixed 5s interval × N concurrent deploying runs is N/5 reconciles
    // per second. We accept that load tradeoff for prompt progress; the inner
    // reconcile advances past the waiting state once the awaited Pod succeeds,
    // and the 240s readiness deadline / dbRunProcessor max-duration paths
    // terminate any run permanently stuck in deploying, so this is bounded.
    this.transientRetries.set(name, { timer, attempts: fixedInterval ? 0 : attempts + 1 })
  }

  private clearTransientRetry(name: string): void {
    const existing = this.transientRetries.get(name)
    if (existing) {
      clearTimeout(existing.timer)
      this.transientRetries.delete(name)
    }
  }

  private startRuntimeCredentialRefreshLoop(): void {
    if (this.runtimeCredentialRefreshTimer) return

    const intervalMs = runtimeCredentialRefreshIntervalMs(this.config)
    this.runtimeCredentialRefreshTimer = setInterval(() => {
      if (this.runtimeCredentialRefreshRunning) return
      this.runtimeCredentialRefreshRunning = true
      void this.refreshRuntimeCredentialsForInProgressRecipes().finally(() => {
        this.runtimeCredentialRefreshRunning = false
      })
    }, intervalMs)
    this.runtimeCredentialRefreshTimer.unref?.()
  }

  private startWorkloadStatusRefreshLoop(): void {
    if (this.workloadStatusRefreshTimer) return

    // Child workload readiness can drift without a WorkflowRecipe CRD event.
    // Re-enqueue steady active/degraded workload recipes so reconcile observes
    // Kubernetes status and patches degradation or recovery.
    this.workloadStatusRefreshTimer = setInterval(() => {
      if (this.workloadStatusRefreshRunning) return
      this.workloadStatusRefreshRunning = true
      void this.refreshWorkloadStatusesForSteadyRecipes().finally(() => {
        this.workloadStatusRefreshRunning = false
      })
    }, WORKLOAD_STATUS_REFRESH_INTERVAL_MS)
    this.workloadStatusRefreshTimer.unref?.()
  }

  private async refreshWorkloadStatusesForSteadyRecipes(): Promise<void> {
    if (this.stopped) return

    const refreshes = [...this.recipes.keys()].map(async recipeName => {
      const latest = this.recipes.get(recipeName)
      if (!latest) return
      const needsStatusRefresh = workflowNeedsWorkloadStatusRefresh(latest)
      // Issue #637 — workflow recipes are excluded from the status refresh but must
      // still get a periodic ownership re-classification (their only other revocation
      // path is the event-driven SecretWatcher).
      const needsOwnershipBackstop = workflowNeedsOwnershipBackstop(latest)
      if (!needsStatusRefresh && !needsOwnershipBackstop) return

      try {
        await this.eventQueue.enqueue(recipeName, () =>
          this.refreshWorkloadStatusOnly(latest, { ownershipOnly: !needsStatusRefresh })
        )
      } catch (error) {
        console.error(`[WR-K8s] Workload status refresh failed for "${recipeName}":`, error)
      }
    })

    await Promise.all(refreshes)
  }

  private async refreshWorkloadStatusOnly(
    recipe: WorkflowRecipeCRD,
    opts: { ownershipOnly?: boolean } = {}
  ): Promise<void> {
    if (opts.ownershipOnly) {
      // Issue #637 — workflow-recipe ownership backstop. Skip the workload-status
      // observe/patch (a workflow's status is workflowExecution-driven) and force a
      // reconcile so the steady-state ownership gate re-classifies and revokes a
      // Secret re-labeled foreign even if the SecretWatcher event was missed.
      await this.handleRecipeEvent('MODIFIED', recipe, { forceReconcile: true })
      return
    }
    const result = await this.reconciler.observeCurrentWorkloadStatus(recipe)
    if (shouldPatchRecipeStatus(recipe, result)) {
      await this.reconciler.patchStatus(recipe, result)
      enqueueInfrastructureTelemetryBestEffort(
        this.traceReporter,
        reconcileOutcomeTelemetryProjection(recipe, result)
      )
    }
    // Issue #637 — periodically force a full reconcile for recipes that project a
    // name-based Secret, so the ownership gate re-classifies and a Secret re-labeled
    // foreign in mcp-server/sandbox-ui is revoked DETERMINISTICALLY (within this
    // interval) even if the SecretWatcher's event-driven fan-out was delayed or
    // coalesced. The full reconcile is idempotent for an unchanged recipe.
    const ownershipRecheck = recipeReferencesNamedSecrets(recipe)
    if (ownershipRecheck || result.workloadStatuses.some(status => status.ready === false)) {
      await this.handleRecipeEvent('MODIFIED', recipe, { forceReconcile: true })
    }
  }

  private async refreshRuntimeCredentialsForInProgressRecipes(): Promise<void> {
    if (this.stopped) return

    const refreshes = [...this.recipes.keys()].map(async recipeName => {
      const latest = this.recipes.get(recipeName)
      if (!latest) return
      try {
        if (workflowNeedsRuntimeCredentialRefresh(latest)) {
          await this.reconciler.refreshInProgressWorkflowRuntimeCredentials(latest)
        }
        if (workflowNeedsInfrastructureReconcile(latest)) {
          await this.eventQueue.enqueue(recipeName, () =>
            // Infrastructure retries are timer-driven with an unchanged CRD
            // generation. Force the full reconcile; otherwise the watcher
            // classifies this synthetic MODIFIED event as status-only and
            // returns before re-running the eager SDK bootstrap lane.
            this.handleRecipeEvent('MODIFIED', latest, { forceReconcile: true })
          )
        }
      } catch (error) {
        console.error(
          `[WR-K8s] Runtime credential refresh or infrastructure retry failed for "${recipeName}":`,
          error
        )
      }
    })

    await Promise.all(refreshes)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const { timer } of this.transientRetries.values()) clearTimeout(timer)
    this.transientRetries.clear()
    if (this.runtimeCredentialRefreshTimer) {
      clearInterval(this.runtimeCredentialRefreshTimer)
      this.runtimeCredentialRefreshTimer = null
    }
    if (this.workloadStatusRefreshTimer) {
      clearInterval(this.workloadStatusRefreshTimer)
      this.workloadStatusRefreshTimer = null
    }
    if (this.watchRequest) {
      console.log('[WR-K8s] Stopping watch')
      this.watchRequest.abort()
      this.watchRequest = null
    }
    for (const loop of this.secretWatchLoops) {
      loop.stop()
    }
    this.secretWatchLoops = []
    if (this.brokerRotationTimer) {
      clearInterval(this.brokerRotationTimer)
      this.brokerRotationTimer = null
    }
    if (this.dbRunProcessor) {
      await this.dbRunProcessor.stop()
    }
    if (this.traceReporter) {
      const result = await this.traceReporter.stopAndDrain()
      if (!result.drained) {
        console.warn('[WR-K8s] Governed trace reporter shutdown timed out', {
          dropped: result.dropped,
        })
      }
    }
  }
}

/**
 * Dev mode provider — reads recipes from CLERUM_RECIPES env var.
 */
export class DevWorkflowRecipeProvider implements WorkflowRecipeProvider {
  private recipes: Map<string, WorkflowRecipeCRD> = new Map()

  getAllRecipes(): WorkflowRecipeCRD[] {
    return [...this.recipes.values()]
  }

  getTokenFactory(): JwtTokenFactory | null {
    return null
  }

  getTraceReporter(): GovernedTraceReporter | null {
    return null
  }

  getDbRunProcessor(): DbRunProcessor | null {
    return null
  }

  async start(): Promise<void> {
    const raw = process.env.CLERUM_RECIPES
    if (!raw) {
      console.log('[WR-Dev] No CLERUM_RECIPES env var — starting with empty recipe list')
      return
    }

    try {
      const recipes = JSON.parse(raw) as WorkflowRecipeCRD[]
      for (const recipe of recipes) {
        this.recipes.set(recipe.metadata.name, recipe)
        console.log(`[WR-Dev] Loaded recipe: ${recipe.metadata.name}`)
      }
      console.log(`[WR-Dev] Loaded ${this.recipes.size} recipe(s)`)
    } catch (error) {
      console.error('[WR-Dev] Failed to parse CLERUM_RECIPES:', error)
    }
  }

  async stop(): Promise<void> {
    console.log('[WR-Dev] Stopping dev provider')
  }
}

/**
 * Create the appropriate provider based on mode. In production the Postgres
 * pool is initialized here so the WRC replica has a single shared connection
 * pool spanning `DbRunProcessor`, leader election, and any future archive
 * helpers. A missing `config.db` (legacy/test) downgrades the watcher to
 * "no DB processor" — the CRD watch still works.
 */
export function createWorkflowRecipeProvider(): WorkflowRecipeProvider {
  const config = loadConfig()
  if (config.devMode) {
    console.log('[WR-Provider] Creating dev mode provider')
    return new DevWorkflowRecipeProvider()
  }

  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()

  let pool: Pool | null = null
  if (config.db) {
    try {
      pool = initDb(config.db)
    } catch (err) {
      console.warn(
        '[WR-Provider] initDb() failed — DB run processor disabled:',
        err instanceof Error ? err.message : err
      )
      pool = null
    }
  }

  // Allow tests and early bootstrap to retrieve the already-initialized pool
  // without re-calling initDb().
  if (!pool) {
    try {
      pool = getPool()
    } catch {
      pool = null
    }
  }

  console.log('[WR-Provider] Creating K8s watcher provider')
  return new WorkflowRecipeWatcher(kc, pool)
}
