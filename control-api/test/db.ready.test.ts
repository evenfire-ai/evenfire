import { describe, expect, it, vi } from 'vitest'
import { CONTROL_API_MIGRATIONS, assertDbReady } from '../src/db.js'

const LATEST_MIGRATION = CONTROL_API_MIGRATIONS.at(-1)!.version
const CODEX_ACCOUNT_ID_MIGRATION = '00a4_codex_chatgpt_account_id'

describe('assertDbReady', () => {
  it('accepts a database that recorded every registered migration', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: CONTROL_API_MIGRATIONS.map(migration => ({ version: migration.version })),
      rowCount: CONTROL_API_MIGRATIONS.length,
    })

    await expect(assertDbReady({ query })).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'))
  })

  it('fails closed when the latest migration is absent', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: CONTROL_API_MIGRATIONS.filter(migration => migration.version !== LATEST_MIGRATION).map(
        migration => ({ version: migration.version })
      ),
      rowCount: CONTROL_API_MIGRATIONS.length - 1,
    })

    await expect(assertDbReady({ query })).rejects.toThrow(`missing migrations ${LATEST_MIGRATION}`)
  })

  it('fails closed when an inserted Codex migration is absent after a later version landed', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: CONTROL_API_MIGRATIONS.filter(
        migration => migration.version !== CODEX_ACCOUNT_ID_MIGRATION
      ).map(migration => ({ version: migration.version })),
      rowCount: CONTROL_API_MIGRATIONS.length - 1,
    })

    await expect(assertDbReady({ query })).rejects.toThrow(
      `missing migrations ${CODEX_ACCOUNT_ID_MIGRATION}`
    )
  })
})
