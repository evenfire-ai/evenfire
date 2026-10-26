import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('invitation expiration migration history', () => {
  it('does not register transient TTL migrations beyond the current dev schema', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    expect(versions).not.toContain('0130_invitation_expiration_ttl_one_week')
    expect(versions).not.toContain('0131_invitation_expiration_writer_compatibility')
    expect(versions.at(-1)).toBe('0129_workflow_schedules_concurrency_policy')
  })
})
