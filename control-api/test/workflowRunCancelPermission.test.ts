import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { WorkflowRunRow } from '../src/services/workflowRunService.js'
import {
  type ApprovalScopedWorkflowRunRow,
  type UserRunScope,
  canCancel,
  runMatchesUserScope,
} from '../src/services/workflows/workflowRunReadService.js'

// S20: every run `canCancel` accepts is a run the caller can already see, so a
// cancel never reaches a run that the run read hides.

const USERS = ['user-a', 'user-b', 'user-c'] as const
const TEAMS = ['team-1', 'team-2'] as const
/** The stored principal form of each user (the trigger producers store it). */
const PRINCIPAL = {
  'user-a': '0a0a0a0a-0000-4000-8000-00000000000a',
  'user-b': '0b0b0b0b-0000-4000-8000-00000000000b',
  'user-c': '0c0c0c0c-0000-4000-8000-00000000000c',
} as const

const optional = <T>(values: readonly T[]) => fc.constantFrom<T | null>(null, ...values)
const actorIds = optional([...USERS, ...Object.values(PRINCIPAL), 'mcp-host-principal'])

const rowArbitrary = fc.record({
  actor_type: fc.constantFrom<WorkflowRunRow['actor_type']>(
    'user',
    'admin',
    'autonomous',
    'scheduled'
  ),
  actor_id: actorIds,
  team_id: optional(TEAMS),
  usage_team_id: optional(TEAMS),
  approval_request_id: optional(['00000000-0000-4000-8000-000000000001']),
  approval_target_user_id: actorIds,
  approval_target_team_id: optional(TEAMS),
  approval_target_team_member_user_id: optional(USERS),
})

const scopeArbitrary = fc.record({ user: fc.constantFrom(...USERS), teamId: optional(TEAMS) }).map(
  ({ user, teamId }): UserRunScope => ({
    userId: user,
    principalIds: [user, PRINCIPAL[user]],
    teamId,
  })
)

type GeneratedRow = typeof rowArbitrary extends fc.Arbitrary<infer T> ? T : never

function asRunRow(row: GeneratedRow): ApprovalScopedWorkflowRunRow {
  // Both predicates read only these columns of the run row.
  return row as unknown as ApprovalScopedWorkflowRunRow
}

type Branch = 'launcher' | 'admin-team-run' | 'admin-null-actor' | 'refused'

function branchOf(row: GeneratedRow, scope: UserRunScope, liveAdmin: boolean): Branch {
  if (!canCancel(row, scope, liveAdmin)) return 'refused'
  if (row.actor_type === 'user' && row.actor_id && scope.principalIds.includes(row.actor_id)) {
    return 'launcher'
  }
  return row.actor_type === 'user' ? 'admin-null-actor' : 'admin-team-run'
}

describe('workflow run cancel permission', () => {
  it('canCancel implies runMatchesUserScope', () => {
    const seen: Record<Branch, number> = {
      launcher: 0,
      'admin-team-run': 0,
      'admin-null-actor': 0,
      refused: 0,
    }
    fc.assert(
      fc.property(rowArbitrary, scopeArbitrary, fc.boolean(), (row, scope, liveAdmin) => {
        const branch = branchOf(row, scope, liveAdmin)
        seen[branch] += 1
        if (branch !== 'refused') {
          expect(runMatchesUserScope(asRunRow(row), scope)).toBe(true)
        }
      }),
      { numRuns: 5_000, seed: 20_261_126 }
    )
    // Liveness: each accepting branch of canCancel was generated, so the
    // implication was checked on all of them, and refusals were generated too.
    expect(seen.launcher).toBeGreaterThan(0)
    expect(seen['admin-team-run']).toBeGreaterThan(0)
    expect(seen['admin-null-actor']).toBeGreaterThan(0)
    expect(seen.refused).toBeGreaterThan(0)
  })

  it.each([
    {
      name: 'launcher, stored principal form, no team',
      row: {
        actor_type: 'user',
        actor_id: PRINCIPAL['user-a'],
        team_id: null,
        usage_team_id: null,
      },
      scope: { userId: 'user-a', principalIds: ['user-a', PRINCIPAL['user-a']], teamId: null },
      liveAdmin: false,
      expected: true,
    },
    {
      name: 'live admin, scheduled run of the scope team',
      row: { actor_type: 'scheduled', actor_id: null, team_id: 'team-1', usage_team_id: 'team-1' },
      scope: { userId: 'user-b', principalIds: ['user-b', PRINCIPAL['user-b']], teamId: 'team-1' },
      liveAdmin: true,
      expected: true,
    },
    {
      name: 'live admin, user run with a NULL actor id in the scope team',
      row: { actor_type: 'user', actor_id: null, team_id: 'team-1', usage_team_id: 'team-1' },
      scope: { userId: 'user-b', principalIds: ['user-b', PRINCIPAL['user-b']], teamId: 'team-1' },
      liveAdmin: true,
      expected: true,
    },
    {
      name: "live admin, a teammate's manual run",
      row: { actor_type: 'user', actor_id: 'user-c', team_id: 'team-1', usage_team_id: 'team-1' },
      scope: { userId: 'user-b', principalIds: ['user-b', PRINCIPAL['user-b']], teamId: 'team-1' },
      liveAdmin: true,
      expected: false,
    },
    {
      name: 'member who is not a live admin, scheduled run of the scope team',
      row: { actor_type: 'scheduled', actor_id: null, team_id: 'team-1', usage_team_id: 'team-1' },
      scope: { userId: 'user-b', principalIds: ['user-b', PRINCIPAL['user-b']], teamId: 'team-1' },
      liveAdmin: false,
      expected: false,
    },
    {
      name: 'live admin, run launched from the admin UI',
      row: { actor_type: 'admin', actor_id: null, team_id: 'team-1', usage_team_id: 'team-1' },
      scope: { userId: 'user-b', principalIds: ['user-b', PRINCIPAL['user-b']], teamId: 'team-1' },
      liveAdmin: true,
      expected: false,
    },
  ] as const)('$name', ({ row, scope, liveAdmin, expected }) => {
    expect(canCancel(row, scope, liveAdmin)).toBe(expected)
    if (expected) {
      expect(runMatchesUserScope(row as unknown as ApprovalScopedWorkflowRunRow, scope)).toBe(true)
    }
  })
})
