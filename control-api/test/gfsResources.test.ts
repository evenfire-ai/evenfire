import { describe, expect, it } from 'vitest'
import {
  applyResourcePatch,
  ResourcePatchError,
  type ResourcePatch,
} from '../src/routes/gfs/resources.js'
import type { GfsCaller, GrantsDb } from '../src/routes/gfs/grants.js'

/**
 * P2-S05 — move/rename write path (control-api half). Drives applyResourcePatch
 * with a fake GrantsDb. Acceptance: rename → write on the resource; move →
 * write+delete on src parent + write on dest parent; cross-drive → cross_boundary;
 * stale If-Match → precondition_failed; no escalation (a caller without the bit
 * is forbidden).
 */

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
}
interface GrantRow {
  subject_type: string
  subject_id: string
  resource_id: string
  permissions: string[]
  inherit: boolean
}

const RESOURCES: Record<string, ResRow> = {
  [FILE]: { resource_id: FILE, drive: 'main', parent_resource_id: SRC, name: 'a.md', kind: 'file', version: 2 },
  [SRC]: { resource_id: SRC, drive: 'main', parent_resource_id: null, name: 'src', kind: 'directory', version: 0 },
  [DEST]: { resource_id: DEST, drive: 'main', parent_resource_id: null, name: 'dest', kind: 'directory', version: 0 },
  [DEST_OTHER_DRIVE]: { resource_id: DEST_OTHER_DRIVE, drive: 'other', parent_resource_id: null, name: 'x', kind: 'directory', version: 0 },
  [DEST_FILE]: { resource_id: DEST_FILE, drive: 'main', parent_resource_id: SRC, name: 'f.md', kind: 'file', version: 0 },
  [DIR]: { resource_id: DIR, drive: 'main', parent_resource_id: SRC, name: 'd', kind: 'directory', version: 0 },
}

function mockDb(opts?: { grants?: GrantRow[]; update?: 'ok' | 'empty' | 'conflict' }): GrantsDb {
  const grants = opts?.grants ?? []
  return {
    async query(text: string, values?: unknown[]) {
      // WITH RECURSIVE also contains "FROM gfs_resources"+"SELECT" — match it first.
      if (text.includes('WITH RECURSIVE chain')) {
        const rid = String(values?.[1] ?? '')
        // self only — direct grants on the resource itself suffice for the tests.
        return { rows: [{ resource_id: rid }] }
      }
      if (text.includes('FROM gfs_resources') && text.includes('SELECT')) {
        const rid = String(values?.[0] ?? '')
        const row = RESOURCES[rid]
        return { rows: row ? [row] : [] }
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

const operator: GfsCaller = { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' }
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
  const { version } = await applyResourcePatch(db, caller, 'main', id, body, async (p) => {
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
    await expect(patch(mockDb(), operator, FILE, { newParentId: DEST_OTHER_DRIVE })).rejects.toMatchObject({
      status: 403,
      code: 'cross_boundary',
    })
  })

  it('rejects moving into a non-directory', async () => {
    await expect(patch(mockDb(), operator, FILE, { newParentId: DEST_FILE })).rejects.toMatchObject({
      status: 400,
      code: 'not_a_directory',
    })
  })

  it('a user needs write+delete on src parent AND write on dest parent', async () => {
    // holds write+delete on SRC but NOT write on DEST → forbidden.
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
    await expect(patch(mockDb(), operator, FILE, { newName: 'b.md', ifMatch: 1 })).rejects.toMatchObject({
      status: 412,
      code: 'precondition_failed',
    })
  })

  it('a matching If-Match passes', async () => {
    const out = await patch(mockDb(), operator, FILE, { newName: 'b.md', ifMatch: 2 })
    expect(out.version).toBe(3)
  })

  it('a concurrent version bump (no rows updated) is precondition_failed', async () => {
    await expect(patch(mockDb({ update: 'empty' }), operator, FILE, { newName: 'b.md' })).rejects.toMatchObject({
      status: 412,
    })
  })

  it('a sibling-name collision is already_exists', async () => {
    await expect(patch(mockDb({ update: 'conflict' }), operator, FILE, { newParentId: DEST })).rejects.toMatchObject({
      status: 409,
      code: 'already_exists',
    })
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
    // DIR is a directory; moving it into itself must be rejected, not a no-op.
    await expect(patch(mockDb(), operator, DIR, { newParentId: DIR })).rejects.toMatchObject({
      status: 400,
      code: 'path_invalid',
    })
  })

  it('audits the denial when a non-operator is forbidden', async () => {
    const db = mockDb({ grants: [grant('owner', FILE, 'read')] }) // no write
    const audited: Array<{ outcome?: string }> = []
    await expect(
      applyResourcePatch(db, user('owner'), 'main', FILE, { newName: 'b.md' }, async (p) => {
        audited.push(p)
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(audited).toHaveLength(1)
    expect(audited[0].outcome).toBe('denied')
  })
})
