import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { createRun } from '../src/services/workflowRunService.js'
import {
  type WorkflowAuthorityBinding,
  requireCurrentWorkflowTriggerAuthority,
  workflowAuthorityBindingFromClaims,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { createWorkflowTriggerApprovalRequest } from '../src/services/workflows/workflowTriggerApprovalService.js'

type QueryResult = { rows: unknown[]; rowCount: number }

const state = vi.hoisted(() => ({
  log: [] as string[],
  rows: {} as Record<string, unknown[]>,
}))

// The fake transaction records BEGIN/COMMIT/ROLLBACK and classifies every
// statement, so each test can assert which row-check reads ran inside the
// insert transaction and that nothing was written after a rejection.
const fakeClient = vi.hoisted(() => ({
  query: async (sql: string): Promise<QueryResult> => {
    const kind = (() => {
      if (sql.includes('pg_advisory_xact_lock')) return 'advisory-lock'
      if (sql.includes('FROM workflow_runs wr')) return 'existing-run'
      if (sql.includes('SELECT id FROM workflow_approval_requests')) return 'existing-approval'
      if (sql.includes('SELECT u.lifecycle_state')) return 'session'
      if (sql.includes('FROM user_workflow_triggers')) return 'direct-grant'
      if (sql.includes('FROM team_members')) return 'team-membership'
      if (sql.includes('FROM team_workflow_triggers')) return 'team-grant'
      if (sql.includes('fence_time')) return 'clock'
      if (sql.includes('INSERT INTO workflow_authority_bindings')) return 'insert-binding'
      if (sql.includes('INSERT INTO workflow_runs')) return 'insert-run'
      if (sql.includes('INSERT INTO workflow_approval_requests')) return 'insert-approval'
      throw new Error(`Unexpected trigger row-check statement: ${sql}`)
    })()
    state.log.push(kind)
    const rows = state.rows[kind] ?? []
    return { rows, rowCount: rows.length }
  },
}))

vi.mock('../src/db.js', () => ({
  pool: {},
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

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const teamId = '44444444-4444-4444-8444-444444444444'
const recipeNamespace = 'sandbox-recipes'
const recipeName = 'row-check'

function authority(pathKind: 'direct' | 'team'): WorkflowAuthorityBinding {
  const target = { recipeNamespace, recipeName }
  return workflowAuthorityBindingFromClaims({
    typ: 'user_delegation',
    ver: 2,
    sub: userId,
    sid,
    sv: 3,
    jti: '33333333-3333-4333-8333-333333333333',
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    operationIds: ['workflow.trigger'],
    scopes: ['workflow.trigger'],
    resource: {
      environmentId: 'local',
      type: 'workflow_recipe',
      canonicalId: `workflow_recipe:local:${recipeNamespace}/${recipeName}`,
      logicalId: `${recipeNamespace}/${recipeName}`,
      displayName: `${recipeNamespace}/${recipeName}`,
    },
    targets: { 'workflow.trigger': target },
    targetHashes: { 'workflow.trigger': `ath2_${'a'.repeat(43)}` },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind,
    effectiveTeamId: pathKind === 'team' ? teamId : null,
  } as never)
}

const runInput = {
  recipe_namespace: recipeNamespace,
  recipe_name: recipeName,
  actor_type: 'user' as const,
  actor_id: userId,
  idempotency_key: 'row-check-key',
  trigger_source: 'onDemand' as const,
}

const rowCheck = (db: DbClient, bound: WorkflowAuthorityBinding) =>
  requireCurrentWorkflowTriggerAuthority({ db, authority: bound })

const activeSession = {
  lifecycle_state: 'active',
  session_version: 3,
  current_jti: 'jti',
  revoked_at: null,
  idle_expires_at: new Date(Date.now() + 60_000).toISOString(),
  absolute_expires_at: new Date(Date.now() + 120_000).toISOString(),
}

function currentRows(): Record<string, unknown[]> {
  return {
    'advisory-lock': [{}],
    session: [activeSession],
    'direct-grant': [
      { user_id: userId, recipe_namespace: recipeNamespace, recipe_name: recipeName },
    ],
    'team-membership': [{ role: 'member' }],
    'team-grant': [{ team_id: teamId }],
    clock: [{ delegationCurrent: true, idleSessionCurrent: true, absoluteSessionCurrent: true }],
    'insert-binding': [{ id: 'binding-1' }],
    'insert-run': [{ run_id: 'run-1', initiating_authority_binding_id: 'binding-1' }],
  }
}

function writes(): string[] {
  return state.log.filter(entry => entry.startsWith('insert-'))
}

beforeEach(() => {
  state.log = []
  state.rows = currentRows()
})

describe('workflow trigger row check (T-W1)', () => {
  it('persists the binding and the run after one bound-row check', async () => {
    const result = await createRun({
      ...runInput,
      authority: authority('direct'),
      validateCurrentInTransaction: rowCheck,
    })

    expect(result).toMatchObject({ created: true, row: { run_id: 'run-1' } })
    expect(state.log).toEqual([
      'BEGIN',
      'advisory-lock',
      'existing-run',
      'session',
      'direct-grant',
      'clock',
      'insert-binding',
      'insert-run',
      'COMMIT',
    ])
  })

  it.each([
    ['revoked session', { ...activeSession, revoked_at: '2026-11-08T00:00:00.000Z' }],
    ['inactive user', { ...activeSession, lifecycle_state: 'deactivated' }],
    ['missing session', null],
  ])('rejects a %s with 401 invalid_session and writes nothing', async (_label, session) => {
    state.rows.session = session ? [session] : []

    await expect(
      createRun({
        ...runInput,
        authority: authority('direct'),
        validateCurrentInTransaction: rowCheck,
      })
    ).rejects.toMatchObject({ status: 401, code: 'invalid_session' })

    // Witness: the transaction began and the row check read the session once.
    expect(state.log.filter(entry => entry === 'session')).toHaveLength(1)
    expect(state.log[0]).toBe('BEGIN')
    expect(state.log.at(-1)).toBe('ROLLBACK')
    expect(writes()).toEqual([])
  })

  it('rejects a deleted direct grant with 409 access_path_stale and writes nothing', async () => {
    state.rows['direct-grant'] = []

    await expect(
      createRun({
        ...runInput,
        authority: authority('direct'),
        validateCurrentInTransaction: rowCheck,
      })
    ).rejects.toMatchObject({ status: 409, code: 'access_path_stale' })

    expect(state.log.filter(entry => entry === 'direct-grant')).toHaveLength(1)
    expect(state.log[0]).toBe('BEGIN')
    expect(state.log.at(-1)).toBe('ROLLBACK')
    expect(writes()).toEqual([])
  })

  it('locks the active team membership before the team grant on the team path', async () => {
    const result = await createRun({
      ...runInput,
      authority: authority('team'),
      validateCurrentInTransaction: rowCheck,
    })

    expect(result).toMatchObject({ created: true, row: { run_id: 'run-1' } })
    expect(state.log).toEqual([
      'BEGIN',
      'advisory-lock',
      'existing-run',
      'session',
      'team-membership',
      'team-grant',
      'clock',
      'insert-binding',
      'insert-run',
      'COMMIT',
    ])
  })

  it('rejects an inactive team membership with 409 access_path_stale and writes nothing', async () => {
    // The membership statement selects only the active row, so an inactive
    // membership returns no row and the grant is never read.
    state.rows['team-membership'] = []

    await expect(
      createRun({
        ...runInput,
        authority: authority('team'),
        validateCurrentInTransaction: rowCheck,
      })
    ).rejects.toMatchObject({ status: 409, code: 'access_path_stale' })

    // Witness: the membership read ran once inside the transaction.
    expect(state.log.filter(entry => entry === 'team-membership')).toHaveLength(1)
    expect(state.log).not.toContain('team-grant')
    expect(state.log).not.toContain('direct-grant')
    expect(state.log.at(-1)).toBe('ROLLBACK')
    expect(writes()).toEqual([])
  })

  it('rejects a deleted team grant after the membership read with 409 access_path_stale', async () => {
    state.rows['team-grant'] = []

    await expect(
      createRun({
        ...runInput,
        authority: authority('team'),
        validateCurrentInTransaction: rowCheck,
      })
    ).rejects.toMatchObject({ status: 409, code: 'access_path_stale' })

    expect(state.log).toEqual([
      'BEGIN',
      'advisory-lock',
      'existing-run',
      'session',
      'team-membership',
      'team-grant',
      'ROLLBACK',
    ])
    expect(writes()).toEqual([])
  })

  it('rejects a deleted grant before an approval request is inserted', async () => {
    state.rows['direct-grant'] = []
    state.rows['existing-approval'] = []

    await expect(
      createWorkflowTriggerApprovalRequest({
        recipeNamespace,
        recipeName,
        callerKey: `user:${userId}`,
        targetUserId: userId,
        payload: { kind: 'workflow_trigger' } as never,
        idempotencyKey: 'row-check-approval-key',
        runIntent: {
          actorType: 'user',
          actorId: userId,
          teamId: null,
          usageTeamId: null,
          triggerSource: 'onDemand',
        },
        authority: authority('direct'),
        validateCurrentInTransaction: rowCheck,
      })
    ).rejects.toMatchObject({ status: 409, code: 'access_path_stale' })

    expect(state.log).toEqual([
      'BEGIN',
      'advisory-lock',
      'existing-approval',
      'session',
      'direct-grant',
      'ROLLBACK',
    ])
    expect(writes()).toEqual([])
  })

  // §10 L2: a V2 authority without the row-check validator is a wiring defect.
  it('fails loud before any transaction when a run authority has no row-check validator', async () => {
    await expect(createRun({ ...runInput, authority: authority('direct') })).rejects.toThrow(
      'workflow_trigger_current_authority_validator_required'
    )
    expect(state.log).toEqual([])
  })

  it('fails loud before any transaction when an approval authority has no row-check validator', async () => {
    await expect(
      createWorkflowTriggerApprovalRequest({
        recipeNamespace,
        recipeName,
        callerKey: `user:${userId}`,
        payload: { kind: 'workflow_trigger' } as never,
        idempotencyKey: 'row-check-approval-key',
        runIntent: {
          actorType: 'user',
          actorId: userId,
          teamId: null,
          usageTeamId: null,
          triggerSource: 'onDemand',
        },
        authority: authority('direct'),
      })
    ).rejects.toThrow('workflow_trigger_current_authority_validator_required')
    expect(state.log).toEqual([])
  })
})
