import { describe, expect, it } from 'vitest'
import { validateWorkflowRecipeLimits } from '../../../src/workflow/workflowLimits'

const DEFAULT_LIMITS = {
  workflowMaxWorkloadsPerRecipe: 25,
  workflowUiEgressInternalMaxItems: 25,
  workflowMaxSteps: 100,
  workflowStepDependsOnMaxItems: 100,
  workflowStepAllowedToolsMaxItems: 50,
  workflowStepMcpServersMaxItems: 20,
  workflowMaxRunDurationSeconds: 86_400,
  workflowStatefulSetMaxReplicas: 20,
  workflowStatefulSetMaxVolumeClaimTemplates: 4,
  workflowStatefulSetMaxPvcPreflightChecks: 80,
}

function steps(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, instruction: `Step ${i}` }))
}

describe('workflow runtime limit validation', () => {
  it('accepts default runtime boundaries', () => {
    const spec = {
      steps: [
        {
          id: 's0',
          instruction: 'Aggregate',
          dependsOn: Array.from({ length: 100 }, () => 's1'),
          mcpServers: Array.from({ length: 20 }, (_, i) => `srv${i}`),
          allowedTools: { include: Array.from({ length: 50 }, (_, i) => `srv0__tool${i}`) },
        },
        ...steps(99).map((step, i) => ({ ...step, id: `s${i + 1}` })),
      ],
    }

    expect(validateWorkflowRecipeLimits(spec, DEFAULT_LIMITS)).toBeUndefined()
  })

  it('rejects one item above each default runtime limit', () => {
    expect(validateWorkflowRecipeLimits({ steps: steps(101) }, DEFAULT_LIMITS)).toBe(
      'spec.steps must contain at most 100 items'
    )

    expect(
      validateWorkflowRecipeLimits(
        {
          workloads: Array.from({ length: 26 }, (_, index) => ({
            id: `service-${index}`,
            type: 'deployment',
            image: 'nginx:1.30.1-alpine',
          })),
        },
        DEFAULT_LIMITS
      )
    ).toBe('spec.workloads must contain at most 25 items')

    expect(
      validateWorkflowRecipeLimits(
        {
          ui: {
            workloadRef: 'web',
            port: 8080,
            egress: {
              internal: Array.from({ length: 26 }, (_, index) => ({
                workloadRef: `api-${index}`,
                port: 8000,
              })),
            },
          },
        },
        DEFAULT_LIMITS
      )
    ).toBe('spec.ui.egress.internal must contain at most 25 items')

    expect(
      validateWorkflowRecipeLimits(
        {
          steps: [
            {
              id: 's0',
              instruction: 'Run',
              dependsOn: Array.from({ length: 101 }, (_, i) => `dep${i}`),
            },
          ],
        },
        DEFAULT_LIMITS
      )
    ).toBe('spec.steps[0].dependsOn must contain at most 100 items')

    expect(
      validateWorkflowRecipeLimits(
        {
          steps: [
            {
              id: 's0',
              instruction: 'Run',
              mcpServers: Array.from({ length: 21 }, (_, i) => `srv${i}`),
            },
          ],
        },
        DEFAULT_LIMITS
      )
    ).toBe('spec.steps[0].mcpServers must contain at most 20 items')

    expect(
      validateWorkflowRecipeLimits(
        {
          steps: [
            {
              id: 's0',
              instruction: 'Run',
              allowedTools: { include: Array.from({ length: 51 }, (_, i) => `srv__tool${i}`) },
            },
          ],
        },
        DEFAULT_LIMITS
      )
    ).toBe('spec.steps[0].allowedTools.include must contain at most 50 items')
  })

  it('rejects run retention above the configured workflow max duration', () => {
    expect(
      validateWorkflowRecipeLimits(
        {
          steps: steps(1),
          runRetention: { maxRunDurationSeconds: 86_401 },
        },
        DEFAULT_LIMITS
      )
    ).toBe('spec.runRetention.maxRunDurationSeconds must be at most 86400')
  })

  it('rejects duplicate step ids before runtime resource creation', () => {
    expect(
      validateWorkflowRecipeLimits(
        {
          steps: [
            { id: 'research', instruction: 'Research' },
            { id: 'research', instruction: 'Duplicate' },
          ],
        },
        DEFAULT_LIMITS
      )
    ).toBe('duplicate step id "research" is not allowed')
  })

  it('uses configured lower runtime limits before runtime resource creation', () => {
    const lowerLimits = {
      workflowMaxSteps: 4,
      workflowMaxWorkloadsPerRecipe: 2,
      workflowUiEgressInternalMaxItems: 2,
      workflowStepDependsOnMaxItems: 2,
      workflowStepAllowedToolsMaxItems: 2,
      workflowStepMcpServersMaxItems: 2,
      workflowMaxRunDurationSeconds: 60,
      workflowStatefulSetMaxReplicas: 2,
      workflowStatefulSetMaxVolumeClaimTemplates: 2,
      workflowStatefulSetMaxPvcPreflightChecks: 4,
    }

    expect(validateWorkflowRecipeLimits({ steps: steps(5) }, lowerLimits)).toBe(
      'spec.steps must contain at most 4 items'
    )

    expect(
      validateWorkflowRecipeLimits(
        {
          workloads: [
            { id: 'api', type: 'deployment', image: 'api:v1' },
            { id: 'worker', type: 'deployment', image: 'worker:v1' },
            { id: 'cron', type: 'job', image: 'job:v1' },
          ],
        },
        lowerLimits
      )
    ).toBe('spec.workloads must contain at most 2 items')
    expect(
      validateWorkflowRecipeLimits(
        {
          ui: {
            workloadRef: 'web',
            port: 8080,
            egress: {
              internal: [
                { workloadRef: 'api', port: 8000 },
                { workloadRef: 'worker', port: 8000 },
                { workloadRef: 'cron', port: 8000 },
              ],
            },
          },
        },
        lowerLimits
      )
    ).toBe('spec.ui.egress.internal must contain at most 2 items')
    expect(
      validateWorkflowRecipeLimits(
        { steps: [{ id: 's0', instruction: 'Run', dependsOn: ['a', 'b', 'c'] }] },
        lowerLimits
      )
    ).toBe('spec.steps[0].dependsOn must contain at most 2 items')
    expect(
      validateWorkflowRecipeLimits(
        { steps: [{ id: 's0', instruction: 'Run', allowedTools: { include: ['a', 'b', 'c'] } }] },
        lowerLimits
      )
    ).toBe('spec.steps[0].allowedTools.include must contain at most 2 items')
  })
})
