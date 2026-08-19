import { describe, expect, it, vi } from 'vitest'
import { CONTROL_API_MIGRATIONS, assertDbReady } from '../src/db.js'

const LATEST_MIGRATION = CONTROL_API_MIGRATIONS.at(-1)!.version

describe('assertDbReady', () => {
  it('accepts a database migrated through the authoritative GFS runtime role contract', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: true }], rowCount: 1 })

    await expect(assertDbReady({ query })).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'), [
      LATEST_MIGRATION,
    ])
  })

  it('fails closed when the migration job has not applied the required schema', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }], rowCount: 1 })

    await expect(assertDbReady({ query })).rejects.toThrow(
      `migration ${LATEST_MIGRATION} is required`
    )
  })
})
