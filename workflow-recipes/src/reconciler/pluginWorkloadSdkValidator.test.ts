import { describe, expect, it } from 'vitest'
import type { PluginWorkloadSdkSpec, WorkflowRecipeSpec } from '../types'
import {
  PLUGIN_WORKLOAD_SDK_CONDITION_TYPE,
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
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"api" does not reference any spec.workloads[].id')
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
    expect(errors[0]).toContain('promptBridge requires a resolvable agent')
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
      state: 'validated',
      promptBridge: true,
      clientNotifications: true,
      validatedAt: NOW,
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
})
