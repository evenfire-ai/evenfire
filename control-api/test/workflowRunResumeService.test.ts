import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  type WorkflowAuthorityBinding,
  workflowAuthorityBindingFromClaims,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { resumeWorkflowRun } from '../src/services/workflows/workflowRunResumeService.js'

type QueryResult = { rows: unknown[]; rowCount: number }

const state = vi.hoisted(() => ({
  log: [] as string[],
  rows: {} as Record<string, unknown[]>,
  authorize: vi.fn(),
}))

const fakeClient = vi.hoisted(() => ({
  query: async (sql: string): Promise<QueryResult> => {
    const kind = (() => {
      if (sql.includes("set_config('statement_timeout'")) return 'statement-timeout'
      if (sql.includes('FOR UPDATE OF run')) return 'lock-run'
      if (sql.includes('FROM users user_row')) return 'lineage-session'
      if (sql.includes('FROM user_workflow_triggers')) return 'lineage-direct-grant'
      if (sql.includes('FROM team_members')) return 'lineage-team-membership'
      if (sql.includes('FROM team_workflow_triggers')) return 'lineage-team-grant'
      if (sql.includes('INSERT INTO workflow_authority_bindings')) return 'insert-binding'
      if (sql.includes('SET source_expires_at = LEAST')) return 'bound-expiry'
      if (sql.includes('UPDATE workflow_runs')) return 'resume-run'
      throw new Error(`Unexpected resume statement: ${sql}`)
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

// The resume service must not run the action resolver inside its run-locked
// transaction (WF-10/15): the route's checkpoint already did. This spy proves
// that no call reaches it.
vi.mock('../src/services/access/actionAuthorizer.js', () => ({
  authorizeActionV2: (...args: unknown[]) => state.authorize(...args),
}))

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const runId = '55555555-5555-4555-8555-555555555555'
const recipeNamespace = 'sandbox-recipes'
const recipeName = 'resume-me'
const teamId = '44444444-4444-4444-8444-444444444444'

function resumeAuthority(pathKind: 'direct' | 'team' = 'direct'): WorkflowAuthorityBinding {
  const target = { runId, action: 'resume' }
  return workflowAuthorityBindingFromClaims({
    typ: 'user_delegation',
    ver: 2,
    sub: userId,
    sid,
    sv: 3,
    jti: '33333333-3333-4333-8333-333333333333',
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    operationIds: ['workflow.run.manage'],
    scopes: ['workflow.run.manage'],
    resource: {
      environmentId: 'local',
      type: 'workflow_run',
      canonicalId: `workflow_run:local:${runId}`,
      logicalId: runId,
      displayName: runId,
    },
    targets: { 'workflow.run.manage': target },
    targetHashes: { 'workflow.run.manage': `ath2_${'a'.repeat(43)}` },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind,
    effectiveTeamId: pathKind === 'team' ? teamId : null,
  } as never)
}

/** The paused run as a team path initiated it, with its team attribution. */
function teamPathRows(): Record<string, unknown[]> {
  const rows = pausedRunRows()
  rows['lock-run'] = [
    {
      ...(rows['lock-run']?.[0] as Record<string, unknown>),
      team_id: teamId,
      usage_team_id: teamId,
      initiating_path_kind: 'team',
      initiating_effective_team_id: teamId,
    },
  ]
  rows['lineage-team-membership'] = [{ role: 'member' }]
  rows['lineage-team-grant'] = [{ team_id: teamId }]
  return rows
}

function pausedRunRows(): Record<string, unknown[]> {
  return {
    'statement-timeout': [{}],
    'lock-run': [
      {
        run_id: runId,
        recipe_namespace: recipeNamespace,
        recipe_name: recipeName,
        phase: 'AuthorizationPaused',
        actor_type: 'user',
        actor_id: userId,
        team_id: null,
        usage_team_id: null,
        initiating_authority_binding_id: 'initiating-binding',
        initiating_user_id: userId,
        initiating_session_id: sid,
        initiating_session_version: 3,
        initiating_operation_id: 'workflow.trigger',
        initiating_resource: {
          type: 'workflow_recipe',
          logicalId: `${recipeNamespace}/${recipeName}`,
        },
        initiating_target: { recipeNamespace, recipeName },
        initiating_path_kind: 'direct',
        initiating_effective_team_id: null,
        initiating_source_is_current: true,
        initiating_source_expires_at: new Date(Date.now() + 60_000).toISOString(),
        started_at: '2026-11-08T00:00:00.000Z',
        child_recipe_name: 'child-1',
      },
    ],
    'lineage-session': [{ id: userId }],
    'lineage-direct-grant': [{ user_id: userId }],
    'insert-binding': [{ id: 'continuation-binding' }],
    'bound-expiry': [{ current: true }],
    'resume-run': [{ run_id: runId, phase: 'Running' }],
  }
}

beforeEach(() => {
  state.log = []
  state.rows = pausedRunRows()
  state.authorize.mockReset().mockResolvedValue({
    status: 'allowed',
    context: {
      accessPathId: `ap1_${'b'.repeat(43)}`,
      authorizationRevision: `ar1_${'c'.repeat(43)}`,
      behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
      targetHash: `ath2_${'a'.repeat(43)}`,
      pathKind: 'direct',
      effectiveTeamId: null,
    },
  })
})

describe('workflow run resume service (T-W3)', () => {
  it('resumes under the locked Postgres lineage without an in-transaction resolver', async () => {
    const row = await resumeWorkflowRun({
      runId,
      recipeNamespace,
      recipeName,
      authority: resumeAuthority(),
    })

    // Witness: the lineage query locked the session and the grant, and the
    // run left AuthorizationPaused.
    expect(row).toMatchObject({ run_id: runId, phase: 'Running' })
    expect(state.log).toEqual([
      'BEGIN',
      'statement-timeout',
      'lock-run',
      'lineage-session',
      'lineage-direct-grant',
      'insert-binding',
      'bound-expiry',
      'resume-run',
      'COMMIT',
    ])
    expect(state.authorize).toHaveBeenCalledTimes(0)
  })

  it('still rejects a grant revoked before the resume transaction locks it', async () => {
    state.rows['lineage-direct-grant'] = []

    await expect(
      resumeWorkflowRun({ runId, recipeNamespace, recipeName, authority: resumeAuthority() })
    ).rejects.toMatchObject({ status: 403, code: 'workflow_run_path_mismatch' })

    // Witness: the grant lineage read ran inside the transaction.
    expect(state.log.filter(entry => entry === 'lineage-direct-grant')).toHaveLength(1)
    expect(state.log).not.toContain('resume-run')
    expect(state.log).not.toContain('insert-binding')
    expect(state.log.at(-1)).toBe('ROLLBACK')
    expect(state.authorize).toHaveBeenCalledTimes(0)
  })

  it('locks the team membership before the team grant on a team-path resume', async () => {
    state.rows = teamPathRows()

    const row = await resumeWorkflowRun({
      runId,
      recipeNamespace,
      recipeName,
      authority: resumeAuthority('team'),
    })

    expect(row).toMatchObject({ run_id: runId, phase: 'Running' })
    expect(state.log).toEqual([
      'BEGIN',
      'statement-timeout',
      'lock-run',
      'lineage-session',
      'lineage-team-membership',
      'lineage-team-grant',
      'insert-binding',
      'bound-expiry',
      'resume-run',
      'COMMIT',
    ])
    expect(state.authorize).toHaveBeenCalledTimes(0)
  })

  it('rejects a team-path resume whose membership is no longer active, before the grant read', async () => {
    state.rows = teamPathRows()
    state.rows['lineage-team-membership'] = []

    await expect(
      resumeWorkflowRun({ runId, recipeNamespace, recipeName, authority: resumeAuthority('team') })
    ).rejects.toMatchObject({ status: 403, code: 'workflow_run_path_mismatch' })

    // Witness: the membership read ran once inside the transaction.
    expect(state.log.filter(entry => entry === 'lineage-team-membership')).toHaveLength(1)
    expect(state.log).not.toContain('lineage-team-grant')
    expect(state.log).not.toContain('insert-binding')
    expect(state.log).not.toContain('resume-run')
    expect(state.log.at(-1)).toBe('ROLLBACK')
  })
})
