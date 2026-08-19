import { describe, expect, it } from 'vitest'
import type { GfsCaller, GrantsDb } from '../src/routes/gfs/grants.js'
import {
  type ResourcePatch,
  ResourcePatchError,
  applyResourcePatch,
} from '../src/routes/gfs/resources.js'

const FILE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SRC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const DEST = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const DEST_OTHER_DRIVE = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const DEST_FILE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const DIR = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
interface ResRow {
  resource_id: string
  drive: string
  parent_resource_id: string | null
  name: string
  kind: string
  version: number
  deleted_at: string | null
}
interface GrantRow {
  subject_type: string
  subject_id: string
  resource_id: string
  permissions: string[]
  inherit: boolean
}

const RESOURCES: Record<string, ResRow> = {
  [FILE]: {
    resource_id: FILE,
    drive: 'main',
    parent_resource_id: SRC,
    name: 'a.md',
    kind: 'file',
    version: 2,
    deleted_at: null,
  },
  [SRC]: {
    resource_id: SRC,
    drive: 'main',
    parent_resource_id: null,
    name: 'src',
    kind: 'directory',
    version: 0,
    deleted_at: null,
  },
  [DEST]: {
    resource_id: DEST,
    drive: 'main',
    parent_resource_id: null,
    name: 'dest',
    kind: 'directory',
    version: 0,
    deleted_at: null,
  },
  [DEST_OTHER_DRIVE]: {
    resource_id: DEST_OTHER_DRIVE,
    drive: 'other',
    parent_resource_id: null,
    name: 'x',
    kind: 'directory',
    version: 0,
    deleted_at: null,
  },
  [DEST_FILE]: {
    resource_id: DEST_FILE,
    drive: 'main',
    parent_resource_id: SRC,
    name: 'f.md',
    kind: 'file',
    version: 0,
    deleted_at: null,
  },
  [DIR]: {
    resource_id: DIR,
    drive: 'main',
    parent_resource_id: SRC,
    name: 'd',
    kind: 'directory',
    version: 0,
    deleted_at: null,
  },
}

function mockDb(opts?: {
  grants?: GrantRow[]
  update?: 'ok' | 'empty' | 'conflict'
  afterLock?: (resources: Record<string, ResRow>) => void
}): GrantsDb & { queries: { text: string; values?: unknown[] }[] } {
  const grants = opts?.grants ?? []
  const resources = Object.fromEntries(
    Object.entries(RESOURCES).map(([id, row]) => [id, { ...row }])
  ) as Record<string, ResRow>
  const queries: { text: string; values?: unknown[] }[] = []
  return {
    queries,
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values })
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('resource_id = ANY($1::uuid[])')) {
        opts?.afterLock?.(resources)
        return { rows: [] }
      }
      if (text.includes('WITH RECURSIVE chain')) {
        const rows: Array<ResRow & { cycle: boolean }> = []
        const visited = new Set<string>()
        const idIndex = text.includes('0 AS depth') ? 1 : 0
        let rid: string | null = String(values?.[idIndex] ?? '')
        while (rid && resources[rid]) {
          const row = resources[rid]
          const cycle = visited.has(rid)
          rows.push({ ...row, cycle })
          if (cycle) break
          visited.add(rid)
          rid = row.parent_resource_id
        }
        return { rows }
      }
      if (text.includes('WITH RECURSIVE subtree') && text.includes('canonical_path')) {
        return {
          rows: [
            {
              expected_count: '1',
              updated_count: '1',
              canonical_count: '1',
              distinct_path_count: '1',
              has_cycle: false,
            },
          ],
        }
      }
      if (text.includes('FROM gfs_resources') && text.includes('SELECT')) {
        const rid = String(values?.[0] ?? '')
        const row = resources[rid]
        return { rows: row ? [{ ...row }] : [] }
      }
      if (text.includes('FROM gfs_grants')) return { rows: grants }
      if (text.includes('FROM gfs_shares')) return { rows: [] }
      if (text.includes('UPDATE gfs_resources')) {
        if (opts?.update === 'conflict') throw Object.assign(new Error('dup'), { code: '23505' })
        if (opts?.update === 'empty') return { rows: [] }
        return { rows: [{ version: 3 }] }
      }
      return { rows: [] }
    },
  }
}
const operator: GfsCaller = {
  isOperator: true,
  subjects: new Set(['operator:']),
  actorKey: 'operator:',
}
function user(id: string): GfsCaller {
  return { isOperator: false, subjects: new Set([`user:${id}`]), actorKey: `user:${id}` }
}
const grant = (subjectId: string, resourceId: string, ...permissions: string[]): GrantRow => ({
  subject_type: 'user',
  subject_id: subjectId,
  resource_id: resourceId,
  permissions,
  inherit: true,
})
async function patch(
  db: GrantsDb,
  caller: GfsCaller,
  id: string,
  body: ResourcePatch
): Promise<{ version: number; audited: unknown[] }> {
  const audited: unknown[] = []
  const { version } = await applyResourcePatch(db, caller, 'main', id, body, async p => {
    audited.push(p)
  })
  return { version, audited }
}

describe('applyResourcePatch — rename', () => {
  it('operator renames (intrinsic), bumps version, audits', async () => {
    const out = await patch(mockDb(), operator, FILE, { newName: 'b.md' })
    expect(out.version).toBe(3)
    expect(out.audited).toHaveLength(1)
  })

  it('a user holding write on the resource may rename', async () => {
    const db = mockDb({ grants: [grant('owner', FILE, 'write')] })
    const out = await patch(db, user('owner'), FILE, { newName: 'b.md' })
    expect(out.version).toBe(3)
  })

  it('a user without write is forbidden', async () => {
    const db = mockDb({ grants: [grant('owner', FILE, 'read')] })
    await expect(patch(db, user('owner'), FILE, { newName: 'b.md' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
  })

  it('rejects an invalid name', async () => {
    await expect(patch(mockDb(), operator, FILE, { newName: 'a/b' })).rejects.toMatchObject({
      status: 400,
      code: 'path_invalid',
    })
  })
})

describe('applyResourcePatch — move', () => {
  it('operator moves into a same-drive directory', async () => {
    const out = await patch(mockDb(), operator, FILE, { newParentId: DEST })
    expect(out.version).toBe(3)
    expect(out.audited).toHaveLength(1)
  })

  it('forbids a cross-drive move (cross_boundary)', async () => {
    await expect(
      patch(mockDb(), operator, FILE, { newParentId: DEST_OTHER_DRIVE })
    ).rejects.toMatchObject({
      status: 403,
      code: 'cross_boundary',
    })
  })

  it('rejects moving into a non-directory', async () => {
    await expect(patch(mockDb(), operator, FILE, { newParentId: DEST_FILE })).rejects.toMatchObject(
      {
        status: 400,
        code: 'not_a_directory',
      }
    )
  })

  it('a user needs write+delete on src parent AND write on dest parent', async () => {
    const db = mockDb({ grants: [grant('mover', SRC, 'write', 'delete')] })
    await expect(patch(db, user('mover'), FILE, { newParentId: DEST })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
  })

  it('a user with all three op grants may move', async () => {
    const db = mockDb({
      grants: [grant('mover', SRC, 'write', 'delete'), grant('mover', DEST, 'write')],
    })
    const out = await patch(db, user('mover'), FILE, { newParentId: DEST })
    expect(out.version).toBe(3)
  })
})

describe('applyResourcePatch — concurrency + guards', () => {
  it('a stale If-Match is precondition_failed', async () => {
    await expect(
      patch(mockDb(), operator, FILE, { newName: 'b.md', ifMatch: 1 })
    ).rejects.toMatchObject({
      status: 412,
      code: 'precondition_failed',
    })
  })

  it('a matching If-Match passes', async () => {
    const out = await patch(mockDb(), operator, FILE, { newName: 'b.md', ifMatch: 2 })
    expect(out.version).toBe(3)
  })

  it('rejects a source version change observed while acquiring row locks', async () => {
    const db = mockDb({ afterLock: resources => (resources[FILE].version += 1) })
    await expect(patch(db, operator, FILE, { newName: 'b.md' })).rejects.toMatchObject({
      status: 412,
      code: 'precondition_failed',
    })
  })

  it('rejects destination live/kind/parent/version changes while acquiring row locks', async () => {
    const mutations = [
      (r: Record<string, ResRow>) => (r[DEST].version += 1),
      (r: Record<string, ResRow>) => (r[DEST].kind = 'file'),
      (r: Record<string, ResRow>) => (r[DEST].parent_resource_id = SRC),
      (r: Record<string, ResRow>) => (r[DEST].deleted_at = '2026-07-17'),
    ]
    for (const afterLock of mutations) {
      await expect(
        patch(mockDb({ afterLock }), operator, FILE, { newParentId: DEST })
      ).rejects.toMatchObject({
        status: 412,
        code: 'precondition_failed',
      })
    }
  })

  it('a sibling-name collision is already_exists', async () => {
    await expect(
      patch(mockDb({ update: 'conflict' }), operator, FILE, { newParentId: DEST })
    ).rejects.toMatchObject({
      status: 409,
      code: 'already_exists',
    })
  })

  it('takes the drive advisory lock before deterministic row locks', async () => {
    const db = mockDb()
    await patch(db, operator, FILE, { newParentId: DEST })
    const advisory = db.queries.findIndex(query => query.text.includes('pg_advisory_xact_lock'))
    const rows = db.queries.findIndex(
      query => query.text.includes('ORDER BY resource_id') && query.text.includes('FOR UPDATE')
    )
    expect(advisory).toBeGreaterThanOrEqual(0)
    expect(rows).toBeGreaterThan(advisory)
    expect(db.queries[rows].values?.[0]).toEqual([FILE, SRC, DEST].sort())
  })

  it('fails closed when the source parent is tombstoned while rows are acquired', async () => {
    const db = mockDb({ afterLock: resources => (resources[SRC].deleted_at = '2026-07-17') })
    await expect(patch(db, operator, FILE, { newName: 'b.md' })).rejects.toMatchObject({
      status: 412,
      code: 'precondition_failed',
    })
  })

  it('recomputes the complete subtree path from parent/name rather than replacing text', async () => {
    const db = mockDb()
    await patch(db, operator, DIR, { newName: 'renamed' })
    const refresh = db.queries.find(query => query.text.includes('WITH RECURSIVE subtree'))
    expect(refresh?.text).toContain("parent.canonical_path || '/' || child.name")
    expect(refresh?.text).toContain('UPDATE gfs_resources resource')
    expect(refresh?.text.toLowerCase()).not.toContain('replace(')
    expect(refresh?.values).toEqual(['main', DIR, '/renamed'])
  })

  it('a no-op patch is path_invalid', async () => {
    await expect(patch(mockDb(), operator, FILE, {})).rejects.toBeInstanceOf(ResourcePatchError)
  })

  it('a missing resource is not_found', async () => {
    await expect(
      patch(mockDb(), operator, '00000000-0000-0000-0000-000000000000', { newName: 'b.md' })
    ).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })
})

describe('applyResourcePatch — security guards (review findings)', () => {
  it('forbids moving a directory into itself (cycle guard)', async () => {
    await expect(patch(mockDb(), operator, DIR, { newParentId: DIR })).rejects.toMatchObject({
      status: 400,
      code: 'path_invalid',
    })
  })

  it('audits the denial when a non-operator is forbidden', async () => {
    const db = mockDb({ grants: [grant('owner', FILE, 'read')] })
    const audited: Array<{ outcome?: string }> = []
    await expect(
      applyResourcePatch(db, user('owner'), 'main', FILE, { newName: 'b.md' }, async p => {
        audited.push(p)
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(audited).toHaveLength(1)
    expect(audited[0].outcome).toBe('denied')
  })
})
