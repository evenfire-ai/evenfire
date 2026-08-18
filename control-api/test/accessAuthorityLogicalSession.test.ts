import { describe, expect, it, vi } from 'vitest'
import { loadPrincipalAuthoritySnapshot } from '../src/services/access/accessAuthorityStore.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const userId = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000002'
const currentJti = '30000000-0000-4000-8000-000000000003'
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'default/chatllm',
})

type StoredSession = Readonly<{
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
) {
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    const representationJti = values[3]
    const requestedVersion = values[4]
    const logicalCheckpoint = values[10] === true
    const sessionLive =
      requestedVersion === stored.version &&
      !stored.revoked &&
      stored.idleCurrent &&
      stored.absoluteCurrent &&
      (logicalCheckpoint || representationJti === stored.currentJti)
    expect(sql).toContain('s.revoked_at IS NULL')
    expect(sql).toContain('s.idle_expires_at > NOW()')
    expect(sql).toContain('s.absolute_expires_at > NOW()')
    expect(sql).toContain('s.session_version = $5')
    expect(sql).toContain('$11::boolean')
    return {
      rows: [
        {
          user_id: userId,
          user_revision: '1',
          resource_revision: '1',
          session_live: sessionLive,
          session_revision: `${stored.version}:${stored.currentJti}`,
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
      resource,
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
    expect(values[10]).toBe(true)
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
    expect(wrong.values[10]).toBe(false)
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
