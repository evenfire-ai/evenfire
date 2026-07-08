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

function rejectWildcards(field: string, values: string[] | undefined, errors: string[]): void {
  for (const value of values ?? []) {
    if (value.includes('*')) {
      errors.push(`${field} entry "${value}" must not contain wildcards`)
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

  // promptBridge issues real LLM calls, so the recipe must declare a resolvable
  // agent (provider + model) — either spec.agent or a step agent. The WRC uses
  // it to broker the provider API key into the eager mcp-host. clientNotifications
  // needs no provider, so this rule is scoped to promptBridge only.
  if (sdk.promptBridge && !hasResolvableAgent(spec)) {
    errors.push(
      'pluginWorkloadSdk.promptBridge requires a resolvable agent (spec.agent or a step agent with provider + model)'
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
 * - reconcile succeeded → condition True/Validated, state 'validated'
 */
export function buildPluginWorkloadSdkStatus(args: {
  spec: WorkflowRecipeSpec
  existingConditions: StatusCondition[] | undefined
  phase: RecipePhase
  featureFlagEnabled: boolean
  now: string
}): PluginWorkloadSdkStatusProjection {
  const { spec, existingConditions, phase, featureFlagEnabled, now } = args
  const sdk = spec.pluginWorkloadSdk

  if (!sdk) {
    return { conditions: [], capability: null }
  }

  const promptBridge = sdk.promptBridge !== undefined
  const clientNotifications = sdk.clientNotifications !== undefined

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

  if (phase === 'failed') {
    const carried = (existingConditions ?? []).filter(
      c => c.type === PLUGIN_WORKLOAD_SDK_CONDITION_TYPE
    )
    return { conditions: carried, capability: undefined }
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
    },
  }
}
