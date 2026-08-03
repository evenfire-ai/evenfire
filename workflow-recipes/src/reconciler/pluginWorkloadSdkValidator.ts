import { isRunnableLlmModelId } from '@clerum/llm-providers'
import type {
  PluginWorkloadSdkCapabilityStatus,
  RecipePhase,
  StatusCondition,
  WorkflowRecipeSpec,
} from '../types'
import { hasResolvableAgent } from '../workflow/agentResolution'

/**
 * Validation + status projection for `spec.pluginWorkloadSdk`.
 *
 * Mirrors the webhookValidator pattern: pure functions with no Kubernetes
 * client dependencies. The reconciler's `validateSpec` throws on any
 * returned error (fail-closed), and `patchStatus` projects the validated
 * capability into `status.pluginWorkloadSdk` + a `PluginWorkloadSdkCapability`
 * condition so control-api can read it at runtime.
 */

export const DEFAULT_IDEMPOTENCY_KEY_PATTERN = '^[a-zA-Z0-9_-]{1,128}$'

/** Condition type owned by the Plugin Workload SDK reconcile pass. */
export const PLUGIN_WORKLOAD_SDK_CONDITION_TYPE = 'PluginWorkloadSdkCapability'
export const PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE =
  'PluginWorkloadSdkProviderUnavailable'
export const PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE = 'PluginWorkloadSdkPolicyPending'

/**
 * WorkflowRecipe remains the CRD that carries Plugin Workload SDK, but an SDK
 * workload is not a workflow. Keep the small set of workflow-only fields
 * closed when the recipe has no executable steps. CEL is the first line of
 * defence; this pure check preserves the same boundary for direct and
 * mixed-version inputs that bypass admission.
 */
export const SDK_ONLY_WORKFLOW_FIELDS = ['triggers', 'scheduling', 'coordinatorImage'] as const

function rejectWildcards(field: string, values: string[] | undefined, errors: string[]): void {
  for (const value of values ?? []) {
    if (value.includes('*')) {
      errors.push(`${field} entry "${value}" must not contain wildcards`)
    }
  }
}

function rejectInvalidModels(field: string, values: string[] | undefined, errors: string[]): void {
  for (const value of values ?? []) {
    if (!value.includes('*') && !isRunnableLlmModelId(value)) {
      errors.push(`${field} entry "${value}" has an invalid runnable model id`)
    }
  }
}

/**
 * Validate `spec.pluginWorkloadSdk` against the rules the CRD's OpenAPI/CEL
 * layer cannot fully express:
 *
 *   - at least one capability family must be declared
 *   - clientNotifications.allowedEventTypes must be non-empty
 *   - no wildcard `*` in allowedEventTypes, allowedModels, or allowedCallers
 *   - allowedCallers must reference existing workloads[].id entries
 *   - idempotencyKeyPattern must compile as a regex
 *
 * Returns a list of human-readable errors; empty when valid or when the
 * capability is not declared.
 */
export function validatePluginWorkloadSdkSpec(spec: WorkflowRecipeSpec): string[] {
  const sdk = spec.pluginWorkloadSdk
  if (!sdk) return []

  const errors: string[] = []

  const hasWorkflowSteps = (spec.steps?.length ?? 0) > 0
  if (!hasWorkflowSteps) {
    const configuredWorkflowFields = SDK_ONLY_WORKFLOW_FIELDS.filter(field => {
      switch (field) {
        case 'triggers':
          return spec.triggers !== undefined
        case 'scheduling':
          return spec.scheduling !== undefined
        case 'coordinatorImage':
          return spec.coordinatorImage !== undefined
      }
    })
    if (configuredWorkflowFields.length > 0) {
      errors.push(
        'pluginWorkloadSdk without workflow steps cannot define triggers, scheduling, or coordinatorImage'
      )
    }
  }

  if (!sdk.promptBridge && !sdk.clientNotifications) {
    errors.push(
      'pluginWorkloadSdk must declare at least one capability family (promptBridge or clientNotifications)'
    )
  }

  if (sdk.clientNotifications) {
    const eventTypes = sdk.clientNotifications.allowedEventTypes
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
      errors.push(
        'pluginWorkloadSdk.clientNotifications.allowedEventTypes must contain at least one event type'
      )
    } else {
      rejectWildcards('pluginWorkloadSdk.clientNotifications.allowedEventTypes', eventTypes, errors)
    }
    rejectWildcards(
      'pluginWorkloadSdk.clientNotifications.allowedTargetRefs',
      sdk.clientNotifications.allowedTargetRefs,
      errors
    )
  }

  rejectWildcards(
    'pluginWorkloadSdk.promptBridge.allowedModels',
    sdk.promptBridge?.allowedModels,
    errors
  )
  rejectInvalidModels(
    'pluginWorkloadSdk.promptBridge.allowedModels',
    sdk.promptBridge?.allowedModels,
    errors
  )

  if (spec.agent !== undefined) {
    if (!spec.agent.provider) {
      errors.push('spec.agent.provider is required when spec.agent is declared')
    }
    if (!isRunnableLlmModelId(spec.agent.model)) {
      errors.push('spec.agent.model must be a valid runnable model id when spec.agent is declared')
    }
  }

  // promptBridge issues real LLM calls, so the recipe must declare a resolvable
  // agent (provider + model). A stepless SDK recipe uses spec.agent as the
  // eager mcp-host bootstrap binding; a workflow may instead resolve a step
  // agent. clientNotifications needs no provider, so this rule is scoped to
  // promptBridge only.
  if (sdk.promptBridge && !hasResolvableAgent(spec)) {
    errors.push(
      'pluginWorkloadSdk.promptBridge requires spec.agent or a step agent with provider + model'
    )
  }

  rejectWildcards('pluginWorkloadSdk.allowedCallers', sdk.allowedCallers, errors)

  const workloadIds = new Set((spec.workloads ?? []).map(w => w.id))
  for (const caller of sdk.allowedCallers ?? []) {
    if (!workloadIds.has(caller)) {
      errors.push(
        `pluginWorkloadSdk.allowedCallers entry "${caller}" does not reference any spec.workloads[].id`
      )
    }
  }

  if (sdk.idempotencyKeyPattern !== undefined) {
    try {
      new RegExp(sdk.idempotencyKeyPattern)
    } catch {
      errors.push(
        `pluginWorkloadSdk.idempotencyKeyPattern "${sdk.idempotencyKeyPattern}" is not a valid regular expression`
      )
    }
  }

  return errors
}

export interface PluginWorkloadSdkStatusProjection {
  /**
   * Fresh owned conditions for the merge pass. `[]` clears stale owned
   * conditions (capability removed from spec); `undefined` is never
   * returned — the projection always decides.
   */
  conditions: StatusCondition[]
  /**
   * Value for `status.pluginWorkloadSdk`. `null` clears the field via
   * merge-patch; `undefined` leaves whatever is currently persisted.
   */
  capability: PluginWorkloadSdkCapabilityStatus | null | undefined
}

export interface PluginWorkloadSdkBootstrapProofInput {
  ready: true
  contractVersion: 2
  podUid: string
  provider: string
  model: string
  policyReady?: boolean
  policyState?: string
  policyReason?: string
  policyRevision?: number
  policyHash?: string
  defaultTargetRef?: string
  defaultProvider?: string
  defaultModel?: string
  verifiedAt: string
}

/**
 * Project `spec.pluginWorkloadSdk` + feature flag + reconcile outcome into
 * the status condition and capability record.
 *
 * - capability not declared → clear condition + clear status field
 * - feature flag off → condition False/FeatureFlagDisabled, state 'disabled'
 *   (the CRD field is still accepted — runtime enforcement is what's gated)
 * - reconcile failed → carry forward existing owned conditions untouched and
 *   leave the persisted capability as-is (a transient infra failure must not
 *   flip an already-validated capability)
 * - eager host identity is ready but the operator prompt policy is absent or
 *   unusable → condition False/PolicyNotConfigured, state 'awaiting_policy'
 * - reconcile succeeded with an active prompt policy → condition True/Validated,
 *   state 'validated'
 */
export function buildPluginWorkloadSdkStatus(args: {
  spec: WorkflowRecipeSpec
  existingConditions: StatusCondition[] | undefined
  phase: RecipePhase
  featureFlagEnabled: boolean
  providerUnavailable?: boolean
  policyPending?: boolean
  teardownConfirmed?: boolean
  bootstrapProof?: PluginWorkloadSdkBootstrapProofInput
  now: string
}): PluginWorkloadSdkStatusProjection {
  const {
    spec,
    existingConditions,
    phase,
    featureFlagEnabled,
    providerUnavailable,
    policyPending,
    teardownConfirmed,
    bootstrapProof,
    now,
  } = args
  const sdk = spec.pluginWorkloadSdk

  if (!sdk) {
    return { conditions: [], capability: null }
  }

  const promptBridge = sdk.promptBridge !== undefined
  const clientNotifications = sdk.clientNotifications !== undefined

  // A failed reconcile must never be projected as a successful disable. In
  // particular, the SDK kill-switch performs cleanup before this projection;
  // if cleanup failed, reporting `disabled` could leave an old host reachable
  // while claiming revocation completed.
  if (phase === 'failed' && !(teardownConfirmed === true && !featureFlagEnabled)) {
    const carried = (existingConditions ?? []).filter(
      c => c.type === PLUGIN_WORKLOAD_SDK_CONDITION_TYPE
    )
    return { conditions: carried, capability: undefined }
  }

  if (!featureFlagEnabled) {
    const message = 'Disabled (feature flag off)'
    return {
      conditions: [
        {
          type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
          status: 'False',
          reason: 'FeatureFlagDisabled',
          message,
          lastTransitionTime: now,
        },
      ],
      capability: {
        state: 'disabled',
        promptBridge,
        clientNotifications,
        message,
      },
    }
  }

  if (providerUnavailable) {
    const message = 'Capability validated, but the configured provider is unavailable'
    return {
      conditions: [
        {
          type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
          status: 'False',
          reason: 'ProviderUnavailable',
          message,
          lastTransitionTime: now,
        },
        {
          type: PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
          status: 'True',
          reason: 'ProviderUnavailable',
          message,
          lastTransitionTime: now,
        },
      ],
      capability: {
        state: 'degraded',
        promptBridge,
        clientNotifications,
        message,
      },
    }
  }

  if (promptBridge && policyPending) {
    const message =
      bootstrapProof?.policyReason === 'grant_missing'
        ? 'Plugin Workload SDK promptBridge is awaiting an operator grant'
        : `Plugin Workload SDK promptBridge policy is not ready (${bootstrapProof?.policyReason ?? bootstrapProof?.policyState ?? 'unknown'})`
    return {
      conditions: [
        {
          type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
          status: 'False',
          reason: 'PolicyNotConfigured',
          message,
          lastTransitionTime: now,
        },
        {
          type: PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
          status: 'True',
          reason: bootstrapProof?.policyReason ?? 'PolicyNotReady',
          message,
          lastTransitionTime: now,
        },
      ],
      capability: {
        state: 'awaiting_policy',
        promptBridge,
        clientNotifications,
        message,
        ...(bootstrapProof
          ? {
              bootstrapContractVersion: bootstrapProof.contractVersion,
              bootstrapPodUid: bootstrapProof.podUid,
              bootstrapProvider: bootstrapProof.provider,
              bootstrapModel: bootstrapProof.model,
              verifiedAt: bootstrapProof.verifiedAt,
            }
          : {}),
      },
    }
  }

  if (promptBridge && !bootstrapProof?.ready) {
    const message = 'promptBridge bootstrap policy proof is not ready'
    return {
      conditions: [
        {
          type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
          status: 'False',
          reason: 'BootstrapNotReady',
          message,
          lastTransitionTime: now,
        },
      ],
      capability: {
        state: 'degraded',
        promptBridge,
        clientNotifications,
        message,
      },
    }
  }

  const families = [
    promptBridge ? 'promptBridge' : undefined,
    clientNotifications ? 'clientNotifications' : undefined,
  ]
    .filter((f): f is string => f !== undefined)
    .join(', ')

  return {
    conditions: [
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'True',
        reason: 'Validated',
        message: `Capability validated (${families})`,
        lastTransitionTime: now,
      },
    ],
    capability: {
      state: 'validated',
      promptBridge,
      clientNotifications,
      validatedAt: now,
      ...(bootstrapProof
        ? {
            bootstrapContractVersion: bootstrapProof.contractVersion,
            bootstrapPodUid: bootstrapProof.podUid,
            bootstrapProvider: bootstrapProof.provider,
            bootstrapModel: bootstrapProof.model,
            verifiedAt: bootstrapProof.verifiedAt,
            ...(bootstrapProof.policyRevision !== undefined
              ? { policyRevision: bootstrapProof.policyRevision }
              : {}),
            ...(bootstrapProof.policyHash !== undefined
              ? { policyHash: bootstrapProof.policyHash }
              : {}),
            ...(bootstrapProof.defaultTargetRef !== undefined
              ? { defaultTargetRef: bootstrapProof.defaultTargetRef }
              : {}),
          }
        : {}),
    },
  }
}
