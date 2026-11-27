import { describe, expect, it, vi } from 'vitest'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { loadPrincipalAuthoritySnapshot } from '../src/services/access/principalAuthoritySnapshot.js'

const userId = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000002'
const currentJti = '30000000-0000-4000-8000-000000000003'

type StoredSession = Readonly<{
  userActive?: boolean
  version: number
  revoked: boolean
  idleCurrent: boolean
  absoluteCurrent: boolean
  currentJti: string
}>

async function snapshot(
  stored: StoredSession,
  session:
    | Readonly<{ contract: 'v2'; userId: string; sid: string; jti: string; sessionVersion: number }>
    | Readonly<{
        contract: 'v2'
        authorityMode: 'logical_session_checkpoint'
        userId: string
        sid: string
        sessionVersion: number
      }>
    | Readonly<{
        contract: 'v2'
        authorityMode: 'user_grant_continuation'
        userId: string
        sid: string
        sessionVersion: number
      }>
) {
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    const representationJti = values[3]
    const requestedVersion = values[4]
    const logicalCheckpoint = values[5] === true
    const userAnchored = values[6] === true
    // Model of the CASE order: lifecycle first, then the user-anchored mode,
    // then the session row.
    const sessionLive =
      stored.userActive !== false &&
      (userAnchored ||
        (requestedVersion === stored.version &&
          !stored.revoked &&
          stored.idleCurrent &&
          stored.absoluteCurrent &&
          (logicalCheckpoint || representationJti === stored.currentJti)))
    expect(sql).toContain('s.revoked_at IS NULL')
    expect(sql).toContain('s.idle_expires_at > NOW()')
    expect(sql).toContain('s.absolute_expires_at > NOW()')
    expect(sql).toContain('s.session_version = $5')
    expect(sql).toContain('$6::boolean')
    expect(sql).toContain('WHEN $7::boolean THEN TRUE')
    expect(sql).toContain("WHEN $7::boolean THEN 'user_grant_continuation'")
    // M-22: the snapshot reads no revision counter table.
    expect(sql).not.toContain('authorization_')
    expect(values).toHaveLength(7)
    return {
      rows: [
        {
          user_id: userId,
          session_live: sessionLive,
          session_revision: userAnchored
            ? 'user_grant_continuation'
            : `${stored.version}:${stored.currentJti}`,
          memberships: [],
        },
      ],
      rowCount: 1,
    }
  })
  const budget = AccessExecutionBudget.create('action')
  try {
    const result = await loadPrincipalAuthoritySnapshot({
      db: { query } as never,
      budget,
      session,
    })
    return { result, values: query.mock.calls[0][1] as unknown[] }
  } finally {
    budget.close()
  }
}

const live = Object.freeze({
  version: 4,
  revoked: false,
  idleCurrent: true,
  absoluteCurrent: true,
  currentJti,
})

function logical(version = live.version) {
  return Object.freeze({
    contract: 'v2' as const,
    authorityMode: 'logical_session_checkpoint' as const,
    userId,
    sid,
    sessionVersion: version,
  })
}

describe('logical-session checkpoint authority', () => {
  it.each([
    ['revoked', { ...live, revoked: true }],
    ['idle expired', { ...live, idleCurrent: false }],
    ['absolute expired', { ...live, absoluteCurrent: false }],
  ] as const)('denies a %s logical session', async (_label, stored) => {
    const { result, values } = await snapshot(stored, logical())
    expect(result?.sessionLive).toBe(false)
    expect(values[5]).toBe(true)
    expect(values[3]).toBeNull()
  })

  it('denies a logical checkpoint with a stale session version', async () => {
    const { result } = await snapshot(live, logical(live.version - 1))
    expect(result?.sessionLive).toBe(false)
  })

  it('allows the live logical session while retaining current JTI in its revision', async () => {
    const { result } = await snapshot(live, logical())
    expect(result).toMatchObject({
      sessionLive: true,
      sessionRevision: `${live.version}:${currentJti}`,
    })
  })

  it('keeps ordinary representation authentication bound to its JTI', async () => {
    const wrong = await snapshot(live, {
      contract: 'v2',
      userId,
      sid,
      jti: '40000000-0000-4000-8000-000000000004',
      sessionVersion: live.version,
    })
    expect(wrong.result?.sessionLive).toBe(false)
    expect(wrong.values[5]).toBe(false)
    expect(wrong.values[3]).not.toBeNull()

    const current = await snapshot(live, {
      contract: 'v2',
      userId,
      sid,
      jti: currentJti,
      sessionVersion: live.version,
    })
    expect(current.result?.sessionLive).toBe(true)
  })
})

const rotated = Object.freeze({
  ...live,
  version: live.version + 1,
  currentJti: '50000000-0000-4000-8000-000000000005',
})

function userAnchoredSession(version = live.version) {
  return Object.freeze({
    contract: 'v2' as const,
    authorityMode: 'user_grant_continuation' as const,
    userId,
    sid,
    sessionVersion: version,
  })
}

describe('user-anchored workflow continuation authority', () => {
  it.each([
    ['live', live],
    ['revoked', { ...live, revoked: true }],
    ['idle expired', { ...live, idleCurrent: false }],
    ['absolute expired', { ...live, absoluteCurrent: false }],
    ['rotated', rotated],
  ] as const)(
    'answers an active user as live whatever the state of a %s login session',
    async (_label, stored) => {
      const { result, values } = await snapshot(stored, userAnchoredSession())
      expect(result).toMatchObject({
        userId,
        sessionContract: 'v2',
        sessionLive: true,
        sessionRevision: 'user_grant_continuation',
      })
      // The mode selector is set and the logical-session selector is not.
      expect(values[6]).toBe(true)
      expect(values[5]).toBe(false)
      // No session coordinate reaches the session subqueries, so no
      // external_user_sessions row can match.
      expect(values.slice(2, 5)).toEqual([null, null, null])
      expect(values.slice(0, 2)).toEqual([userId, 'v2'])
    }
  )

  it('denies the user-anchored mode for a user who is no longer active', async () => {
    const { result, values } = await snapshot({ ...live, userActive: false }, userAnchoredSession())
    expect(values[6]).toBe(true)
    expect(result?.sessionLive).toBe(false)
  })

  it('keeps the revision constant across session rotations', async () => {
    const before = await snapshot(live, userAnchoredSession())
    const after = await snapshot(rotated, userAnchoredSession())
    expect(before.result?.sessionRevision).toBe('user_grant_continuation')
    expect(after.result?.sessionRevision).toBe(before.result?.sessionRevision)
  })

  it('leaves the session-anchored modes off the user-anchored selector', async () => {
    const logicalRun = await snapshot(live, logical())
    expect(logicalRun.values[6]).toBe(false)
    expect(logicalRun.values[5]).toBe(true)
    expect(logicalRun.values[2]).toBe(sid)
    const ordinary = await snapshot(live, {
      contract: 'v2',
      userId,
      sid,
      jti: currentJti,
      sessionVersion: live.version,
    })
    expect(ordinary.values[6]).toBe(false)
    expect(ordinary.values.slice(2, 5)).toEqual([sid, currentJti, live.version])
  })
})
