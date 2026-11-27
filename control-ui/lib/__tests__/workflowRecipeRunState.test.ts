import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeResource, WorkflowRecipeStatus, WorkflowRunSummary } from '../api'
import {
  type WorkflowRunListItem,
  getRecipeDisplayPhase,
  getRecipeResourceDisplayStatus,
  getRecipeRunDisabledReason,
  getRunCancelState,
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
        [],
        NO_ACCEPTED_RUNS
      )
    ).toBe(true)
  })
})

const NO_ACCEPTED_RUNS: ReadonlySet<string> = new Set()
const LIVE_RUN_ID = '0d4f1b52-7c1e-4a8e-9a57-2c3f4d5e6f70'
const OPERATOR_ID = '5b0c8f0e-3a52-4f7c-8d0e-6a1b2c3d4e5f'

// A `workflow_runs` row as control-api stores it, and its admin run DTO built the
// way `mapDbRun` builds it (`control-api/src/services/workflows/workflowRunReadService.ts`,
// `mapDbRun`): same keys, same order, `source: 'live'`, cancel fields always present.
type WorkflowRunsRow = {
  run_id: string
  phase: string
  approval_request_id: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  failure_reason: string | null
  cancel_requested_at: string | null
  canceled_by: string | null
  child_recipe_namespace: string | null
  child_recipe_name: string | null
}

function workflowRunsRow(overrides: Partial<WorkflowRunsRow> = {}): WorkflowRunsRow {
  return {
    run_id: LIVE_RUN_ID,
    phase: 'Running',
    approval_request_id: null,
    created_at: '2026-05-07T23:11:00.000Z',
    started_at: '2026-05-07T23:11:01.000Z',
    completed_at: null,
    failure_reason: null,
    cancel_requested_at: null,
    canceled_by: null,
    child_recipe_namespace: 'sandbox-recipes',
    child_recipe_name: 'test-recipe-0d4f1b52',
    ...overrides,
  }
}

function adminRunDto(row: WorkflowRunsRow): WorkflowRunListItem {
  return {
    id: row.run_id,
    source: 'live',
    approvalRequestId: row.approval_request_id ?? null,
    phase: row.phase,
    triggeredAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    message: row.failure_reason ?? null,
    cancelRequestedAt: row.cancel_requested_at,
    canceledBy: row.canceled_by,
    actor: { type: 'admin-ui', adminUserId: OPERATOR_ID },
    executionRef:
      row.child_recipe_name && row.child_recipe_namespace
        ? { namespace: row.child_recipe_namespace, name: row.child_recipe_name }
        : null,
  }
}

// An archived run as `mapAuditRun` returns it: no cancel fields.
function auditRunDto(phase: string): WorkflowRunListItem {
  return {
    id: 'a1e2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b',
    source: 'audit',
    approvalRequestId: null,
    phase,
    triggeredAt: '2026-05-07T23:11:00.000Z',
    startedAt: '2026-05-07T23:11:01.000Z',
    completedAt: null,
    message: null,
    actor: { type: 'admin-ui', adminUserId: OPERATOR_ID },
    executionRef: null,
  }
}

const REQUESTED = {
  cancel_requested_at: '2026-05-07T23:11:30.000Z',
  canceled_by: `operator:${OPERATOR_ID}`,
}

describe('getRunCancelState', () => {
  it.each(['Pending', 'Running', 'AuthorizationPaused'])(
    'offers cancel on a live %s run without a request',
    phase => {
      expect(getRunCancelState(adminRunDto(workflowRunsRow({ phase })), NO_ACCEPTED_RUNS)).toBe(
        'cancellable'
      )
    }
  )

  it.each(['Pending', 'Running', 'AuthorizationPaused'])(
    'shows a live %s run with a stored request as canceling',
    phase => {
      expect(
        getRunCancelState(adminRunDto(workflowRunsRow({ phase, ...REQUESTED })), NO_ACCEPTED_RUNS)
      ).toBe('canceling')
    }
  )

  it('shows a run whose cancel this page accepted as canceling when the row lacks the request', () => {
    const row = adminRunDto(workflowRunsRow({ phase: 'Running' }))
    expect(getRunCancelState(row, new Set([LIVE_RUN_ID]))).toBe('canceling')
    expect(getRunCancelState(row, new Set(['another-run']))).toBe('cancellable')
  })

  it.each(['Succeeded', 'Failed', 'Canceled'])('offers nothing on a terminal %s run', phase => {
    expect(
      getRunCancelState(
        adminRunDto(workflowRunsRow({ phase, ...REQUESTED })),
        new Set([LIVE_RUN_ID])
      )
    ).toBe('none')
  })

  it.each(['Pending', 'Running', 'AuthorizationPaused'])(
    'offers nothing on an archived %s row',
    phase => {
      expect(getRunCancelState(auditRunDto(phase), NO_ACCEPTED_RUNS)).toBe('none')
    }
  )

  it('offers nothing on the synthetic current-execution row', () => {
    const [current] = getVisibleWorkflowRuns(
      recipe(),
      {
        phase: 'active',
        workflowExecution: { phase: 'running', startedAt: '2026-05-07T23:30:00.000Z' },
      },
      []
    )
    expect(current).toMatchObject({ id: 'current-execution', source: 'status', phase: 'Running' })
    expect(getRunCancelState(current, NO_ACCEPTED_RUNS)).toBe('none')
  })
})

describe('shouldPollWorkflowRecipe while a run is canceling', () => {
  const settled: WorkflowRecipeStatus = { phase: 'active' }
  const pausedRow = (overrides: Partial<WorkflowRunsRow> = {}) =>
    adminRunDto(workflowRunsRow({ phase: 'AuthorizationPaused', completed_at: null, ...overrides }))

  it('polls while a run is canceling', () => {
    // Liveness of the clause: without a request and without an accepted id the
    // same paused run does not poll.
    expect(shouldPollWorkflowRecipe(recipe(), settled, [pausedRow()], NO_ACCEPTED_RUNS)).toBe(false)
    expect(
      shouldPollWorkflowRecipe(recipe(), settled, [pausedRow(REQUESTED)], NO_ACCEPTED_RUNS)
    ).toBe(true)
    expect(shouldPollWorkflowRecipe(recipe(), settled, [pausedRow()], new Set([LIVE_RUN_ID]))).toBe(
      true
    )
  })

  it('does not poll for a hidden canceling run', () => {
    // Created before the current recipe instance (`creationTimestamp`
    // 2026-05-07T23:10:46Z), so `getVisibleWorkflowRuns` hides it.
    const hidden = pausedRow({
      ...REQUESTED,
      created_at: '2026-05-07T22:09:14.000Z',
      started_at: '2026-05-07T22:09:15.000Z',
    })
    expect(getVisibleWorkflowRuns(recipe(), settled, [hidden])).toEqual([])
    expect(shouldPollWorkflowRecipe(recipe(), settled, [hidden], new Set([LIVE_RUN_ID]))).toBe(
      false
    )

    // The same run, made visible, polls.
    const visible = { ...hidden, triggeredAt: '2026-05-07T23:11:00.000Z', startedAt: null }
    expect(getVisibleWorkflowRuns(recipe(), settled, [visible])).toHaveLength(1)
    expect(shouldPollWorkflowRecipe(recipe(), settled, [visible], new Set([LIVE_RUN_ID]))).toBe(
      true
    )
  })

  it('keeps the base verdicts of the other clauses', () => {
    const running = adminRunDto(workflowRunsRow({ phase: 'Running' }))
    const done = adminRunDto(workflowRunsRow({ phase: 'Succeeded' }))
    expect(shouldPollWorkflowRecipe(recipe(), settled, [running], NO_ACCEPTED_RUNS)).toBe(true)
    expect(shouldPollWorkflowRecipe(recipe(), settled, [done], NO_ACCEPTED_RUNS)).toBe(false)
    expect(
      shouldPollWorkflowRecipe(recipe(), { phase: 'deploying' }, [done], NO_ACCEPTED_RUNS)
    ).toBe(true)
  })
})
