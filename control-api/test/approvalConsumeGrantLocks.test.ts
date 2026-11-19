import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  ApprovalConsumeError,
  consumeApprovalForTrigger,
} from '../src/services/userApprovalRequestService.js'
import { createApprovedRun } from '../src/services/workflowRunService.js'

type QueryResult = { rows: unknown[]; rowCount: number }
type Call = { kind: string; sql: string; values: unknown[] | undefined }

const state = vi.hoisted(() => ({
  log: [] as string[],
  calls: [] as Array<{ kind: string; sql: string; values: unknown[] | undefined }>,
  rows: {} as Record<string, unknown[]>,
  failures: {} as Record<string, unknown>,
  releases: 0,
}))

// Classifies every statement of the consume (and of `createApprovedRun`), so
// each case can assert where the grant locks run; an unknown statement fails.
const fakeQuery = vi.hoisted(() => async (sql: string, values?: unknown[]) => {
  const kind = (() => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return sql
    if (sql.includes("SET status = 'consumed'")) return 'consume-update'
    if (sql.includes('FOR UPDATE OF war')) return 'war-lock'
    if (sql.includes('FROM workflow_approval_trigger_run_intents')) return 'run-intent'
    if (sql.includes('SELECT id FROM workflow_approval_requests')) return 'approval-lock'
    if (sql.includes('pg_advisory_xact_lock')) return 'run-key'
    if (sql.includes('INSERT INTO workflow_runs')) return 'insert-run'
    if (sql.includes('FROM workflow_runs')) return 'existing-run'
    if (sql.includes('AND (recipe_namespace, recipe_name) IN')) return 'consume-uwt'
    if (sql.includes('LEFT JOIN team_workflow_triggers')) return 'resolver-team'
    if (sql.includes('FROM user_workflow_triggers')) return 'resolver-uwt'
    if (sql.includes('FROM team_members')) return 'consume-tm'
    if (sql.includes('FROM workflow_recipe_allowed_teams')) return 'consume-wat'
    if (sql.includes('FROM team_workflow_triggers')) return 'consume-twt'
    throw new Error(`Unexpected consume statement: ${sql}`)
  })()
  state.log.push(kind)
  state.calls.push({ kind, sql, values })
  if (kind in state.failures) throw state.failures[kind]
  const rows = state.rows[kind] ?? []
  return { rows, rowCount: rows.length } satisfies QueryResult
})

vi.mock('../src/db.js', () => ({
  pool: {
    connect: async () => ({
      query: fakeQuery,
      release: () => {
        state.releases += 1
      },
    }),
  },
  withTransaction: async () => {
    throw new Error('consume tests open no withTransaction')
  },
}))

const deciderId = '11111111-1111-4111-8111-111111111111'
const teamId = '44444444-4444-4444-8444-444444444444'
const approvalId = '66666666-6666-4666-8666-666666666666'
// The approval's recipe and the trigger recipe differ, as for a parent-scoped
// approval, so the lock values show which one each statement binds.
const approvalNamespace = 'mcp-host'
const approvalRecipe = 'standalone'
const triggerNamespace = 'sandbox-recipes'
const triggerRecipe = 'child-recipe'
const callerKey = 'sandbox-recipes/child-recipe'

function approvalRow(target: 'user' | 'team'): Record<string, unknown> {
  return {
    status: 'approved',
    recipeNamespace: approvalNamespace,
    recipeName: approvalRecipe,
    isExpired: false,
    targetUserId: target === 'user' ? deciderId : null,
    targetTeamId: target === 'team' ? teamId : null,
    payload: null,
    decidedByUserId: deciderId,
    triggerNamespace,
    triggerName: triggerRecipe,
    triggerCaller: callerKey,
    targetUserAllowed: target === 'user',
    targetTeamAllowed: target === 'team',
  }
}

const consumeParams = {
  approvalRequestId: approvalId,
  recipeNamespace: triggerNamespace,
  recipeName: triggerRecipe,
  callerKey,
  correlationId: 'corr-consume-locks',
}

function kinds(kind: string): Call[] {
  return state.calls.filter(call => call.kind === kind)
}

const fakeDbTx = { query: fakeQuery } as unknown as DbClient

beforeEach(() => {
  state.log = []
  state.calls = []
  state.failures = {}
  state.releases = 0
  state.rows = {
    'war-lock': [approvalRow('user')],
    'consume-uwt': [{ recipe_namespace: approvalNamespace, recipe_name: approvalRecipe }],
    'resolver-uwt': [{}],
    'consume-tm': [{}],
    'consume-wat': [{}],
    'consume-twt': [{}],
    'resolver-team': [{ teamGranted: true }],
    'consume-update': [{ teamId: null }],
  }
})

describe('approval consume grant locks (T-F2c)', () => {
  it('locks the direct grant rows after the approval row and before the deciding reads', async () => {
    await expect(consumeApprovalForTrigger(consumeParams, fakeDbTx)).resolves.toEqual({
      teamId: null,
    })

    expect(state.log).toEqual(['war-lock', 'consume-uwt', 'resolver-uwt', 'consume-update'])
    const [lock] = kinds('consume-uwt')
    expect(kinds('consume-uwt')).toHaveLength(1)
    expect(lock?.sql).toContain('FOR SHARE')
    expect(lock?.values).toEqual([
      deciderId,
      approvalNamespace,
      approvalRecipe,
      triggerNamespace,
      triggerRecipe,
    ])
  })

  it('locks the team membership, then the allowance and the trigger grant, on the team path', async () => {
    state.rows['war-lock'] = [approvalRow('team')]
    state.rows['consume-update'] = [{ teamId }]

    await expect(consumeApprovalForTrigger(consumeParams, fakeDbTx)).resolves.toEqual({ teamId })

    expect(state.log).toEqual([
      'war-lock',
      'consume-tm',
      'consume-wat',
      'consume-twt',
      'resolver-team',
      'consume-update',
    ])
    for (const kind of ['consume-tm', 'consume-wat', 'consume-twt']) {
      expect(kinds(kind)[0]?.sql).toContain('FOR SHARE')
    }
    expect(kinds('consume-tm')[0]?.values).toEqual([teamId, deciderId])
    expect(kinds('consume-wat')[0]?.values).toEqual([teamId, approvalNamespace, approvalRecipe])
    expect(kinds('consume-twt')[0]?.values).toEqual([teamId, triggerNamespace, triggerRecipe])
  })

  it('surfaces a serialization failure at the grant lock unmapped', async () => {
    const serialization = Object.assign(new Error('could not serialize access'), {
      code: '40001',
    })
    state.failures['consume-uwt'] = serialization

    const error = await consumeApprovalForTrigger(consumeParams, fakeDbTx).catch(
      (caught: unknown) => caught
    )

    expect(error).toBe(serialization)
    expect(error).not.toBeInstanceOf(ApprovalConsumeError)
    // Witness: the lock ran once, right after the approval row.
    expect(kinds('consume-uwt')).toHaveLength(1)
    expect(state.log).toEqual(['war-lock', 'consume-uwt'])
    expect(state.log).not.toContain('consume-update')
  })

  it('keeps the existing grant-missing mapping when the grant row is gone', async () => {
    state.rows['consume-uwt'] = []
    state.rows['resolver-uwt'] = []

    await expect(consumeApprovalForTrigger(consumeParams, fakeDbTx)).rejects.toMatchObject({
      name: 'ApprovalConsumeError',
      code: 'approval_trigger_grant_missing',
    })

    // Witness: the lock ran once before the deciding read.
    expect(kinds('consume-uwt')).toHaveLength(1)
    expect(state.log).toEqual(['war-lock', 'consume-uwt', 'resolver-uwt'])
  })
})

describe('createApprovedRun lock order (T-F3u)', () => {
  it('locks the approval row before the run key, then consumes and inserts', async () => {
    state.rows['run-intent'] = [
      {
        triggerNamespace,
        triggerName: triggerRecipe,
        callerKey,
        actorType: 'user',
        actorId: deciderId,
        teamId: null,
        usageTeamId: null,
        triggerSource: 'onDemand',
        idempotencyKey: 'approved-run-key',
        inputs: null,
        intermediateParameters: null,
        outputOverrides: null,
        maxDurationSeconds: null,
        ttlSecondsAfterFinished: null,
        idempotencyPayloadHash: 'payload-hash',
        authorityBindingId: null,
      },
    ]
    state.rows['approval-lock'] = [{ id: approvalId }]
    state.rows['insert-run'] = [{ run_id: 'run-1', approval_request_id: approvalId }]

    await expect(
      createApprovedRun({
        recipe_namespace: triggerNamespace,
        recipe_name: triggerRecipe,
        actor_type: 'user',
        actor_id: deciderId,
        idempotency_key: 'approved-run-key',
        trigger_source: 'onDemand',
        approval_request_id: approvalId,
        idempotency_payload_hash: 'payload-hash',
        approval_caller_key: callerKey,
        correlation_id: 'corr-approved-run',
      })
    ).resolves.toMatchObject({ created: true, row: { run_id: 'run-1' } })

    expect(state.log).toEqual([
      'BEGIN',
      'run-intent',
      'approval-lock',
      'run-key',
      'existing-run',
      'war-lock',
      'consume-uwt',
      'resolver-uwt',
      'consume-update',
      'insert-run',
      'COMMIT',
    ])
    expect(kinds('approval-lock')[0]?.sql).toContain('FOR UPDATE')
    expect(kinds('approval-lock')[0]?.values).toEqual([approvalId])
    // Witness: the run key ran once, inside BEGIN … COMMIT.
    expect(kinds('run-key')).toHaveLength(1)
    expect(state.log.indexOf('approval-lock')).toBeLessThan(state.log.indexOf('run-key'))
    expect(state.releases).toBe(1)
  })
})
