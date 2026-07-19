import { describe, expect, it, vi } from 'vitest'
import { assertDbReady } from '../src/db.js'

describe('assertDbReady', () => {
  it('accepts a database migrated through the authoritative approval step binding', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: true }], rowCount: 1 })

    await expect(assertDbReady({ query })).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'), [
      '0069_member_registration_runtime_access',
    ])
  })

  it('fails closed when the migration job has not applied the required schema', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }], rowCount: 1 })

    await expect(assertDbReady({ query })).rejects.toThrow(
      'migration 0069_member_registration_runtime_access is required'
    )
  })
})
