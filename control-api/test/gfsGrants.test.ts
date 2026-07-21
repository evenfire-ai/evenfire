import { describe, expect, it } from 'vitest'
import {
  type GfsCaller,
  type GfsPermission,
  type GrantsDb,
  assertMayGrant,
  assertMayGrantBatch,
  auditMutation,
  normalizeMutationSubjects,
  subjectKey,
} from '../src/routes/gfs/grants.js'

/**
 * Unit tests for the gfs grant/share no-escalation engine (P2-S01). These
 * exercise the security invariant directly against assertMayGrant with an
 * injected fake GrantsDb — no HTTP, no real Postgres — mirroring the gfsc
 * permissionClient test style. Acceptance: escalation rejected; cross-subtree
 * rejected; operator intrinsic; agent never made a manager by a folder owner.
 */

interface MockGrant {
  subject_type: string
  subject_id: string
  resource_id: string
  permissions: string[]
  inherit: boolean
}
interface MockShare {
  subject_type: string
  subject_id: string
  resource_id: string
  permissions: string[]
  include_descendants: boolean
}
interface AuditRow {
  subject: string
  actor: string
  op: string
  gfsUri: string
  outcome: string
  rowHash: string
}
interface QueryCall {
  text: string
  values?: unknown[]
}

function mockDb(opts: {
  ancestors?: Record<string, string[]>
  grants?: MockGrant[]
  shares?: MockShare[]
  audit?: AuditRow[]
  auditSql?: string[]
  queries?: QueryCall[]
  rejectConcurrentQueries?: boolean
}): GrantsDb {
  let queryInFlight = false
  return {
    async query(text: string, values?: unknown[]) {
      if (opts.rejectConcurrentQueries && queryInFlight) {
        throw new Error('concurrent transaction query')
      }
      queryInFlight = true
      await Promise.resolve()
      opts.queries?.push({ text, values })
      const complete = <T>(result: T): T => {
        queryInFlight = false
        return result
      }
      if (text.includes('authority_grants AS') && text.includes('authority_shares AS')) {
        const rid = String(values?.[1] ?? '')
        const chain = opts.ancestors?.[rid] ?? []
        const subjectTypes = (values?.[2] as string[]) ?? []
        const subjectIds = (values?.[3] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return complete({
          rows: [
            {
              ancestors: chain,
              grants: (opts.grants ?? []).filter(grant =>
                wanted.has(`${grant.subject_type}:${grant.subject_id ?? ''}`)
              ),
              shares: (opts.shares ?? []).filter(share =>
                wanted.has(`${share.subject_type}:${share.subject_id ?? ''}`)
              ),
            },
          ],
        })
      }
      if (text.includes('WITH RECURSIVE chain')) {
        const rid = String(values?.[1] ?? '')
        const chain = opts.ancestors?.[rid] ?? []
        return complete({ rows: chain.map(resource_id => ({ resource_id })) })
      }
      if (text.includes('FROM gfs_grants')) {
        // Faithfully model the real SQL subject filter on subject_type +
        // subject_id: return only rows for the caller's subjects.
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return complete({
          rows: (opts.grants ?? []).filter(g =>
            wanted.has(`${g.subject_type}:${g.subject_id ?? ''}`)
          ),
        })
      }
      if (text.includes('FROM gfs_shares')) {
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return complete({
          rows: (opts.shares ?? []).filter(s =>
            wanted.has(`${s.subject_type}:${s.subject_id ?? ''}`)
          ),
        })
      }
      if (text.includes('INSERT INTO gfs_audit')) {
        opts.auditSql?.push(text)
        const v = values ?? []
        opts.audit?.push({
          subject: String(v[0]),
          actor: String(v[1]),
          op: String(v[2]),
          gfsUri: String(v[3]),
          outcome: String(v[4]),
          rowHash: String(v[7]),
        })
        return complete({ rows: [], rowCount: 1 })
      }
      return complete({ rows: [] })
    },
  }
}

const R = '11111111-1111-1111-1111-111111111111'
const PARENT = '22222222-2222-2222-2222-222222222222'
const OTHER = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'
const TEAM_ID = '55555555-5555-4555-8555-555555555555'

function indexedUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

const operator: GfsCaller = {
  isOperator: true,
  subjects: new Set(['operator:']),
  actorKey: 'operator:',
}
function user(id: string): GfsCaller {
  return { isOperator: false, subjects: new Set([`user:${id}`]), actorKey: `user:${id}` }
}

const perms = (...p: GfsPermission[]): GfsPermission[] => p

describe('normalizeMutationSubjects — singular/plural grant transport', () => {
  it('requires exactly one own property named subject or subjects', () => {
    for (const body of [
      {},
      { subject: { type: 'user', id: USER_ID }, subjects: [] },
      { subject: undefined, subjects: [{ type: 'user', id: USER_ID }] },
    ]) {
      expect(() => normalizeMutationSubjects(body, { isShare: false })).toThrowError(
        expect.objectContaining({
          status: 400,
          code: 'subjects_invalid',
        })
      )
    }
  })

  it('preserves every currently accepted singular grant subject type', () => {
    const singularSubjects = [
      { type: 'operator' },
      { type: 'user', id: USER_ID },
      { type: 'team', id: TEAM_ID },
      { type: 'host', id: '1st:mcp-host/standalone' },
      { type: 'context', id: 'sandbox-recipes' },
    ] as const

    for (const subject of singularSubjects) {
      expect(normalizeMutationSubjects({ subject }, { isShare: false })).toEqual([subject])
    }
  })

  it('accepts the inclusive 1-100 plural bounds', () => {
    expect(
      normalizeMutationSubjects(
        { subjects: [{ type: 'user', id: indexedUuid(1) }] },
        { isShare: false }
      )
    ).toHaveLength(1)

    expect(
      normalizeMutationSubjects(
        {
          subjects: Array.from({ length: 100 }, (_, index) => ({
            type: 'user',
            id: indexedUuid(index + 1),
          })),
        },
        { isShare: false }
      )
    ).toHaveLength(100)
  })

  it.each([
    { label: 'non-array', subjects: 'user' },
    { label: 'empty', subjects: [] },
    {
      label: 'oversized',
      subjects: Array.from({ length: 101 }, (_, index) => ({
        type: 'user',
        id: indexedUuid(index + 1),
      })),
    },
  ])('rejects a $label plural collection', ({ subjects }) => {
    expect(() => normalizeMutationSubjects({ subjects }, { isShare: false })).toThrowError(
      expect.objectContaining({ status: 400, code: 'subjects_invalid' })
    )
  })

  it('normalizes canonical user, team, first-party host, and third-party host targets in order', () => {
    const subjects = [
      { type: 'user', id: USER_ID },
      { type: 'team', id: TEAM_ID },
      { type: 'host', id: '1st:mcp-host/standalone' },
      { type: 'host', id: '3rd:sandbox-recipes/daily-report' },
    ]

    expect(normalizeMutationSubjects({ subjects }, { isShare: false })).toEqual(subjects)
  })

  it('canonicalizes uppercase user and team UUIDs before returning normalized subjects', () => {
    expect(
      normalizeMutationSubjects(
        {
          subjects: [
            { type: 'user', id: USER_ID.toUpperCase() },
            { type: 'team', id: TEAM_ID.toUpperCase() },
          ],
        },
        { isShare: false }
      )
    ).toEqual([
      { type: 'user', id: USER_ID },
      { type: 'team', id: TEAM_ID },
    ])
  })

  it('rejects a later mixed-case UUID duplicate by its stable plural index', () => {
    expect(() =>
      normalizeMutationSubjects(
        {
          subjects: [
            { type: 'user', id: USER_ID },
            { type: 'user', id: USER_ID.toUpperCase() },
          ],
        },
        { isShare: false }
      )
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'subjects_invalid',
        invalidIndexes: [1],
      })
    )
  })

  it.each([
    ['user only', [{ type: 'user', id: USER_ID }]],
    ['team only', [{ type: 'team', id: TEAM_ID }]],
    ['host only', [{ type: 'host', id: '1st:mcp-host/standalone' }]],
    [
      'user and team',
      [
        { type: 'user', id: USER_ID },
        { type: 'team', id: TEAM_ID },
      ],
    ],
    [
      'user and host',
      [
        { type: 'user', id: USER_ID },
        { type: 'host', id: '1st:mcp-host/standalone' },
      ],
    ],
    [
      'team and host',
      [
        { type: 'team', id: TEAM_ID },
        { type: 'host', id: '3rd:sandbox-recipes/daily-report' },
      ],
    ],
  ])('accepts the grant matrix for %s', (_label, subjects) => {
    expect(normalizeMutationSubjects({ subjects }, { isShare: false })).toEqual(subjects)
  })

  it('rejects malformed, singular-only, and later duplicate plural entries with stable indexes', () => {
    expect(() =>
      normalizeMutationSubjects(
        {
          subjects: [
            { type: 'user', id: USER_ID },
            { type: 'host', id: 'not-canonical' },
            { type: 'team', id: TEAM_ID },
            { type: 'user', id: USER_ID },
            { type: 'context', id: 'sandbox-recipes' },
            { type: 'operator' },
          ],
        },
        { isShare: false }
      )
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'subjects_invalid',
        invalidIndexes: [1, 3, 4, 5],
      })
    )
  })
})

describe('assertMayGrantBatch — common grant authorization', () => {
  it('loads one authority snapshot statement with the caller subjects in stable order', async () => {
    const queries: QueryCall[] = []
    const db = mockDb({
      queries,
      rejectConcurrentQueries: true,
      ancestors: { [R]: [R, PARENT] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'manage_acl'],
          inherit: true,
        },
      ],
      shares: [
        {
          subject_type: 'team',
          subject_id: 'owners',
          resource_id: R,
          permissions: ['write'],
          include_descendants: false,
        },
      ],
    })
    const owner: GfsCaller = {
      isOperator: false,
      subjects: new Set(['user:owner', 'team:owners']),
      actorKey: 'user:owner',
    }
    const targets = [
      { type: 'user', id: USER_ID },
      { type: 'team', id: TEAM_ID },
      { type: 'host', id: '1st:mcp-host/standalone' },
    ] as const

    await expect(
      assertMayGrantBatch(db, owner, 'main', R, perms('read', 'write'), targets, {
        isShare: false,
      })
    ).resolves.toBeUndefined()

    expect(queries).toHaveLength(1)
    expect(queries[0]?.text).toContain('WITH RECURSIVE chain AS')
    expect(queries[0]?.text).toContain('requested_subjects(subject_type, subject_id)')
    expect(queries[0]?.text).toContain('FROM gfs_grants')
    expect(queries[0]?.text).toContain('FROM gfs_shares')
    expect(queries[0]?.values).toEqual(['main', R, ['user', 'team'], ['owner', 'owners']])
  })

  it('keeps the existing operator host policy intact for bulk API grants', async () => {
    const db = mockDb({})
    await expect(
      assertMayGrantBatch(
        db,
        operator,
        'main',
        R,
        perms('read', 'write', 'delete', 'manage_acl', 'share'),
        [
          { type: 'host', id: '1st:mcp-host/standalone' },
          { type: 'host', id: '3rd:sandbox-recipes/daily-report' },
        ],
        { isShare: false }
      )
    ).resolves.toBeUndefined()
  })

  it('keeps the existing caller-dependent host restriction intact', async () => {
    const db = mockDb({})
    await expect(
      assertMayGrantBatch(
        db,
        user('owner'),
        'main',
        R,
        perms('manage_acl'),
        [{ type: 'host', id: '1st:mcp-host/standalone' }],
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'agent_manager_forbidden' })
  })
})

describe('assertMayGrant — operator intrinsic authority', () => {
  it('lets the operator grant any bit without a stored grant', async () => {
    const db = mockDb({})
    await expect(
      assertMayGrant(
        db,
        operator,
        'main',
        R,
        perms('read', 'write', 'manage_acl'),
        { type: 'user', id: 'u1' },
        {
          isShare: false,
        }
      )
    ).resolves.toBeUndefined()
  })
})

describe('assertMayGrant — no-escalation', () => {
  it('allows a folder owner to grant a subset of bits it holds on R', async () => {
    const db = mockDb({
      ancestors: { [R]: [R, PARENT] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'write', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'teammate' },
        { isShare: false }
      )
    ).resolves.toBeUndefined()
  })

  it('rejects granting a bit the grantor does not hold (escalation)', async () => {
    const db = mockDb({
      ancestors: { [R]: [R, PARENT] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'write', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('delete'),
        { type: 'user', id: 'teammate' },
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'escalation_rejected' })
  })

  it('rejects when the grantor holds manage_acl only on an unrelated subtree (cross-subtree)', async () => {
    const db = mockDb({
      ancestors: { [R]: [R, PARENT] },
      // grant is on OTHER (with inherit) but OTHER is not an ancestor of R.
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: OTHER,
          permissions: ['read', 'write', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'teammate' },
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'not_manager' })
  })

  it('does not distinguish a missing resource from an unauthorized grant write', async () => {
    const db = mockDb({})
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'teammate' },
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'not_manager' })
  })

  it('honors inherit:false — an ancestor grant does not authorize a descendant', async () => {
    const db = mockDb({
      ancestors: { [R]: [R, PARENT] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: PARENT,
          permissions: ['read', 'manage_acl'],
          inherit: false,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'teammate' },
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'not_manager' })
  })

  it('allows via an inheriting ancestor grant (subtree)', async () => {
    const db = mockDb({
      ancestors: { [R]: [R, PARENT] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: PARENT,
          permissions: ['read', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'teammate' },
        { isShare: false }
      )
    ).resolves.toBeUndefined()
  })
})

describe('assertMayGrant — agent (host) restrictions', () => {
  it('forbids a folder owner from granting to the intrinsic operator subject', async () => {
    const db = mockDb({
      ancestors: { [R]: [R] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'write', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'operator' },
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'operator_grant_forbidden' })
  })

  it('forbids a folder owner from making an agent a manager (manage_acl)', async () => {
    const db = mockDb({
      ancestors: { [R]: [R] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'write', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('manage_acl'),
        { type: 'host', id: '1st:mcp-host/standalone' },
        { isShare: false }
      )
    ).rejects.toMatchObject({ status: 403, code: 'agent_manager_forbidden' })
  })

  it('lets the operator grant write to an agent (allowed)', async () => {
    const db = mockDb({})
    await expect(
      assertMayGrant(
        db,
        operator,
        'main',
        R,
        perms('read', 'write'),
        { type: 'host', id: '1st:mcp-host/standalone' },
        { isShare: false }
      )
    ).resolves.toBeUndefined()
  })

  it('forbids sharing to an agent (share targets users/teams only)', async () => {
    const db = mockDb({
      ancestors: { [R]: [R] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'share'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'host', id: '1st:mcp-host/standalone' },
        { isShare: true }
      )
    ).rejects.toMatchObject({ status: 403, code: 'share_to_agent_forbidden' })
  })
})

describe('assertMayGrant — share authority bit', () => {
  it('rejects a share when the sharer lacks the share bit (not_sharer)', async () => {
    const db = mockDb({
      ancestors: { [R]: [R] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'write', 'manage_acl'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'dana' },
        { isShare: true }
      )
    ).rejects.toMatchObject({ status: 403, code: 'not_sharer' })
  })

  it('allows a share when the sharer holds share + the shared bit', async () => {
    const db = mockDb({
      ancestors: { [R]: [R] },
      grants: [
        {
          subject_type: 'user',
          subject_id: 'owner',
          resource_id: R,
          permissions: ['read', 'share'],
          inherit: true,
        },
      ],
    })
    await expect(
      assertMayGrant(
        db,
        user('owner'),
        'main',
        R,
        perms('read'),
        { type: 'user', id: 'dana' },
        { isShare: true }
      )
    ).resolves.toBeUndefined()
  })
})

describe('auditMutation', () => {
  it('writes one audit row with a content hash and the spec fields', async () => {
    const audit: AuditRow[] = []
    const auditSql: string[] = []
    const db = mockDb({ audit, auditSql })
    await auditMutation(db, {
      actorKey: 'operator:',
      targetKey: subjectKey({ type: 'user', id: 'u1' }),
      op: 'grant.put[read]',
      drive: 'main',
      resourceId: R,
      outcome: 'allowed',
      requestId: 'req-1',
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      subject: 'user:u1',
      actor: 'operator:',
      op: 'grant.put[read]',
      gfsUri: `gfs://main/${R}`,
      outcome: 'allowed',
    })
    expect(audit[0].rowHash).toMatch(/^[0-9a-f]{64}$/)
    expect(auditSql[0]).toContain('RETURNING sequence_no::text AS id')
  })
})
