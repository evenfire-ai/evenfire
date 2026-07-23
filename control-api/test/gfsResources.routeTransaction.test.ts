import { beforeEach, describe, expect, it, vi } from 'vitest'

const FILE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SRC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

const state = vi.hoisted(() => {
  const events: string[] = []
  const file = {
    resource_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    drive: 'main',
    parent_resource_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'a.md',
    kind: 'file',
    version: 2,
    deleted_at: null,
  }
  const source = {
    resource_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    drive: 'main',
    parent_resource_id: null,
    name: '',
    kind: 'directory',
    version: 0,
    deleted_at: null,
    cycle: false,
  }
  const other = {
    resource_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    drive: 'other',
    parent_resource_id: null,
    name: '',
    kind: 'directory',
    version: 0,
    deleted_at: null,
  }
  const db = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes('pg_advisory_xact_lock')) {
        events.push('advisory')
        return { rows: [] }
      }
      if (text.includes('ORDER BY resource_id') && text.includes('FOR UPDATE')) {
        events.push('row-locks')
        return { rows: [] }
      }
      if (text.includes('WITH RECURSIVE chain')) return { rows: [source] }
      if (text.includes('WITH RECURSIVE subtree')) {
        events.push('paths')
        return {
          rows: [
            {
              expected_count: '1',
              updated_count: state.failPaths ? '0' : '1',
              canonical_count: '1',
              distinct_path_count: '1',
              has_cycle: false,
            },
          ],
        }
      }
      if (text.includes('UPDATE gfs_resources')) {
        events.push('mutation')
        return { rows: [{ version: 3 }] }
      }
      if (text.includes('FROM gfs_resources')) {
        const id = String(values?.[0])
        return { rows: [id === source.resource_id ? source : id === other.resource_id ? other : file] }
      }
      return { rows: [] }
    }),
  }
  return { events, db, failPaths: false, operator: true, auditDb: undefined as unknown, audits: [] as unknown[] }
})

vi.mock('../src/db.js', () => ({
  withTransaction: vi.fn(async (work: (db: typeof state.db) => Promise<unknown>) => {
    state.events.push('begin')
    try {
      const result = await work(state.db)
      state.events.push('commit')
      return result
    } catch (error) {
      state.events.push('rollback')
      throw error
    }
  }),
}))

vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock('../src/routes/gfs/grants.js', () => ({
  UUID_RE: /^[0-9a-f-]{36}$/,
  resolveCaller: () => ({
    isOperator: state.operator,
    subjects: new Set([state.operator ? 'operator:' : 'user:blocked']),
    actorKey: state.operator ? 'operator:' : 'user:blocked',
  }),
  driveOf: (value: unknown) => String(value),
  requestIdOf: () => 'request-1',
  checkAccess: async () => state.operator,
  auditMutation: vi.fn(async (db: unknown, params: unknown) => {
    state.auditDb = db
    state.audits.push(params)
    state.events.push('audit')
  }),
}))

import { handlePatch } from '../src/routes/gfs/resources.js'

function response() {
  return {
    code: 0,
    body: undefined as unknown,
    status(code: number) {
      this.code = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
}

describe('gfs resource route transaction boundary', () => {
  beforeEach(() => {
    state.events.length = 0
    state.failPaths = false
    state.operator = true
    state.auditDb = undefined
    state.audits.length = 0
    state.db.query.mockClear()
  })

  it('commits mutation, path refresh, and audit through the same transaction client', async () => {
    const res = response()
    await handlePatch(
      { params: { id: FILE }, body: { newName: 'b.md' }, query: { drive: 'main' }, ip: '127.0.0.1' } as never,
      res as never
    )
    expect(res.code).toBe(200)
    expect(state.auditDb).toBe(state.db)
    expect(state.events).toEqual([
      'begin',
      'advisory',
      'row-locks',
      'mutation',
      'paths',
      'audit',
      'commit',
    ])
  })

  it('rolls back before the allowed audit when canonical path publication fails', async () => {
    state.failPaths = true
    const res = response()
    await handlePatch(
      { params: { id: FILE }, body: { newName: 'b.md' }, query: { drive: 'main' }, ip: '127.0.0.1' } as never,
      res as never
    )
    expect(res.code).toBe(412)
    expect(state.events).toContain('rollback')
    expect(state.events).not.toContain('audit')
    expect(state.events).not.toContain('commit')
  })

  it('commits an audited authorization denial without publishing a mutation', async () => {
    state.operator = false
    const res = response()
    await handlePatch(
      { params: { id: FILE }, body: { newName: 'b.md' }, query: { drive: 'main' }, ip: '127.0.0.1' } as never,
      res as never
    )
    expect(res.code).toBe(403)
    expect(state.events).toContain('audit')
    expect(state.events).toContain('commit')
    expect(state.events).not.toContain('mutation')
  })

  it('commits exactly one cross-boundary denial audit and no mutation', async () => {
    const res = response()
    await handlePatch(
      { params: { id: FILE }, body: { newParentId: OTHER }, query: { drive: 'main' }, ip: '127.0.0.1' } as never,
      res as never
    )
    expect(res.code).toBe(403)
    expect(res.body).toMatchObject({ error: { code: 'cross_boundary' } })
    expect(state.audits).toHaveLength(1)
    expect(state.events).toEqual(['begin', 'advisory', 'audit', 'commit'])
    expect(state.events).not.toContain('mutation')
  })
})
