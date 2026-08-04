import * as k8s from '@kubernetes/client-node'
import { randomBytes } from 'node:crypto'
import { type Logger, createLogger } from '../observability/logger'
import { getErrorCode } from '../reconciler/k8sErrors'
import { effectiveWorkflowContextRefForSpec } from '../reconciler/workflowContext'
import type { WorkflowRecipeSpec } from '../types'
import { resolveEagerSdkMcpHostAgent } from './agentResolution'
import {
  deletePodIfExists,
  getContainerWaitingReason,
  getPodPhase,
  getPodReadiness,
  isRecoverableContainerWaitingReason,
} from './crashRecovery'
import type { JwtTokenFactory } from './jwtTokenFactory'
import type { ModelConfigHandler } from './modelConfigHandler'
import { readMcpHostPodDriftStateIfExists } from './pluginWorkloadSdkPodDrift'
import {
  pluginWorkloadSdkSecretTokensMatch,
  pluginWorkloadSdkTokenSecretKey,
  resolvePluginWorkloadSdkAllowedCallers,
} from './pluginWorkloadSdkTokens'
import { buildMcpHostPod, pluginWorkloadSdkRuntimeContractHash } from './podFactory'
import {
  PLUGIN_WORKLOAD_SDK_LEGACY_TOKEN_DATA_KEY,
  buildMcpHostUrl,
  buildPluginWorkloadSdkTokenSecretName,
} from './resourceNames'
import type { WorkflowRuntimePlan } from './runtimePlan'
import { buildPluginWorkloadSdkTokenSecret } from './secretFactory'
import type { WorkflowConfig } from './types'

export type EagerSdkMcpHostStatus =
  | 'ready'
  | 'awaiting_policy'
  | 'deploying'
  | 'failed'
  | 'provider_unavailable'

export interface EagerSdkBootstrapProof {
  ready: true
  contractVersion: 2
  podUid: string
  provider: string
  model: string
  policyReady?: boolean
  policyState?: string
  policyReason?: string
  /** Optional snapshot when a grant already exists; request authorization
   * always re-reads and validates the current policy. */
  policyRevision?: number
  policyHash?: string
  defaultTargetRef?: string
  defaultProvider?: string
  defaultModel?: string
  verifiedAt: string
}

/**
 * Consecutive eager SDK bootstrap failures tolerated before the provider is
 * surfaced as unavailable instead of an indefinite `deploying`. Mirrors the
 * crash-recovery MAX_ATTEMPTS bound so a permanently-failing provider broker
 * (e.g. a bad secretRef) is not indistinguishable from "still booting".
 */
const MAX_EAGER_CONFIGURE_ATTEMPTS = 3

type EagerConfigureFailureBudget = {
  key: string
  count: number
}

export type PluginWorkloadSdkProvisionerDeps = {
  coreApi: k8s.CoreV1Api
  config: WorkflowConfig
  tokenFactory: JwtTokenFactory
  modelConfigHandler?: ModelConfigHandler
  log: Logger
  ensureMcpHostSecrets: (
    namespace: string,
    recipeName: string,
    runtimeScopeRecipeName: string,
    spec: WorkflowRecipeSpec
  ) => Promise<void>
  applyWorkflowNetworkPolicies: (
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    runtime: WorkflowRuntimePlan,
    awaitsTriggeredRun: boolean,
    eagerSdkMcpHost: boolean
  ) => Promise<void>
  ensureMcpHostHeadlessService: (recipeName: string) => Promise<void>
  createIfNotExists: (createFn: () => Promise<unknown>, label: string) => Promise<boolean>
  safeDelete: (deleteFn: () => Promise<unknown>) => Promise<void>
}

/**
 * Plugin Workload SDK provisioning: eager mcp-host lifecycle, readiness gates,
 * and per-caller workload token Secrets. Extracted from WorkflowReconciler to
 * keep the reconciler file bounded while preserving the existing behavior.
 */
export class PluginWorkloadSdkProvisioner {
  /** Last fresh Control API proof, tied to the current pod UID. */
  private readonly eagerSdkBootstrapProofByRecipe = new Map<string, EagerSdkBootstrapProof>()

  /**
   * Consecutive eager SDK bootstrap failures per recipe and stable bootstrap
   * identity. The budget counts only repeated failures for the same
   * `<podUid>:<provider>:<model>`; a pod replacement or agent model/provider
   * change starts from one without needing WRC to observe the roll directly.
   * Reset on a successful bootstrap (and on recipe cleanup). Once the matching
   * key reaches MAX_EAGER_CONFIGURE_ATTEMPTS the provisioner projects
   * `provider_unavailable` instead of an indefinite `deploying`. Lost on WRC
   * restart, which just re-attempts from zero (bootstrap is idempotent).
   */
  private readonly eagerSdkConfigureFailuresByRecipe = new Map<
    string,
    EagerConfigureFailureBudget
  >()

  constructor(private readonly deps: PluginWorkloadSdkProvisionerDeps) {}

  clearRecipeState(recipeName: string): void {
    this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
    this.eagerSdkConfigureFailuresByRecipe.delete(recipeName)
  }

  getBootstrapProof(recipeName: string): EagerSdkBootstrapProof | undefined {
    return this.eagerSdkBootstrapProofByRecipe.get(recipeName)
  }

  /**
   * Deletes the eager mcp-host pod (wedge recovery or image-drift roll) and
   * clears the per-recipe bootstrap failure budget. The failure map is also
   * identity-keyed, but explicit WRC rolls are a clear boundary where the prior
   * pod's broker state is no longer relevant.
   */
  private async rollEagerSdkMcpHostPod(recipeName: string): Promise<void> {
    await deletePodIfExists(
      this.deps.coreApi,
      `${recipeName}-mcp-host`,
      this.deps.config.sandboxNamespace
    )
    this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
    this.eagerSdkConfigureFailuresByRecipe.delete(recipeName)
  }

  /**
   * Plugin Workload SDK eager mcp-host lifecycle (Option A).
   *
   * Creates the recipe mcp-host before any run is triggered so the always-on
   * SDK server (:8099) is reachable, then — only when the recipe declares the
   * promptBridge family — publishes the public provider/model bootstrap binding
   * via a credential-free endpoint. Credentials stay behind the per-attempt
   * WRC broker; clientNotifications-only recipes need no provider bootstrap.
   *
   * Idempotent: safe to call on every reconcile. The mcp-host bootstrap is an
   * identity-only handshake, so re-delivering the same provider/model after a
   * pod restart simply re-arms the SDK LLM binding.
   */
  async ensureEagerSdkMcpHost(
    recipeName: string,
    recipeUid: string,
    namespace: string,
    runtimeScopeRecipeName: string,
    spec: WorkflowRecipeSpec,
    runtime: WorkflowRuntimePlan,
    opts: {
      mcpHostPhase: string | undefined
    }
  ): Promise<EagerSdkMcpHostStatus> {
    const log = createLogger('wrc', recipeName)
    const mcpHostAgent = resolveEagerSdkMcpHostAgent(spec)

    if (!mcpHostAgent && spec.pluginWorkloadSdk?.promptBridge) {
      log.warn(
        'Plugin Workload SDK promptBridge declared but no agent is resolvable; ' +
          'declare spec.agent with provider+model to bind the eager mcp-host'
      )
      return 'failed'
    }

    await this.deps.ensureMcpHostSecrets(namespace, recipeName, runtimeScopeRecipeName, spec)

    await this.deps.applyWorkflowNetworkPolicies(
      recipeName,
      recipeUid,
      spec,
      runtime,
      /* awaitsTriggeredRun */ true,
      /* eagerSdkMcpHost */ true
    )

    await this.deps.ensureMcpHostHeadlessService(recipeName)

    // Build the desired Pod once per reconcile so drift checks compare the
    // complete immutable runtime contract, not only the image string. This
    // catches same-image upgrades of the sdk-only env/dispatch contract.
    const desiredMcpHostPod = buildMcpHostPod(
      recipeName,
      mcpHostAgent,
      this.deps.config,
      runtimeScopeRecipeName,
      namespace,
      undefined,
      undefined,
      effectiveWorkflowContextRefForSpec(recipeName, spec),
      {
        mountWorkflowOutput: false,
        pluginWorkloadSdkEnabled: true,
        pluginWorkloadSdkRuntimeMode: 'sdk-only',
      }
    )
    const desiredRuntimeContractHash = pluginWorkloadSdkRuntimeContractHash(desiredMcpHostPod)

    let mcpHostPhase = opts.mcpHostPhase
    if (mcpHostPhase === 'Running' || mcpHostPhase === 'Pending') {
      const waitingReason = await getContainerWaitingReason(
        this.deps.coreApi,
        `${recipeName}-mcp-host`,
        this.deps.config.sandboxNamespace
      )
      if (isRecoverableContainerWaitingReason(mcpHostPhase, waitingReason)) {
        log.warn('Plugin Workload SDK eager mcp-host is wedged; recreating', {
          phase: mcpHostPhase,
          reason: waitingReason,
        })
        await this.rollEagerSdkMcpHostPod(recipeName)
        mcpHostPhase = undefined
      }
    }

    // Image-drift roll. The eager SDK mcp-host is a bare Pod (no Deployment),
    // so a platform mcp-host image bump never reaches a long-lived recipe on
    // its own: createIfNotExists is a no-op while the stale pod stays healthy,
    // and there is no owning controller to perform a rolling update. A recipe
    // deployed before an mcp-host release therefore keeps serving SDK routes
    // from the old image (e.g. a pre-recipients-endpoint pod returns 404 for
    // GET /sdk/v1/client-notifications/recipients). Roll the pod so the next
    // reconcile recreates it from config.mcpHostImage. Safe on this path: the
    // eager pod hosts only the always-on SDK server and produces no run
    // artifacts, and no triggered run is in flight (see ensureEagerSdkMcpHost).
    if (mcpHostPhase === 'Running' || mcpHostPhase === 'Pending') {
      const runningPod = await readMcpHostPodDriftStateIfExists(
        this.deps.coreApi,
        `${recipeName}-mcp-host`,
        this.deps.config.sandboxNamespace
      )
      if (runningPod?.deleting) {
        return 'deploying'
      }
      const imageDrift = runningPod?.image !== this.deps.config.mcpHostImage
      const runtimeContractDrift = runningPod?.runtimeContractHash !== desiredRuntimeContractHash
      if (runningPod && (imageDrift || runtimeContractDrift)) {
        log.info('Plugin Workload SDK eager mcp-host runtime contract drift; rolling Pod', {
          runningImage: runningPod.image,
          desiredImage: this.deps.config.mcpHostImage,
          observedRuntimeContractHash: runningPod.runtimeContractHash,
          desiredRuntimeContractHash,
        })
        await this.rollEagerSdkMcpHostPod(recipeName)
        // Requeue: the pod is recreated from the platform image on a later
        // reconcile once the prior pod has terminated. Returning here avoids
        // racing createIfNotExists against the still-terminating pod and
        // avoids bootstrapping a pod that is about to be replaced.
        return 'deploying'
      }
    }

    if (!mcpHostPhase || mcpHostPhase === 'Failed' || mcpHostPhase === 'Unknown') {
      await this.deps.createIfNotExists(
        () =>
          this.deps.coreApi.createNamespacedPod({
            namespace: this.deps.config.sandboxNamespace,
            body: desiredMcpHostPod,
          }),
        `Pod "${recipeName}-mcp-host"`
      )
    }

    const readiness = await this.readinessForEagerSdkMcpHost(recipeName)
    if (!spec.pluginWorkloadSdk?.promptBridge) {
      this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
      return readiness.status
    }
    if (!this.deps.modelConfigHandler) {
      this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
      return readiness.status
    }
    if (readiness.status !== 'ready') {
      this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
      return readiness.status
    }

    if (!readiness.uid) {
      log.warn(
        'Plugin Workload SDK eager mcp-host reported Ready without a pod UID; waiting for stable bootstrap identity'
      )
      return 'deploying'
    }

    if (!mcpHostAgent) return 'failed'
    const configureKey = `${readiness.uid}:${mcpHostAgent.provider}:${mcpHostAgent.model}`
    try {
      const wrcConfigureToken = await this.deps.tokenFactory.signWrcConfigureToken(
        recipeName,
        namespace
      )
      const mcpHostEndpoint = buildMcpHostUrl(recipeName, this.deps.config.sandboxNamespace)
      const result = await this.deps.modelConfigHandler.configurePluginWorkloadSdkBootstrap(
        mcpHostAgent.provider,
        mcpHostAgent.model,
        mcpHostEndpoint,
        wrcConfigureToken
      )
      if (result.status >= 400) {
        this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
        return this.recordEagerConfigureFailure(recipeName, configureKey, log, {
          reason: 'Plugin Workload SDK eager mcp-host bootstrap returned an error',
          detail: { status: result.status },
        })
      }
      const proof = parseEagerSdkBootstrapProof(result.body, readiness.uid)
      if (!proof) {
        this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
        return this.recordEagerConfigureFailure(recipeName, configureKey, log, {
          reason: 'Plugin Workload SDK bootstrap response omitted identity proof',
          detail: { status: result.status },
        })
      }
      this.eagerSdkBootstrapProofByRecipe.set(recipeName, proof)
      this.eagerSdkConfigureFailuresByRecipe.delete(recipeName)
      if (spec.pluginWorkloadSdk.promptBridge && proof.policyReady === false) {
        return 'awaiting_policy'
      }
    } catch (err) {
      this.eagerSdkBootstrapProofByRecipe.delete(recipeName)
      return this.recordEagerConfigureFailure(recipeName, configureKey, log, {
        reason: 'Plugin Workload SDK eager mcp-host bootstrap failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    return 'ready'
  }

  async readinessForEagerSdkMcpHost(
    recipeName: string
  ): Promise<{ status: EagerSdkMcpHostStatus; uid?: string; ready: boolean }> {
    const phase = await getPodPhase(
      this.deps.coreApi,
      `${recipeName}-mcp-host`,
      this.deps.config.sandboxNamespace
    )
    if (phase === 'Failed' || phase === 'Unknown') {
      return { status: 'failed', ready: false }
    }
    const readiness = await getPodReadiness(
      this.deps.coreApi,
      `${recipeName}-mcp-host`,
      this.deps.config.sandboxNamespace
    )
    if (readiness.ready) {
      return { status: 'ready', uid: readiness.uid, ready: true }
    }
    return { status: 'deploying', uid: readiness.uid, ready: false }
  }

  /**
   * Records a consecutive eager SDK bootstrap failure and decides the projected
   * status. Below MAX_EAGER_CONFIGURE_ATTEMPTS the recipe stays `deploying` so
   * the level-triggered reconcile keeps retrying (a transient mcp-host blip or
   * slow boot recovers on its own). Once the bound is reached, the failure is a
   * persistent broker problem (e.g. a bad secretRef) and is surfaced as
   * `provider_unavailable` so it is no longer indistinguishable from "still
   * booting". Mirrors the crash-recovery MAX_ATTEMPTS bound.
   */
  private recordEagerConfigureFailure(
    recipeName: string,
    configureKey: string,
    log: Logger,
    info: { reason: string; detail: Record<string, unknown> }
  ): EagerSdkMcpHostStatus {
    const current = this.eagerSdkConfigureFailuresByRecipe.get(recipeName)
    const attempts = current?.key === configureKey ? current.count + 1 : 1
    this.eagerSdkConfigureFailuresByRecipe.set(recipeName, { key: configureKey, count: attempts })

    if (attempts >= MAX_EAGER_CONFIGURE_ATTEMPTS) {
      log.warn(info.reason, {
        ...info.detail,
        configureKey,
        attempts,
        maxAttempts: MAX_EAGER_CONFIGURE_ATTEMPTS,
        status: 'provider_unavailable',
      })
      return 'provider_unavailable'
    }

    log.warn(info.reason, {
      ...info.detail,
      configureKey,
      attempts,
      maxAttempts: MAX_EAGER_CONFIGURE_ATTEMPTS,
    })
    // Not ready until the provider is brokered; stay pending so the
    // level-triggered reconcile retries the bootstrap.
    return 'deploying'
  }

  /**
   * Provisions the recipe-scoped Plugin Workload SDK token Secret (plan
   * §3.6). Each allowed caller workload gets its own key (`caller-<id>`) so
   * the SDK server can derive caller identity from the bearer token. Syncs
   * keys on every reconcile; delete the Secret to rotate all tokens.
   */
  async ensurePluginWorkloadSdkTokenSecret(
    recipeName: string,
    spec: WorkflowRecipeSpec
  ): Promise<void> {
    const secretName = buildPluginWorkloadSdkTokenSecretName(recipeName)
    const sandboxNamespace = this.deps.config.sandboxNamespace
    const allowedCallers = resolvePluginWorkloadSdkAllowedCallers(spec)
    if (allowedCallers.length === 0) {
      await this.deletePluginWorkloadSdkTokenSecret(recipeName)
      return
    }

    let existingSecret: k8s.V1Secret | undefined
    try {
      existingSecret = await this.deps.coreApi.readNamespacedSecret({
        name: secretName,
        namespace: sandboxNamespace,
      })
    } catch (err) {
      if (getErrorCode(err) !== 404) throw err
    }

    const existingDecoded: Record<string, string> = {}
    for (const [key, value] of Object.entries(existingSecret?.data ?? {})) {
      existingDecoded[key] = Buffer.from(value, 'base64').toString('utf8')
    }

    const tokensByCaller: Record<string, string> = {}
    const legacyToken = existingDecoded[PLUGIN_WORKLOAD_SDK_LEGACY_TOKEN_DATA_KEY]
    for (const callerRef of allowedCallers) {
      const key = pluginWorkloadSdkTokenSecretKey(callerRef)
      const existing = existingDecoded[key]
      if (existing) {
        tokensByCaller[callerRef] = existing
      } else if (legacyToken && allowedCallers.length === 1) {
        tokensByCaller[callerRef] = legacyToken
      } else {
        tokensByCaller[callerRef] = randomBytes(32).toString('base64url')
      }
    }

    const desired = buildPluginWorkloadSdkTokenSecret(recipeName, tokensByCaller, sandboxNamespace)

    if (!existingSecret) {
      try {
        await this.deps.coreApi.createNamespacedSecret({
          namespace: sandboxNamespace,
          body: desired,
        })
        this.deps.log.info(`Created Secret "${secretName}"`)
      } catch (err) {
        if (getErrorCode(err) !== 409) throw err
        this.deps.log.info(`Secret "${secretName}" already exists (skip create)`)
      }
      return
    }

    if (pluginWorkloadSdkSecretTokensMatch(existingDecoded, tokensByCaller)) {
      return
    }

    await this.deps.coreApi.replaceNamespacedSecret({
      name: secretName,
      namespace: sandboxNamespace,
      body: desired,
    })
    this.deps.log.info(`Synced Secret "${secretName}" (${allowedCallers.length} caller token(s))`)
  }

  /** Tears down the recipe-scoped SDK workload token Secret (recipe cleanup). */
  async deletePluginWorkloadSdkTokenSecret(recipeName: string): Promise<void> {
    await this.deps.safeDelete(() =>
      this.deps.coreApi.deleteNamespacedSecret({
        name: buildPluginWorkloadSdkTokenSecretName(recipeName),
        namespace: this.deps.config.sandboxNamespace,
      })
    )
  }
}

function parseEagerSdkBootstrapProof(
  body: Record<string, unknown>,
  podUid: string
): EagerSdkBootstrapProof | null {
  if (
    body.configured !== true ||
    body.ready !== true ||
    body.contractVersion !== 2 ||
    typeof body.provider !== 'string' ||
    typeof body.model !== 'string' ||
    body.provider.length === 0 ||
    body.model.length === 0
  ) {
    return null
  }
  const hasPolicyProof =
    Number.isSafeInteger(body.policyRevision) &&
    Number(body.policyRevision) >= 1 &&
    typeof body.policyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(body.policyHash) &&
    typeof body.defaultTargetRef === 'string' &&
    body.defaultTargetRef.length > 0 &&
    typeof body.defaultProvider === 'string' &&
    body.defaultProvider === body.provider &&
    typeof body.defaultModel === 'string' &&
    body.defaultModel === body.model
  return {
    ready: true,
    contractVersion: 2,
    podUid,
    provider: body.provider,
    model: body.model,
    policyReady: body.policyReady !== false && hasPolicyProof,
    policyState: typeof body.policyState === 'string' ? body.policyState : 'unknown',
    ...(typeof body.policyReason === 'string' ? { policyReason: body.policyReason } : {}),
    verifiedAt: new Date().toISOString(),
    ...(hasPolicyProof
      ? {
          policyRevision: Number(body.policyRevision),
          policyHash: body.policyHash as string,
          defaultTargetRef: body.defaultTargetRef as string,
          defaultProvider: body.defaultProvider as string,
          defaultModel: body.defaultModel as string,
        }
      : {}),
  }
}
