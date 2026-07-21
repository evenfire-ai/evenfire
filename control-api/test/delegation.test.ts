import { describe, expect, it } from 'vitest'
import { canDelegate } from '../src/gfs/delegation.js'
import type { GrantsDb } from '../src/routes/gfs/grants.js'

/**
 * P2-S04 — transitive delegation (CRITICAL security test). A delegation chain
 * operator → Ana → Ben → Carla must work, each sub-owner inheriting manage_acl
 * within its subtree, and NO hop may ever exceed the bits it was granted. Also
 * verifies P2-S02 integration: a team grant lets a team member delegate.
 *
 * Resource tree:  ENG (R1)  →  REPORTS (R2)  →  Q3 (R3)
 */

const R1 = '11111111-1111-1111-1111-111111111111' // /eng
const R2 = '22222222-2222-2222-2222-222222222222' // /eng/reports
const R3 = '33333333-3333-3333-3333-333333333333' // /eng/reports/q3

interface GrantRow {
  subject_type: string
  subject_id: string
  resource_id: string
  permissions: string[]
  inherit: boolean
}

const ANCESTORS: Record<string, string[]> = {
  [R1]: [R1],
  [R2]: [R2, R1],
  [R3]: [R3, R2, R1],
}

// The grants each hop has created so far (the delegation chain state).
const CHAIN: GrantRow[] = [
  // operator → Ana on /eng  (Layer-1 seed): read, write, manage_acl, inherit
  {
    subject_type: 'user',
    subject_id: 'ana',
    resource_id: R1,
    permissions: ['read', 'write', 'manage_acl'],
    inherit: true,
  },
  // Ana → Ben on /eng/reports: read, manage_acl (NOT write), inherit
  {
    subject_type: 'user',
    subject_id: 'ben',
    resource_id: R2,
    permissions: ['read', 'manage_acl'],
    inherit: true,
  },
  // Ben → Carla on /eng/reports/q3: read, manage_acl, inherit
  {
    subject_type: 'user',
    subject_id: 'carla',
    resource_id: R3,
    permissions: ['read', 'manage_acl'],
    inherit: true,
  },
  // A team grant on /eng for team t1: read, manage_acl, inherit
  {
    subject_type: 'team',
    subject_id: 't1',
    resource_id: R1,
    permissions: ['read', 'manage_acl'],
    inherit: true,
  },
]

function mockDb(opts?: { teams?: Record<string, string[]>; grants?: GrantRow[] }): GrantsDb {
  const grants = opts?.grants ?? CHAIN
  const teams = opts?.teams ?? {}
  return {
    async query(text: string, values?: unknown[]) {
      if (text.includes('FROM team_members')) {
        const userId = String(values?.[0] ?? '')
        return { rows: (teams[userId] ?? []).map(team_id => ({ team_id })) }
      }
      if (text.includes('authority_grants AS') && text.includes('authority_shares AS')) {
        const rid = String(values?.[1] ?? '')
        const subjectTypes = (values?.[2] as string[]) ?? []
        const subjectIds = (values?.[3] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return {
          rows: [
            {
              ancestors: ANCESTORS[rid] ?? [],
              grants: grants.filter(g => wanted.has(`${g.subject_type}:${g.subject_id ?? ''}`)),
              shares: [],
            },
          ],
        }
      }
      if (text.includes('WITH RECURSIVE chain')) {
        const rid = String(values?.[1] ?? '')
        return { rows: (ANCESTORS[rid] ?? []).map(resource_id => ({ resource_id })) }
      }
      if (text.includes('FROM gfs_grants')) {
        // Faithfully model the real query, which filters by the caller's
        // subjects in SQL via independent subject_type/subject_id predicates:
        // return only the rows whose subject key is in the requested set.
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return { rows: grants.filter(g => wanted.has(`${g.subject_type}:${g.subject_id ?? ''}`)) }
      }
      if (text.includes('FROM gfs_shares')) {
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
}

const user = (id: string) => ({ type: 'user' as const, id })

describe('transitive delegation chain (operator → Ana → Ben → Carla)', () => {
  it('hop 1: Ana (granted via operator) may delegate read on a child folder', async () => {
    expect(await canDelegate(mockDb(), user('ana'), 'main', R2, ['read'], user('t'))).toBe(true)
  })

  it('hop 2: Ben (granted via Ana) may delegate read deeper — transitive manage_acl', async () => {
    expect(await canDelegate(mockDb(), user('ben'), 'main', R3, ['read'], user('t'))).toBe(true)
  })

  it('hop 3: Carla (granted via Ben) may delegate read on her folder', async () => {
    expect(await canDelegate(mockDb(), user('carla'), 'main', R3, ['read'], user('t'))).toBe(true)
  })
})

describe('no-escalation across the chain', () => {
  it('Ana cannot delegate a bit she was never granted (delete)', async () => {
    expect(await canDelegate(mockDb(), user('ana'), 'main', R2, ['delete'], user('t'))).toBe(false)
  })

  it('Ben cannot delegate write — Ana only gave him read+manage_acl', async () => {
    // operator gave Ana write, but Ana did NOT pass write to Ben → Ben cannot escalate.
    expect(await canDelegate(mockDb(), user('ben'), 'main', R3, ['write'], user('t'))).toBe(false)
  })

  it('a principal outside the chain cannot delegate at all', async () => {
    expect(await canDelegate(mockDb(), user('dana'), 'main', R3, ['read'], user('t'))).toBe(false)
  })

  it('a sub-owner cannot make an agent (host) a manager', async () => {
    expect(
      await canDelegate(mockDb(), user('carla'), 'main', R3, ['manage_acl'], {
        type: 'host',
        id: 'h1',
      })
    ).toBe(false)
  })
})

describe('team-grant delegation (P2-S02 integration)', () => {
  it('a member of a team that holds manage_acl may delegate on the team grant', async () => {
    const db = mockDb({ teams: { eve: ['t1'] } })
    expect(await canDelegate(db, user('eve'), 'main', R2, ['read'], user('t'))).toBe(true)
  })

  it('a non-member cannot delegate on the team grant', async () => {
    const db = mockDb({ teams: { eve: ['t1'] } })
    // frank is in no team → only his own (absent) grants apply.
    expect(await canDelegate(db, user('frank'), 'main', R2, ['read'], user('t'))).toBe(false)
  })

  it('a member cannot escalate beyond the team grant bits (no write)', async () => {
    const db = mockDb({ teams: { eve: ['t1'] } })
    expect(await canDelegate(db, user('eve'), 'main', R2, ['write'], user('t'))).toBe(false)
  })
})
