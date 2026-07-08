import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeResource, WorkflowRunSummary } from '../api'
import {
  getRecipeDisplayPhase,
  getRecipeResourceDisplayStatus,
  getRecipeRunDisabledReason,
  getVisibleWorkflowRuns,
  isRecipeReadyToRun,
  shouldPollWorkflowRecipe,
  workflowOnDemandRequiresApproval,
} from '../workflowRecipeRunState'

function recipe(overrides: Partial<WorkflowRecipeResource> = {}): WorkflowRecipeResource {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'test-recipe',
      namespace: 'sandbox-recipes',
      creationTimestamp: '2026-05-07T23:10:46.000Z',
    },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [{ id: 's1', instruction: 'do work' }],
    },
    ...overrides,
  }
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: '12653f34-1adf-404b-88db-44e14b6cc725',
    source: 'live',
    phase: 'Failed',
    triggeredAt: '2026-05-07T23:11:00.000Z',
    startedAt: '2026-05-07T23:11:01.000Z',
    completedAt: '2026-05-07T23:12:00.000Z',
    message: null,
    actor: null,
    executionRef: {
      namespace: 'sandbox-recipes',
      name: 'test-recipe-12653f34',
    },
    ...overrides,
  }
}

function legacyRun(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: '12653f34-1adf-404b-88db-44e14b6cc725',
    source: 'live',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'test-recipe',
    phase: 'Failed',
    triggerSource: 'onDemand',
    triggeredAt: '2026-05-07T23:11:00.000Z',
    startedAt: '2026-05-07T23:11:01.000Z',
    completedAt: '2026-05-07T23:12:00.000Z',
    finalPhase: 'Failed',
    message: null,
    errorMessage: null,
    actor: null,
    executionRef: {
      namespace: 'sandbox-recipes',
      name: 'test-recipe-12653f34',
    },
    triggerer: null,
    ...overrides,
  }
}

describe('workflowRecipeRunState', () => {
  it('allows Run when the recipe has executable spec and active status', () => {
    const r = recipe()

    expect(isRecipeReadyToRun(r, { phase: 'active' })).toBe(true)
    expect(getRecipeRunDisabledReason(r, { phase: 'active' })).toBe('')
  })

  it('blocks transport workflow runs until workload instances are registered', () => {
    const r = recipe({
      spec: {
        triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
        steps: [{ id: 's1', instruction: 'search' }],
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'ghcr.io/aas-ee/open-web-search:latest',
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })

    expect(isRecipeReadyToRun(r, { phase: 'active' })).toBe(false)
    expect(getRecipeRunDisabledReason(r, { phase: 'active' })).toBe(
      'Workflow runtime is preparing transport workload: web-search.'
    )
  })

  it('allows retry after a failed workflow execution when transport workload instances exist', () => {
    const r = recipe({
      spec: {
        triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
        steps: [{ id: 's1', instruction: 'search' }],
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'ghcr.io/aas-ee/open-web-search:latest',
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })

    expect(
      getRecipeRunDisabledReason(r, {
        phase: 'failed',
        workloadInstances: { 'web-search': 'test-recipe-web-search-a1b2c3d4' },
        workflowExecution: { phase: 'failed' },
      })
    ).toBe('')
  })

  it('reads approval-gated on-demand recipes for operator-run copy without blocking readiness', () => {
    const r = recipe({
      spec: {
        triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
        steps: [{ id: 's1', instruction: 'do work' }],
      },
    })

    expect(workflowOnDemandRequiresApproval(r)).toBe(true)
    expect(isRecipeReadyToRun(r, { phase: 'active' })).toBe(true)
    expect(getRecipeRunDisabledReason(r, { phase: 'active' })).toBe('')
  })

  it('blocks Run while the recipe is still deploying', () => {
    const r = recipe()

    expect(isRecipeReadyToRun(r, { phase: 'deploying' })).toBe(false)
    expect(getRecipeRunDisabledReason(r, { phase: 'deploying' })).toBe(
      'Recipe is deploying; wait until it is active.'
    )
  })

  it('allows Run during a live execution phase after the recipe was already deployed', () => {
    const r = recipe()
    const status = {
      phase: 'active' as const,
      workflowExecution: {
        phase: 'initializing' as const,
        startedAt: '2026-05-07T23:30:00.000Z',
      },
    }

    expect(isRecipeReadyToRun(r, status)).toBe(true)
    expect(getRecipeRunDisabledReason(r, status)).toBe('')
    expect(getRecipeDisplayPhase(r, status)).toBe('running')
  })

  it('falls back to the resource status when live status has not loaded', () => {
    const r = recipe({ status: { phase: 'active' } })

    expect(isRecipeReadyToRun(r, null)).toBe(true)
  })

  it('keeps Run disabled while status is loading', () => {
    const r = recipe()

    expect(isRecipeReadyToRun(r, null)).toBe(false)
    expect(getRecipeRunDisabledReason(r, null)).toBe('Recipe status is still loading.')
  })

  it('allows Run while an active recipe has a running workflow execution', () => {
    const r = recipe()

    expect(
      isRecipeReadyToRun(r, {
        phase: 'active',
        workflowExecution: { phase: 'running' },
      })
    ).toBe(true)
    expect(
      getRecipeRunDisabledReason(r, {
        phase: 'active',
        workflowExecution: { phase: 'running', startedAt: '2026-05-07T23:30:00.000Z' },
      })
    ).toBe('')
  })

  it('keeps parent recipe display status bound to the resource phase and message', () => {
    const r = recipe({
      status: {
        phase: 'active',
        message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      },
    })

    expect(
      getRecipeResourceDisplayStatus(r, {
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: {
          phase: 'running',
          message: 'Workflow running',
        },
      })
    ).toEqual({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
    })
  })

  it('falls back to status when parent recipe status is unavailable', () => {
    expect(getRecipeResourceDisplayStatus(null, { phase: 'active', message: 'Ready' })).toEqual({
      phase: 'active',
      message: 'Ready',
    })
  })

  it('labels the initial deployment execution as deploying without blocking Run', () => {
    const r = recipe()
    const status = {
      phase: 'active' as const,
      workflowExecution: {
        phase: 'running' as const,
        startedAt: '2026-05-07T23:10:51.000Z',
      },
    }

    expect(getRecipeDisplayPhase(r, status)).toBe('deploying')
    expect(getRecipeRunDisabledReason(r, status)).toBe('')
  })

  it('labels a later active workflow execution as running', () => {
    const r = recipe()

    expect(
      getRecipeDisplayPhase(r, {
        phase: 'active',
        workflowExecution: {
          phase: 'running',
          startedAt: '2026-05-07T23:30:00.000Z',
        },
      })
    ).toBe('running')
  })

  it('does not label a manual run shortly after install as deploying', () => {
    const r = recipe()
    const status = {
      phase: 'active' as const,
      workflowExecution: {
        phase: 'running' as const,
        startedAt: '2026-05-07T23:12:46.000Z',
      },
    }

    expect(getRecipeDisplayPhase(r, status)).toBe('running')
    expect(getRecipeRunDisabledReason(r, status)).toBe('')
  })

  it('uses the current Control API run row to avoid treating a run as initial deploy', () => {
    const r = recipe()
    const status = {
      phase: 'active' as const,
      workflowExecution: {
        phase: 'running' as const,
        startedAt: '2026-05-07T23:10:51.000Z',
      },
    }
    const runs = [
      run({
        id: 'current-child-run',
        phase: 'Running',
        triggeredAt: '2026-05-07T23:10:50.000Z',
        startedAt: '2026-05-07T23:10:51.000Z',
        completedAt: null,
      }),
    ]

    expect(getRecipeDisplayPhase(r, status, runs)).toBe('running')
    expect(getRecipeRunDisabledReason(r, status, runs)).toBe('')
  })

  it('allows Run after the latest workflow execution completed', () => {
    const r = recipe()

    expect(
      isRecipeReadyToRun(r, {
        phase: 'active',
        workflowExecution: { phase: 'completed' },
      })
    ).toBe(true)
  })

  it('allows Run after a workflow execution failed but displays failed', () => {
    const r = recipe()
    const status = {
      phase: 'active' as const,
      workflowExecution: {
        phase: 'failed' as const,
        startedAt: '2026-05-07T23:10:51.000Z',
        completedAt: '2026-05-07T23:12:00.000Z',
      },
    }

    expect(isRecipeReadyToRun(r, status)).toBe(true)
    expect(getRecipeDisplayPhase(r, status)).toBe('failed')
  })

  it('allows admin Run when the recipe status itself is failed', () => {
    const r = recipe()
    const status = {
      phase: 'failed' as const,
      workflowExecution: {
        phase: 'failed' as const,
        startedAt: '2026-05-07T23:10:51.000Z',
        completedAt: '2026-05-07T23:12:00.000Z',
      },
    }

    expect(isRecipeReadyToRun(r, status)).toBe(true)
    expect(getRecipeRunDisabledReason(r, status)).toBe('')
    expect(getRecipeDisplayPhase(r, status)).toBe('failed')
  })

  it('allows Run after a workflow execution was cancelled but displays cancelled', () => {
    const r = recipe()
    const status = {
      phase: 'active' as const,
      workflowExecution: {
        phase: 'cancelled' as const,
        startedAt: '2026-05-07T23:10:51.000Z',
        completedAt: '2026-05-07T23:12:00.000Z',
      },
    }

    expect(isRecipeReadyToRun(r, status)).toBe(true)
    expect(getRecipeDisplayPhase(r, status)).toBe('cancelled')
  })

  it('blocks workflows without an on-demand trigger from manual runs', () => {
    const r = recipe({ spec: { steps: [{ id: 's1', instruction: 'do work' }] } })

    expect(isRecipeReadyToRun(r, { phase: 'active' })).toBe(false)
    expect(getRecipeRunDisabledReason(r, { phase: 'active' })).toBe(
      'Workflow is installed but does not declare spec.triggers.onDemand, so Control UI and Desktop cannot trigger it manually. Add an on-demand trigger before running it.'
    )
  })

  it('blocks workflows whose on-demand trigger excludes user actors', () => {
    const r = recipe({
      spec: {
        triggers: { onDemand: { allowedActors: ['autonomous'] } },
        steps: [{ id: 's1', instruction: 'do work' }],
      },
    })

    expect(isRecipeReadyToRun(r, { phase: 'active' })).toBe(false)
    expect(getRecipeRunDisabledReason(r, { phase: 'active' })).toBe(
      'Workflow on-demand trigger does not allow user actors. Add "user" to spec.triggers.onDemand.allowedActors for Control UI and Desktop App runs.'
    )
  })

  it('blocks recipes without steps or triggers', () => {
    const r = recipe({ spec: { workloads: [{ id: 'w1' }] } })

    expect(isRecipeReadyToRun(r, { phase: 'active' })).toBe(false)
    expect(getRecipeRunDisabledReason(r, { phase: 'active' })).toBe('Recipe has no steps to run.')
  })

  it('filters stale runs from a deleted previous recipe instance', () => {
    const r = recipe()

    expect(
      getVisibleWorkflowRuns(r, { phase: 'active' }, [
        legacyRun({
          id: 'old-run',
          triggeredAt: '2026-05-07T22:09:14.000Z',
          startedAt: '2026-05-07T22:09:15.000Z',
        }),
      ])
    ).toEqual([])
  })

  it('adds the current deployment execution to the visible runs list', () => {
    const r = recipe()
    const visible = getVisibleWorkflowRuns(
      r,
      {
        phase: 'active',
        workflowExecution: {
          phase: 'completed',
          message: 'Workflow completed',
          startedAt: '2026-05-07T23:10:51.000Z',
          completedAt: '2026-05-07T23:15:26.000Z',
        },
      },
      []
    )

    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      id: 'initial-deploy',
      phase: 'Succeeded',
      message: 'Workflow completed',
      isCurrentExecution: true,
      isClickable: false,
    })
  })

  it('accepts the canonical Control API run DTO shape', () => {
    const r = recipe()
    const dto: WorkflowRunSummary = {
      id: 'fresh-run',
      source: 'live',
      phase: 'Succeeded',
      triggeredAt: '2026-05-07T23:11:00.000Z',
      startedAt: '2026-05-07T23:11:01.000Z',
      completedAt: '2026-05-07T23:12:00.000Z',
      message: 'ok',
      actor: { type: 'user-session', userId: '9ca1644a-222b-4cb6-ac42-c1b86ba08cbd' },
      executionRef: {
        namespace: 'sandbox-recipes',
        name: 'test-recipe-fresh',
      },
    }

    expect(getVisibleWorkflowRuns(r, { phase: 'active' }, [dto])).toEqual([
      expect.objectContaining({
        id: 'fresh-run',
        phase: 'Succeeded',
        isClickable: true,
        executionRef: { namespace: 'sandbox-recipes', name: 'test-recipe-fresh' },
      }),
    ])
  })

  it('keeps a current parent execution visible and clickable when no child run row exists yet', () => {
    const r = recipe()

    const visible = getVisibleWorkflowRuns(
      r,
      {
        phase: 'active',
        workflowExecution: {
          phase: 'running',
          startedAt: '2026-05-07T23:10:51.000Z',
        },
      },
      []
    )

    expect(visible).toEqual([
      expect.objectContaining({
        id: 'initial-deploy',
        phase: 'Deploying',
        isCurrentExecution: true,
        isClickable: true,
      }),
    ])
  })

  it('does not duplicate current execution when Control API already has the child run', () => {
    const r = recipe()
    const visible = getVisibleWorkflowRuns(
      r,
      {
        phase: 'active',
        workflowExecution: {
          phase: 'running',
          startedAt: '2026-05-07T23:11:01.000Z',
        },
      },
      [
        run({
          id: 'child-run',
          phase: 'Running',
          triggeredAt: '2026-05-07T23:11:00.000Z',
          startedAt: '2026-05-07T23:11:01.500Z',
          completedAt: null,
          executionRef: {
            namespace: 'sandbox-recipes',
            name: 'test-recipe-child',
          },
        }),
      ]
    )

    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      id: 'child-run',
      phase: 'Running',
      isClickable: true,
    })
    expect(visible[0].isCurrentExecution).toBeUndefined()
  })

  it('does not duplicate a pending current execution when Control API already has the run', () => {
    const r = recipe()
    const visible = getVisibleWorkflowRuns(
      r,
      {
        phase: 'active',
        workflowExecution: {
          phase: 'initializing',
        },
      },
      [
        run({
          id: 'pending-child-run',
          phase: 'Pending',
          triggeredAt: '2026-05-07T23:11:05.000Z',
          startedAt: null,
          completedAt: null,
          executionRef: {
            namespace: 'sandbox-recipes',
            name: 'test-recipe-pending',
          },
        }),
      ]
    )

    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      id: 'pending-child-run',
      phase: 'Pending',
      isClickable: true,
    })
    expect(visible[0].isCurrentExecution).toBeUndefined()
  })

  it('keeps polling while workflowExecution is running even when recipe phase is active', () => {
    const r = recipe()

    expect(
      shouldPollWorkflowRecipe(
        r,
        {
          phase: 'active',
          workflowExecution: {
            phase: 'running',
            startedAt: '2026-05-07T23:10:51.000Z',
          },
        },
        []
      )
    ).toBe(true)
  })
})
