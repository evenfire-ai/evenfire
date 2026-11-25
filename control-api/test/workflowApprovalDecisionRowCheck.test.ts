import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  WorkflowApprovalAuthorityStaleError,
  recordDecision,
} from '../src/services/userApprovalRequestService.js'
import {
  type WorkflowAuthorityBinding,
  WorkflowAuthorityError,
  requireCurrentWorkflowApprovalAuthority,
  workflowAuthorityBindingFromClaims,
} from '../src/services/workflows/workflowAuthorityBindingService.js'

type QueryResult = { rows: unknown[]; rowCount: number }
type Call = { kind: string; sql: string; values: unknown[] | undefined }

const state = vi.hoisted(() => ({
  log: [] as string[],
  calls: [] as Array<{ kind: string; sql: string; values: unknown[] | undefined }>,
  unlockedReads: 0,
  rows: {} as Record<string, unknown[]>,
  failures: {} as Record<string, unknown>,
  approval: {} as Record<string, unknown>,
  resolverContext: null as unknown,
}))

// Every statement of the decision transaction is classified, so each case can
// assert the exact lock order; an unknown statement fails the test.
const fakeClient = vi.hoisted(() => ({
  query: async (sql: string, values?: unknown[]): Promise<QueryResult> => {
    const kind = (() => {
      if (sql.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')) return 'set-rr'
      if (sql.includes('JOIN user_workflow_triggers uwt')) return 'decision-uwt'
      if (sql.includes('JOIN team_members tm')) return 'decision-tm'
      if (sql.includes('JOIN workflow_recipe_allowed_teams wat')) return 'decision-wat'
      if (sql.includes('FOR UPDATE OF war')) return 'war-lock'
      if (sql.includes('AS "triggerAuthorityBindingId"')) return 'approval-lock'
      if (sql.includes('FROM workflow_approval_trigger_run_intents')) return 'run-intent'
      if (sql.includes('pg_advisory_xact_lock')) return 'run-key'
      if (sql.includes('INSERT INTO workflow_runs')) return 'insert-run'
      if (sql.includes('FROM workflow_runs')) return 'run-row'
      if (sql.includes('FROM external_user_sessions')) return 'session'
      if (sql.includes('FROM users')) return 'users'
      if (sql.includes('clock_timestamp() < to_timestamp')) return 'clock'
      if (sql.includes('INSERT INTO workflow_authority_bindings')) return 'insert-binding'
      if (sql.includes('INSERT INTO notification_deliveries')) return 'notify'
      if (sql.includes("SET status = 'consumed'")) return 'consume-update'
      if (sql.includes('SET consume_authority_binding_id')) return 'update-consume-binding'
      if (sql.includes('UPDATE workflow_approval_requests')) return 'update-approval'
      if (sql.includes('AND (recipe_namespace, recipe_name) IN')) return 'consume-uwt'
      if (sql.includes('FROM user_workflow_triggers')) return 'resolver-uwt'
      throw new Error(`Unexpected approval decision statement: ${sql}`)
    })()
    state.log.push(kind)
    state.calls.push({ kind, sql, values })
    if (kind in state.failures) throw state.failures[kind]
    if (kind === 'approval-lock') return { rows: [state.approval], rowCount: 1 }
    const rows = state.rows[kind] ?? []
    return { rows, rowCount: rows.length }
  },
}))

// The unlocked snapshot reads use their own pooled client, outside the
// decision transaction, and are counted separately.
const unlockedClient = vi.hoisted(() => ({
  query: async (sql: string): Promise<QueryResult> => {
    if (!sql.includes('AS "triggerAuthorityBindingId"') || sql.includes('FOR UPDATE')) {
      throw new Error(`Unexpected unlocked statement: ${sql}`)
    }
    state.unlockedReads += 1
    return { rows: [state.approval], rowCount: 1 }
  },
  release: () => undefined,
}))

vi.mock('../src/db.js', () => ({
  pool: { connect: async () => unlockedClient },
  withTransaction: async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    state.log.push('BEGIN')
    try {
      const result = await work(fakeClient as unknown as DbClient)
      state.log.push('COMMIT')
      return result
    } catch (error) {
      state.log.push('ROLLBACK')
      throw error
    }
  },
}))

vi.mock('../src/services/access/actionAuthorizer.js', () => ({
  authorizeActionV2: async () => {
    state.log.push('resolver')
    return { status: 'allowed', context: state.resolverContext }
  },
}))

vi.mock('../src/services/tracing/workflowApprovalTraceProjector.js', () => ({
  enqueueWorkflowApprovalTraceProjection: () => undefined,
}))

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const approvalId = '66666666-6666-4666-8666-666666666666'
const teamId = '44444444-4444-4444-8444-444444444444'
const recipeNamespace = 'sandbox-recipes'
const recipeName = 'decision-row-check'
const runKey = 'decision-run-key'

function decisionAuthority(input: {
  decision: 'approve' | 'deny'
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
}): WorkflowAuthorityBinding {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const target = { approvalId, decision: input.decision }
  return workflowAuthorityBindingFromClaims({
    typ: 'user_delegation',
    ver: 2,
    sub: userId,
    sid,
    sv: 3,
    jti: '33333333-3333-4333-8333-333333333333',
    iat: nowSeconds - 10,
    exp: nowSeconds + 300,
    operationIds: ['workflow.approval.decide'],
    scopes: ['workflow.approval.decide'],
    resource: {
      environmentId: 'local',
      type: 'workflow_approval',
      canonicalId: `workflow_approval:local:${approvalId}`,
      logicalId: approvalId,
      displayName: approvalId,
    },
    targets: { 'workflow.approval.decide': target },
    targetHashes: { 'workflow.approval.decide': `ath2_${'a'.repeat(43)}` },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind: input.pathKind,
    effectiveTeamId: input.effectiveTeamId,
  } as never)
}

function contextFor(authority: WorkflowAuthorityBinding) {
  const { binding } = authority
  return {
    authorizationRevision: binding.authorizationRevision,
    behaviorBindingHash: binding.behaviorBindingHash,
    accessPathId: binding.accessPathId,
    principal: { userId: binding.userId, sid: binding.sid, sessionVersion: binding.sessionVersion },
    targetHash: binding.targetHash,
    resource: binding.resource,
    target: binding.target,
    validUntil: null,
  }
}

function approvalRow(target: 'user' | 'team'): Record<string, unknown> {
  return {
    id: approvalId,
    status: 'pending',
    isExpired: false,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    requestedAt: '2026-11-09T00:00:00.000Z',
    recipeNamespace,
    recipeName,
    targetUserId: target === 'user' ? userId : null,
    targetTeamId: target === 'team' ? teamId : null,
    triggerAuthorityBindingId: 'trigger-binding',
    payload: { message: 'Approve the workflow trigger' },
  }
}

function cannedRows(): Record<string, unknown[]> {
  return {
    users: [{ id: userId }],
    session: [{ sid }],
    'decision-uwt': [{ user_id: userId }],
    'decision-tm': [{ role: 'member' }],
    'decision-wat': [{ team_id: teamId }],
    clock: [{ delegationCurrent: true, pathCurrent: true }],
    'insert-binding': [{ id: 'binding-1' }],
  }
}

/** The rest of the approve path: the run intent, the consume and the run. */
function approvePathRows(): Record<string, unknown[]> {
  return {
    'run-intent': [
      {
        approvalRequestId: approvalId,
        recipeNamespace,
        recipeName,
        callerKey: 'external-rest-api',
        actorType: 'user',
        actorId: userId,
        teamId: null,
        usageTeamId: null,
        triggerSource: 'onDemand',
        idempotencyKey: runKey,
        inputs: null,
        intermediateParameters: null,
        outputOverrides: null,
        maxDurationSeconds: null,
        ttlSecondsAfterFinished: null,
        idempotencyPayloadHash: 'payload-hash',
        authorityBindingId: 'trigger-binding',
      },
    ],
    'war-lock': [
      {
        status: 'approved',
        recipeNamespace,
        recipeName,
        isExpired: false,
        targetUserId: userId,
        targetTeamId: null,
        payload: null,
        decidedByUserId: userId,
        triggerNamespace: recipeNamespace,
        triggerName: recipeName,
        triggerCaller: 'external-rest-api',
        targetUserAllowed: true,
        targetTeamAllowed: false,
      },
    ],
    'consume-uwt': [{ recipe_namespace: recipeNamespace, recipe_name: recipeName }],
    'resolver-uwt': [{}],
    'consume-update': [{ teamId: null }],
    'insert-run': [{ run_id: 'run-1', approval_request_id: approvalId }],
  }
}

let budget: AccessExecutionBudget

function decide(
  decision: 'approve' | 'deny',
  authority: WorkflowAuthorityBinding,
  decidedBy: { userId: string; teamId?: string } = { userId }
) {
  return recordDecision(
    approvalId,
    decision,
    decidedBy,
    undefined,
    undefined,
    undefined,
    authority,
    {
      authorizeBeforeLock: async () => authority,
      validateCurrentInTransaction: (db: DbClient) =>
        requireCurrentWorkflowApprovalAuthority({ db, authority, budget }),
    }
  )
}

function kinds(kind: string): Call[] {
  return state.calls.filter(call => call.kind === kind)
}

beforeEach(() => {
  state.log = []
  state.calls = []
  state.unlockedReads = 0
  state.rows = cannedRows()
  state.failures = {}
  state.approval = approvalRow('user')
  budget = AccessExecutionBudget.create('action')
})

afterEach(() => {
  budget.close()
})

describe('approval decision bound-row check (T-F1b)', () => {
  it('locks the direct grant after the session and before the clock, then commits', async () => {
    const authority = decisionAuthority({
      decision: 'deny',
      pathKind: 'direct',
      effectiveTeamId: null,
    })
    state.resolverContext = contextFor(authority)

    await expect(decide('deny', authority)).resolves.toEqual({ ok: true })

    expect(state.log).toEqual([
      'BEGIN',
      'set-rr',
      'approval-lock',
      'resolver',
      'users',
      'session',
      'decision-uwt',
      'clock',
      'insert-binding',
      'update-approval',
      'notify',
      'COMMIT',
    ])
    const [read] = kinds('decision-uwt')
    expect(kinds('decision-uwt')).toHaveLength(1)
    expect(state.log.indexOf('decision-uwt')).toBeGreaterThan(state.log.indexOf('BEGIN'))
    expect(state.log.indexOf('decision-uwt')).toBeGreaterThan(state.log.indexOf('session'))
    expect(read?.sql).toContain('FOR SHARE OF uwt')
    expect(read?.values).toEqual([userId, approvalId])
    expect(state.unlockedReads).toBe(1)
  })

  it('locks the active team membership before the team allowance on the team path', async () => {
    state.approval = approvalRow('team')
    const authority = decisionAuthority({
      decision: 'deny',
      pathKind: 'team',
      effectiveTeamId: teamId,
    })
    state.resolverContext = contextFor(authority)

    await expect(decide('deny', authority, { userId, teamId })).resolves.toEqual({ ok: true })

    expect(state.log).toEqual([
      'BEGIN',
      'set-rr',
      'approval-lock',
      'resolver',
      'users',
      'session',
      'decision-tm',
      'decision-wat',
      'clock',
      'insert-binding',
      'update-approval',
      'notify',
      'COMMIT',
    ])
    const [membership] = kinds('decision-tm')
    const [allowance] = kinds('decision-wat')
    expect(membership?.sql).toContain('FOR SHARE OF tm')
    expect(allowance?.sql).toContain('FOR SHARE OF wat')
    expect(membership?.values).toContain(teamId)
    expect(allowance?.values).toContain(teamId)
    expect(state.log).not.toContain('decision-uwt')
  })

  it.each([
    ['direct grant', 'direct', 'decision-uwt'],
    ['team membership', 'team', 'decision-tm'],
    ['team allowance', 'team', 'decision-wat'],
  ] as const)(
    'rejects a missing %s with 409 access_path_stale and writes nothing',
    async (_label, pathKind, missing) => {
      if (pathKind === 'team') state.approval = approvalRow('team')
      const authority = decisionAuthority({
        decision: 'deny',
        pathKind,
        effectiveTeamId: pathKind === 'team' ? teamId : null,
      })
      state.resolverContext = contextFor(authority)
      state.rows[missing] = []

      const error = await decide(
        'deny',
        authority,
        pathKind === 'team' ? { userId, teamId } : { userId }
      ).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(WorkflowAuthorityError)
      expect(error).toMatchObject({ status: 409, code: 'access_path_stale' })

      // Witness: the missing read ran once inside the transaction.
      expect(kinds(missing)).toHaveLength(1)
      if (missing === 'decision-tm') expect(state.log).not.toContain('decision-wat')
      expect(state.log.at(-1)).toBe('ROLLBACK')
      expect(state.log).not.toContain('insert-binding')
      expect(state.log).not.toContain('update-approval')
      expect(state.log).not.toContain('clock')
    }
  )

  it('maps a serialization failure at the bound-row lock to a stale-authority rejection', async () => {
    const authority = decisionAuthority({
      decision: 'deny',
      pathKind: 'direct',
      effectiveTeamId: null,
    })
    state.resolverContext = contextFor(authority)
    state.failures['decision-uwt'] = Object.assign(new Error('could not serialize access'), {
      code: '40001',
    })

    await expect(decide('deny', authority)).rejects.toBeInstanceOf(
      WorkflowApprovalAuthorityStaleError
    )

    expect(kinds('decision-uwt')).toHaveLength(1)
    expect(state.log.at(-1)).toBe('ROLLBACK')
    expect(state.log).not.toContain('insert-binding')
    // Witness of the catch path: one unlocked snapshot read before the
    // transaction and one after the serialization failure.
    expect(state.unlockedReads).toBe(2)
  })

  it('rejects a team path without a team with 400 before any bound-row read', async () => {
    state.approval = approvalRow('team')
    const authority = decisionAuthority({
      decision: 'deny',
      pathKind: 'team',
      effectiveTeamId: null,
    })
    state.resolverContext = contextFor(authority)

    await expect(decide('deny', authority, { userId, teamId })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_action_delegation',
    })

    // Witness: the session lock ran, so the shape guard was reached.
    expect(kinds('session')).toHaveLength(1)
    expect(state.log).not.toContain('decision-uwt')
    expect(state.log).not.toContain('decision-tm')
    expect(state.log).not.toContain('decision-wat')
    expect(state.log.at(-1)).toBe('ROLLBACK')
  })

  it('takes the run key and run row before the user, session and grant locks on approve', async () => {
    const authority = decisionAuthority({
      decision: 'approve',
      pathKind: 'direct',
      effectiveTeamId: null,
    })
    state.resolverContext = contextFor(authority)
    state.rows = { ...cannedRows(), ...approvePathRows() }

    await expect(decide('approve', authority)).resolves.toMatchObject({
      ok: true,
      workflowRun: { created: true, row: { run_id: 'run-1' } },
    })

    expect(state.log.slice(0, 15)).toEqual([
      'BEGIN',
      'set-rr',
      'approval-lock',
      'run-intent',
      'run-key',
      'run-row',
      'resolver',
      'users',
      'session',
      'decision-uwt',
      'clock',
      'insert-binding',
      'update-approval',
      'notify',
      'run-intent',
    ])
    // The early key and row locks, then their re-entrant repeats.
    expect(kinds('run-intent')).toHaveLength(2)
    expect(kinds('run-key')).toHaveLength(2)
    expect(kinds('run-row')).toHaveLength(2)
    expect(state.log.indexOf('run-key')).toBeLessThan(state.log.indexOf('users'))
    expect(kinds('run-key').map(call => call.values)).toEqual([
      [`workflow_run:${recipeNamespace}:${recipeName}:${runKey}`],
      [`workflow_run:${recipeNamespace}:${recipeName}:${runKey}`],
    ])
    expect(kinds('run-row')[0]?.sql).toContain('FOR UPDATE')
    expect(state.log).toContain('consume-update')
    expect(state.log).toContain('insert-run')
    expect(state.log.at(-1)).toBe('COMMIT')
  })
})
