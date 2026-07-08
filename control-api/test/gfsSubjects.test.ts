import { describe, expect, it } from 'vitest'
import {
  isOperatorId,
  type Principal,
  resolvePrincipalSubjects,
  resolveSubjectMembers,
  type SubjectsDb,
  subjectKey,
} from '../src/gfs/subjects.js'

/**
 * Unit tests for gfs subject resolution (P2-S02). Acceptance: a team grant
 * authorizes each member (a member's resolved subject set contains the team
 * key); operator/team never appear as a token sub (the Principal type admits
 * only user/host).
 */

function mockDb(handler: (text: string, values?: unknown[]) => unknown[]): {
  db: SubjectsDb
  queries: string[]
} {
  const queries: string[] = []
  return {
    queries,
    db: {
      async query(text: string, values?: unknown[]) {
        queries.push(text)
        return { rows: handler(text, values) }
      },
    },
  }
}

describe('subjectKey', () => {
  it('renders operator with an empty id and user/team with their id', () => {
    expect(subjectKey({ type: 'operator' })).toBe('operator:')
    expect(subjectKey({ type: 'user', id: 'u1' })).toBe('user:u1')
    expect(subjectKey({ type: 'team', id: 't1' })).toBe('team:t1')
  })
})

describe('resolvePrincipalSubjects', () => {
  it('expands a user to itself plus every active team it belongs to', async () => {
    const { db } = mockDb((text) =>
      text.includes('FROM team_members') ? [{ team_id: 't1' }, { team_id: 't2' }] : []
    )
    const subjects = await resolvePrincipalSubjects(db, { type: 'user', id: 'u1' })
    expect(subjects).toEqual(new Set(['user:u1', 'team:t1', 'team:t2']))
  })

  it('filters team membership to active rows (deny-by-default on soft-deleted)', async () => {
    const { db, queries } = mockDb(() => [])
    await resolvePrincipalSubjects(db, { type: 'user', id: 'u1' })
    expect(queries.some((q) => q.includes('team_members') && q.includes("status = 'active'"))).toBe(true)
  })

  it('a host resolves to only its own key (context bindings are P3)', async () => {
    const { db, queries } = mockDb(() => [])
    const subjects = await resolvePrincipalSubjects(db, { type: 'host', id: 'mcp-host/standalone' })
    expect(subjects).toEqual(new Set(['host:mcp-host/standalone']))
    expect(queries).toHaveLength(0)
  })

  it('only user/host are valid principals (operator/team can never be a token sub)', () => {
    // Compile-time guarantee: the Principal type admits only user/host. These
    // assignments must type-check; operator/team would be a type error.
    const u: Principal = { type: 'user', id: 'u1' }
    const h: Principal = { type: 'host', id: 'h1' }
    expect(u.type === 'user' && h.type === 'host').toBe(true)
  })
})

describe('resolveSubjectMembers', () => {
  it('expands a team to its active member user ids', async () => {
    const { db } = mockDb((text) =>
      text.includes('FROM team_members') ? [{ user_id: 'a' }, { user_id: 'b' }] : []
    )
    expect(await resolveSubjectMembers(db, { type: 'team', id: 't1' })).toEqual(['a', 'b'])
  })

  it('expands operator to all active admin ids', async () => {
    const { db } = mockDb((text) =>
      text.includes('control_admin_users') ? [{ id: 'admin1' }] : []
    )
    expect(await resolveSubjectMembers(db, { type: 'operator' })).toEqual(['admin1'])
  })

  it('expands user to itself and host/context to nothing', async () => {
    const { db } = mockDb(() => [])
    expect(await resolveSubjectMembers(db, { type: 'user', id: 'u1' })).toEqual(['u1'])
    expect(await resolveSubjectMembers(db, { type: 'host', id: 'h1' })).toEqual([])
    expect(await resolveSubjectMembers(db, { type: 'context', id: 'c1' })).toEqual([])
  })
})

describe('isOperatorId', () => {
  it('is true when an active control admin row exists, false otherwise', async () => {
    const present = mockDb(() => [{ '?column?': 1 }])
    expect(await isOperatorId(present.db, 'admin1')).toBe(true)
    const absent = mockDb(() => [])
    expect(await isOperatorId(absent.db, 'nope')).toBe(false)
  })
})
