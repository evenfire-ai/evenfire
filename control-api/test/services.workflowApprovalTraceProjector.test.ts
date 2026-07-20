import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  WorkflowApprovalTracePendingError,
  projectWorkflowApprovalTraceInTransaction,
} from '../src/services/tracing/workflowApprovalTraceProjector.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'

function dbWith(rows: { approval: Record<string, unknown>; run?: Record<string, unknown> }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM workflow_approval_requests')) {
      return { rows: [rows.approval], rowCount: 1 }
    }
    if (sql.includes('FROM workflow_runs')) {
      return { rows: rows.run ? [rows.run] : [], rowCount: rows.run ? 1 : 0 }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  return { db: { query } as unknown as DbClient, query }
}

describe('workflow approval trace projection', () => {
  it('projects request and Telegram-resolved decision with distinct human actors', async () => {
    const { db } = dbWith({
      approval: {
        id: REQUEST_ID,
        status: 'approved',
        requestedAt: '2026-07-12T01:00:00.000Z',
        decidedAt: '2026-07-12T01:01:00.000Z',
        decidedByUserId: 'approver-user',
        decisionMaker: { userId: 'approver-user' },
        boundWorkflowRunId: RUN_ID,
        boundWorkflowStepId: 'approval-gated-step',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
      },
      run: {
        actorId: 'initiating-user',
        actorType: 'user',
        teamId: null,
        usageTeamId: 'team-1',
        rootSpanId: 'root-span',
      },
    })
    const appendEntries = vi.fn().mockResolvedValue(undefined)

    await expect(
      projectWorkflowApprovalTraceInTransaction(db, REQUEST_ID, appendEntries)
    ).resolves.toBe(2)
    const entries = appendEntries.mock.calls[0]![1]
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      binding: {
        runId: RUN_ID,
        actorHumanSub: 'initiating-user',
        decision: 'require_approval',
        decisionActorSub: null,
        parentSpanId: 'root-span',
      },
      input: {
        eventType: 'approval',
        payload: { status: 'requested', detail_ref: 'workflow-step:approval-gated-step' },
      },
    })
    expect(entries[1]).toMatchObject({
      binding: {
        actorHumanSub: 'initiating-user',
        decision: 'allow',
        decisionActorSub: 'approver-user',
        decisionSourceKind: 'approval_resolution',
      },
      input: { eventType: 'approval', payload: { status: 'approved' } },
    })
  })

  it('ignores pre-run trigger approvals that have no server-owned run binding', async () => {
    const { db } = dbWith({
      approval: {
        id: REQUEST_ID,
        status: 'approved',
        requestedAt: '2026-07-12T01:00:00.000Z',
        decidedAt: '2026-07-12T01:01:00.000Z',
        decidedByUserId: 'approver-user',
        decisionMaker: {},
        boundWorkflowRunId: null,
        boundWorkflowStepId: null,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
      },
    })
    const appendEntries = vi.fn()

    await expect(
      projectWorkflowApprovalTraceInTransaction(db, REQUEST_ID, appendEntries)
    ).resolves.toBe(0)
    expect(appendEntries).not.toHaveBeenCalled()
  })

  it('defers projection until the WRC root is available', async () => {
    const { db } = dbWith({
      approval: {
        id: REQUEST_ID,
        status: 'pending',
        requestedAt: '2026-07-12T01:00:00.000Z',
        decidedAt: null,
        decidedByUserId: null,
        decisionMaker: null,
        boundWorkflowRunId: RUN_ID,
        boundWorkflowStepId: 'approval-gated-step',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
      },
    })

    await expect(
      projectWorkflowApprovalTraceInTransaction(db, REQUEST_ID, vi.fn())
    ).rejects.toBeInstanceOf(WorkflowApprovalTracePendingError)
  })
})
