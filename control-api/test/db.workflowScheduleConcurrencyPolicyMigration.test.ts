import { describe, expect, it, vi } from 'vitest'

// Mock pg exactly like the other db.*.test.ts specs so importing ../src/db.js
// does not spin up a real Pool as a module side effect.
vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0129_workflow_schedules_concurrency_policy'

type QueryResult = { rows: unknown[]; rowCount: number }

function recordingQuery(appliedVersions: string[]) {
  return vi.fn(
    async (sql: string): Promise<QueryResult> =>
      sql.includes('SELECT version FROM schema_migrations')
        ? {
            rows: appliedVersions.map(version => ({ version })),
            rowCount: appliedVersions.length,
          }
        : { rows: [], rowCount: 0 }
  )
}

describe('0129_workflow_schedules_concurrency_policy migration', () => {
  it('is registered after the baseline and after 0128_password_work_ownership', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const baseline = versions.indexOf('0001_control_api_baseline')
    const previous = versions.indexOf('0128_password_work_ownership')
    const current = versions.indexOf(VERSION)
    expect(baseline).toBeGreaterThanOrEqual(0)
    expect(previous).toBeGreaterThan(baseline)
    expect(current).toBeGreaterThan(previous)
  })

  it('adds a NOT NULL concurrency_policy column defaulting to Forbid with a named CHECK', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === VERSION)
    expect(migration).toBeDefined()
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await migration!.apply({ query })

    expect(query).toHaveBeenCalledTimes(1)
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('ALTER TABLE workflow_schedules')
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS concurrency_policy TEXT NOT NULL DEFAULT 'Forbid'"
    )
    expect(sql).toContain('CONSTRAINT workflow_schedules_concurrency_policy_check')
    expect(sql).toContain("CHECK (concurrency_policy IN ('Forbid', 'Replace', 'Allow'))")
    expect(sql).not.toMatch(/CREATE TABLE|DROP |UPDATE workflow_schedules/)
    // Bounded lock wait, reset before the next pending migration in the shared
    // transaction (precedent: reconcilePluginWorkloadSdkRuntimeContracts).
    expect(sql.indexOf("SET LOCAL lock_timeout = '60s'")).toBeLessThan(
      sql.indexOf('ALTER TABLE workflow_schedules')
    )
    expect(sql.indexOf("SET LOCAL lock_timeout = '0'")).toBeGreaterThan(
      sql.indexOf('CHECK (concurrency_policy')
    )
  })

  it('is idempotent: one guarded ADD COLUMN and no standalone ADD CONSTRAINT', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === VERSION)
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await migration!.apply({ query })
    await migration!.apply({ query })

    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[1]?.[0])).toBe(String(query.mock.calls[0]?.[0]))
    // The CHECK is part of the column definition, so `IF NOT EXISTS` skips it
    // together with the column on a re-run. A standalone `ADD CONSTRAINT`
    // would fail with "already exists" the second time.
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/ADD CONSTRAINT/)
  })

  it('initDb applies it exactly once on a cluster that recorded every earlier migration', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const earlier = CONTROL_API_MIGRATIONS.map(migration => migration.version).filter(
      version => version !== VERSION
    )
    const query = recordingQuery(earlier)
    const release = vi.fn()

    await initDb({ connect: vi.fn().mockResolvedValue({ query, release }) } as never)

    const sqls = query.mock.calls.map(([sql]) => String(sql))
    expect(sqls.filter(sql => sql.includes('concurrency_policy'))).toHaveLength(1)
    expect(sqls).not.toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_schedules')
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      [VERSION]
    )
    expect(release).toHaveBeenCalledOnce()
  })

  it('initDb does not re-run it once recorded', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const query = recordingQuery(CONTROL_API_MIGRATIONS.map(migration => migration.version))
    const release = vi.fn()

    await initDb({ connect: vi.fn().mockResolvedValue({ query, release }) } as never)

    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContainEqual(
      expect.stringContaining('concurrency_policy')
    )
  })
})
