import { describe, expect, it } from 'vitest'
import {
  type GfsCaller,
  type GfsPermission,
  type GrantsDb,
  assertMayGrant,
  auditMutation,
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

function mockDb(opts: {
  ancestors?: Record<string, string[]>
  grants?: MockGrant[]
  shares?: MockShare[]
  audit?: AuditRow[]
}): GrantsDb {
  return {
    async query(text: string, values?: unknown[]) {
      if (text.includes('WITH RECURSIVE chain')) {
        const rid = String(values?.[1] ?? '')
        const chain = opts.ancestors?.[rid] ?? []
        return { rows: chain.map(resource_id => ({ resource_id })) }
      }
      if (text.includes('FROM gfs_grants')) {
        // Faithfully model the real SQL subject filter on subject_type +
        // subject_id: return only rows for the caller's subjects.
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return {
          rows: (opts.grants ?? []).filter(g =>
            wanted.has(`${g.subject_type}:${g.subject_id ?? ''}`)
          ),
        }
      }
      if (text.includes('FROM gfs_shares')) {
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return {
          rows: (opts.shares ?? []).filter(s =>
            wanted.has(`${s.subject_type}:${s.subject_id ?? ''}`)
          ),
        }
      }
      if (text.includes('INSERT INTO gfs_audit')) {
        const v = values ?? []
        opts.audit?.push({
          subject: String(v[0]),
          actor: String(v[1]),
          op: String(v[2]),
          gfsUri: String(v[3]),
          outcome: String(v[4]),
          rowHash: String(v[7]),
        })
        return { rows: [], rowCount: 1 }
      }
      return { rows: [] }
    },
  }
}

const R = '11111111-1111-1111-1111-111111111111'
const PARENT = '22222222-2222-2222-2222-222222222222'
const OTHER = '33333333-3333-3333-3333-333333333333'

const operator: GfsCaller = {
  isOperator: true,
  subjects: new Set(['operator:']),
  actorKey: 'operator:',
}
function user(id: string): GfsCaller {
  return { isOperator: false, subjects: new Set([`user:${id}`]), actorKey: `user:${id}` }
}

const perms = (...p: GfsPermission[]): GfsPermission[] => p

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
    const db = mockDb({ audit })
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
  })
})
