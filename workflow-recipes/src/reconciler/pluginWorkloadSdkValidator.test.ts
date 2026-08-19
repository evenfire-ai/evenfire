import { describe, expect, it } from 'vitest'
import type { PluginWorkloadSdkSpec, WorkflowRecipeSpec } from '../types'
import {
  PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
  PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
  buildPluginWorkloadSdkStatus,
  validatePluginWorkloadSdkSpec,
} from './pluginWorkloadSdkValidator'

const baseSpec = (
  pluginWorkloadSdk?: PluginWorkloadSdkSpec,
  overrides: Partial<WorkflowRecipeSpec> = {}
): WorkflowRecipeSpec => ({
  // promptBridge requires a resolvable agent (provider + model); declare one by
  // default so the validator's promptBridge-needs-agent rule is satisfied.
  agent: { provider: 'zai', model: 'glm-4.7' },
  workloads: [
    { id: 'api', type: 'deployment', image: 'api:1' },
    { id: 'worker', type: 'deployment', image: 'worker:1' },
  ],
  pluginWorkloadSdk,
  ...overrides,
})

const NOW = '2026-06-09T00:00:00.000Z'

describe('validatePluginWorkloadSdkSpec', () => {
  it('returns no errors when the capability is not declared', () => {
    expect(validatePluginWorkloadSdkSpec(baseSpec(undefined))).toEqual([])
  })

  it('accepts a valid minimal config (promptBridge only)', () => {
    const errors = validatePluginWorkloadSdkSpec(baseSpec({ promptBridge: {} }))
    expect(errors).toEqual([])
  })

  it('accepts a valid full config', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({
        promptBridge: {
          allowedModels: ['gpt-4o-mini', 'glm-4.7'],
          maxOutputTokens: 2048,
          maxRequestsPerRun: 10,
          maxRequestContentBytes: 131072,
          maxConcurrentInvocations: 5,
          maxInvocationsPerMinute: 60,
          resultRetentionHours: 24,
          maxAttachments: 0,
          maxAttachmentBytes: 0,
        },
        clientNotifications: {
          allowedEventTypes: ['lead.followup.due', 'support.summary.ready'],
          allowedTargetRefs: ['team.sales'],
          allowedUserRefs: true,
          maxNotificationsPerRun: 20,
          maxNotificationsPerMinute: 120,
          maxTitleBytes: 256,
          maxBodyBytes: 4096,
          resultRetentionHours: 72,
        },
        allowedCallers: ['api', 'worker'],
        idempotencyKeyPattern: '^[a-zA-Z0-9_-]{1,128}$',
      })
    )
    expect(errors).toEqual([])
  })

  it('rejects a declaration with no capability family', () => {
    const errors = validatePluginWorkloadSdkSpec(baseSpec({}))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('at least one capability family')
  })

  it('rejects empty clientNotifications.allowedEventTypes', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ clientNotifications: { allowedEventTypes: [] } })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('allowedEventTypes must contain at least one event type')
  })

  it('rejects allowedCallers that do not reference declared workloads', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: {}, allowedCallers: ['api', 'ghost'] })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"ghost" does not reference any spec.workloads[].id')
  })

  it('rejects every allowedCallers entry on a workflow-only recipe (no workloads)', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: {}, allowedCallers: ['api'] }, { workloads: undefined })
    )
    expect(errors).toHaveLength(2)
    expect(errors).toContain(
      'pluginWorkloadSdk SDK-only recipes require at least one spec.workloads entry'
    )
    expect(
      errors.some(error => error.includes('"api" does not reference any spec.workloads[].id'))
    ).toBe(true)
  })

  it('rejects SDK-only recipes with an explicitly empty workloads list', () => {
    const errors = validatePluginWorkloadSdkSpec(baseSpec({ promptBridge: {} }, { workloads: [] }))
    expect(errors).toEqual([
      'pluginWorkloadSdk SDK-only recipes require at least one spec.workloads entry',
    ])
  })

  it('rejects wildcard entries in allowedEventTypes', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ clientNotifications: { allowedEventTypes: ['lead.*'] } })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('must not contain wildcards')
  })

  it('rejects wildcard entries in allowedModels', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: { allowedModels: ['*'] } })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('must not contain wildcards')
  })

  it('rejects model ids outside the shared runnable grammar', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: { allowedModels: ['model with spaces'] } })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('invalid runnable model id')
  })

  it('rejects wildcard entries in clientNotifications.allowedTargetRefs', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({
        clientNotifications: {
          allowedEventTypes: ['lead.followup.due'],
          allowedTargetRefs: ['team.*'],
        },
      })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('allowedTargetRefs')
    expect(errors[0]).toContain('must not contain wildcards')
  })

  it('rejects wildcard entries in allowedCallers', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec(
        { promptBridge: {}, allowedCallers: ['api*'] },
        {
          workloads: [
            { id: 'api*', type: 'deployment', image: 'api:1' },
            { id: 'worker', type: 'deployment', image: 'worker:1' },
          ],
        }
      )
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('allowedCallers')
    expect(errors[0]).toContain('must not contain wildcards')
  })

  it('rejects an invalid idempotencyKeyPattern regex', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: {}, idempotencyKeyPattern: '[unclosed' })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('is not a valid regular expression')
  })

  it('rejects promptBridge without a resolvable agent', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: {} }, { agent: undefined })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(
      'promptBridge requires spec.agent or a step agent with provider + model'
    )
  })

  it('rejects promptBridge when the resolved agent model is outside the runnable grammar', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: {} }, { agent: { provider: 'openai', model: 'model with spaces' } })
    )
    expect(errors).toHaveLength(2)
    expect(errors).toContain(
      'spec.agent.model must be a valid runnable model id when spec.agent is declared'
    )
    expect(errors).toContain(
      'pluginWorkloadSdk.promptBridge requires spec.agent or a step agent with provider + model'
    )
  })

  it('accepts promptBridge when only a step agent provides provider + model', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec(
        { promptBridge: {} },
        {
          agent: undefined,
          steps: [{ id: 's1', instruction: 'go', agent: { provider: 'zai', model: 'glm-4.7' } }],
        }
      )
    )
    expect(errors).toEqual([])
  })

  it.each([
    ['triggers', { triggers: { onDemand: {} } }],
    ['scheduling', { scheduling: { cron: '0 * * * *' } }],
    [
      'coordinatorImage',
      {
        coordinatorImage:
          'example.com/coordinator@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
  ] as const)('rejects SDK-only %s before resource construction', (_field, override) => {
    const errors = validatePluginWorkloadSdkSpec(baseSpec({ promptBridge: {} }, { ...override }))
    expect(errors).toContain(
      'pluginWorkloadSdk without workflow steps cannot define triggers, scheduling, or coordinatorImage'
    )
  })

  it('rejects SDK-only workflow fields when steps is the empty-array compatibility input', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ promptBridge: {} }, { steps: [], triggers: { onDemand: {} } })
    )
    expect(errors).toContain(
      'pluginWorkloadSdk without workflow steps cannot define triggers, scheduling, or coordinatorImage'
    )
  })

  it('accepts clientNotifications-only without any agent', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({ clientNotifications: { allowedEventTypes: ['e2e.test'] } }, { agent: undefined })
    )
    expect(errors).toEqual([])
  })

  it('accumulates multiple independent errors', () => {
    const errors = validatePluginWorkloadSdkSpec(
      baseSpec({
        clientNotifications: { allowedEventTypes: [] },
        allowedCallers: ['ghost'],
        idempotencyKeyPattern: '[unclosed',
      })
    )
    expect(errors).toHaveLength(3)
  })
})

describe('buildPluginWorkloadSdkStatus', () => {
  it('clears condition and capability when the spec does not declare the SDK', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec(undefined),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      now: NOW,
    })
    expect(projection.conditions).toEqual([])
    expect(projection.capability).toBeNull()
  })

  it('annotates Disabled (feature flag off) when the flag is off', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: false,
      now: NOW,
    })
    expect(projection.conditions).toEqual([
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'False',
        reason: 'FeatureFlagDisabled',
        message: 'Disabled (feature flag off)',
        lastTransitionTime: NOW,
      },
    ])
    expect(projection.capability).toEqual({
      state: 'disabled',
      promptBridge: true,
      clientNotifications: false,
      message: 'Disabled (feature flag off)',
      validatedAt: null,
      bootstrapContractVersion: null,
      bootstrapPodUid: null,
      bootstrapProvider: null,
      bootstrapModel: null,
      policyRevision: null,
      policyHash: null,
      defaultTargetRef: null,
      verifiedAt: null,
    })
  })

  it('marks the capability validated when the flag is on and reconcile succeeded', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({
        promptBridge: {},
        clientNotifications: { allowedEventTypes: ['a.b'] },
      }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'pod-uid-1',
        provider: 'zai',
        model: 'glm-4.7',
        policyRevision: 1,
        policyHash: 'a'.repeat(64),
        defaultTargetRef: 'primary-zai',
        defaultProvider: 'zai',
        defaultModel: 'glm-4.7',
        clientNotificationsPolicyReady: true,
        clientNotificationsPolicyState: 'active',
        verifiedAt: NOW,
      },
      now: NOW,
    })
    expect(projection.conditions).toEqual([
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'True',
        reason: 'Validated',
        message: 'Capability validated (promptBridge, clientNotifications)',
        lastTransitionTime: NOW,
      },
    ])
    expect(projection.capability).toEqual({
      bootstrapContractVersion: 2,
      bootstrapModel: 'glm-4.7',
      bootstrapPodUid: 'pod-uid-1',
      bootstrapProvider: 'zai',
      clientNotifications: true,
      defaultTargetRef: 'primary-zai',
      policyHash: 'a'.repeat(64),
      policyRevision: 1,
      state: 'validated',
      promptBridge: true,
      message: 'Capability validated (promptBridge, clientNotifications)',
      validatedAt: NOW,
      verifiedAt: NOW,
    })
  })

  it('preserves the original validatedAt across a steady-state throttle refresh (issue #375 R1)', () => {
    // The verifiedAt throttle rewrites the whole SDK projection every ~5 min in
    // steady state. validatedAt is the stable "first reached validated" marker
    // (operators/dashboards read it), so a still-validated recipe must NOT have
    // it reset to now on each throttle patch — only verifiedAt advances.
    const EARLIER = '2026-08-17T10:00:00.000Z'
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'pod-uid-1',
        provider: 'zai',
        model: 'glm-4.7',
        policyRevision: 1,
        defaultTargetRef: 'primary-zai',
        verifiedAt: NOW,
      },
      now: NOW,
      // Already validated on a prior pass, with the stable marker set EARLIER.
      existingCapability: {
        state: 'validated',
        promptBridge: true,
        clientNotifications: false,
        validatedAt: EARLIER,
        verifiedAt: EARLIER,
      },
    })
    expect(projection.capability?.state).toBe('validated')
    // validatedAt is carried forward (stable), verifiedAt advances to now.
    expect(projection.capability?.validatedAt).toBe(EARLIER)
    expect(projection.capability?.verifiedAt).toBe(NOW)
  })

  it('stamps a fresh validatedAt on a genuine transition INTO validated (issue #375 R1)', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'pod-uid-1',
        provider: 'zai',
        model: 'glm-4.7',
        policyRevision: 1,
        defaultTargetRef: 'primary-zai',
        verifiedAt: NOW,
      },
      now: NOW,
      // Prior state was awaiting_policy — this is the real transition.
      existingCapability: {
        state: 'awaiting_policy',
        promptBridge: true,
        clientNotifications: false,
        validatedAt: null,
        verifiedAt: '2026-08-17T10:00:00.000Z',
      },
    })
    expect(projection.capability?.state).toBe('validated')
    expect(projection.capability?.validatedAt).toBe(NOW)
  })

  it('keeps a mixed recipe pending until every declared family has an active proof', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({
        promptBridge: {},
        clientNotifications: { allowedEventTypes: ['a.b'] },
      }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'pod-uid-1',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        policyReady: true,
        policyState: 'active',
        clientNotificationsPolicyReady: false,
        clientNotificationsPolicyState: 'missing',
        clientNotificationsPolicyReason: 'grant_missing',
        verifiedAt: NOW,
      },
      now: NOW,
    })

    expect(projection.conditions[0]).toMatchObject({
      type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
      status: 'False',
      reason: 'PolicyNotConfigured',
      message: 'Plugin Workload SDK clientNotifications is awaiting an operator grant',
    })
    expect(projection.capability).toMatchObject({
      state: 'awaiting_policy',
      promptBridge: true,
      clientNotifications: true,
      validatedAt: null,
    })
  })

  it('projects provider_unavailable separately from a validated capability declaration', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'degraded',
      featureFlagEnabled: true,
      providerUnavailable: true,
      now: NOW,
    })
    expect(projection.conditions).toEqual([
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'False',
        reason: 'ProviderUnavailable',
        message: 'Capability validated, but the configured provider is unavailable',
        lastTransitionTime: NOW,
      },
      {
        type: PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
        status: 'True',
        reason: 'ProviderUnavailable',
        message: 'Capability validated, but the configured provider is unavailable',
        lastTransitionTime: NOW,
      },
    ])
    expect(projection.capability).toEqual({
      state: 'degraded',
      promptBridge: true,
      clientNotifications: false,
      message: 'Capability validated, but the configured provider is unavailable',
      validatedAt: null,
      bootstrapContractVersion: null,
      bootstrapPodUid: null,
      bootstrapProvider: null,
      bootstrapModel: null,
      policyRevision: null,
      policyHash: null,
      defaultTargetRef: null,
      verifiedAt: null,
    })
  })

  it('projects a missing operator grant as awaiting_policy, not provider_unavailable', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      policyPending: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'pod-uid-1',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        policyReady: false,
        policyState: 'missing',
        policyReason: 'grant_missing',
        verifiedAt: NOW,
      },
      now: NOW,
    })
    expect(projection.conditions).toEqual([
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'False',
        reason: 'PolicyNotConfigured',
        message: 'Plugin Workload SDK promptBridge is awaiting an operator grant',
        lastTransitionTime: NOW,
      },
      {
        type: PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
        status: 'True',
        reason: 'grant_missing',
        message: 'Plugin Workload SDK promptBridge is awaiting an operator grant',
        lastTransitionTime: NOW,
      },
    ])
    expect(projection.capability).toMatchObject({
      state: 'awaiting_policy',
      promptBridge: true,
      clientNotifications: false,
      validatedAt: null,
      policyRevision: null,
      policyHash: null,
      defaultTargetRef: null,
    })
  })

  it('does not validate a clientNotifications-only recipe before its grant is proven', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec(
        { clientNotifications: { allowedEventTypes: ['e2e.test'] } },
        { agent: undefined }
      ),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'pod-uid-1',
        clientNotificationsPolicyReady: false,
        clientNotificationsPolicyState: 'missing',
        clientNotificationsPolicyReason: 'grant_missing',
        verifiedAt: NOW,
      },
      now: NOW,
    })

    expect(projection.conditions).toEqual([
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'False',
        reason: 'PolicyNotConfigured',
        message: 'Plugin Workload SDK clientNotifications is awaiting an operator grant',
        lastTransitionTime: NOW,
      },
      {
        type: PLUGIN_WORKLOAD_SDK_POLICY_PENDING_CONDITION_TYPE,
        status: 'True',
        reason: 'grant_missing',
        message: 'Plugin Workload SDK clientNotifications is awaiting an operator grant',
        lastTransitionTime: NOW,
      },
    ])
    expect(projection.capability).toMatchObject({
      state: 'awaiting_policy',
      promptBridge: false,
      clientNotifications: true,
      validatedAt: null,
    })
  })

  it('keeps clientNotifications-only recipes degraded while the SDK host is not ready', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec(
        { clientNotifications: { allowedEventTypes: ['e2e.test'] } },
        { agent: undefined }
      ),
      existingConditions: undefined,
      phase: 'deploying',
      featureFlagEnabled: true,
      now: NOW,
    })

    expect(projection.conditions).toEqual([
      {
        type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
        status: 'False',
        reason: 'BootstrapNotReady',
        message: 'Plugin Workload SDK host readiness proof is not ready',
        lastTransitionTime: NOW,
      },
    ])
    expect(projection.capability).toMatchObject({
      state: 'degraded',
      promptBridge: false,
      clientNotifications: true,
      validatedAt: null,
    })
  })

  it('clears validated metadata when the capability degrades after a prior validation', () => {
    const validated = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'active',
      featureFlagEnabled: true,
      bootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'old-pod',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        policyRevision: 7,
        policyHash: 'b'.repeat(64),
        defaultTargetRef: 'primary-openai',
        verifiedAt: NOW,
      },
      now: NOW,
    })
    expect(validated.capability).toMatchObject({
      state: 'validated',
      policyRevision: 7,
      policyHash: 'b'.repeat(64),
      defaultTargetRef: 'primary-openai',
    })

    const degraded = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'degraded',
      featureFlagEnabled: true,
      providerUnavailable: true,
      now: NOW,
    })
    expect(degraded.capability).toMatchObject({
      state: 'degraded',
      validatedAt: null,
      bootstrapContractVersion: null,
      bootstrapPodUid: null,
      bootstrapProvider: null,
      bootstrapModel: null,
      policyRevision: null,
      policyHash: null,
      defaultTargetRef: null,
      verifiedAt: null,
    })
  })

  it('carries forward existing owned conditions when reconcile failed', () => {
    const existing = {
      type: PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
      status: 'True' as const,
      reason: 'Validated',
      message: 'Capability validated (promptBridge)',
      lastTransitionTime: '2026-06-08T00:00:00.000Z',
    }
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: [existing, { type: 'Other', status: 'True', lastTransitionTime: NOW }],
      phase: 'failed',
      featureFlagEnabled: true,
      now: NOW,
    })
    expect(projection.conditions).toEqual([existing])
    expect(projection.capability).toBeUndefined()
  })

  it('does not project disabled when flag-off teardown failed', () => {
    const projection = buildPluginWorkloadSdkStatus({
      spec: baseSpec({ promptBridge: {} }),
      existingConditions: undefined,
      phase: 'failed',
      featureFlagEnabled: false,
      now: NOW,
    })
    expect(projection.capability).toBeUndefined()
    expect(projection.conditions).toEqual([])
  })
})
