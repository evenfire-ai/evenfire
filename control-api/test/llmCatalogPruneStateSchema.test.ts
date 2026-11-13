import { describe, expect, it } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  applyLlmCatalogPruneColumnsSchema,
  applyLlmCatalogPruneStateSchema,
} from '../src/services/llmCatalogPruneStateSchema.js'

// The columns migration is the one PR1 transaction allowed to hold an
// AccessExclusiveLock on a pre-existing table (pr1MigrationLocks), and only
// because it is a single catalog-only ALTER TABLE. A backfill or a scan moved
// into it would take no new kind of lock, so the lock test cannot see it; it
// would only make every reader queue for longer. This pins the statement list.

function recordingDb(): { db: DbClient; statements: string[] } {
  const statements: string[] = []
  const db = {
    query: async (text: string) => {
      statements.push(text.replace(/\s+/g, ' ').trim())
      return { rows: [], rowCount: 0 }
    },
  } as unknown as DbClient
  return { db, statements }
}

describe('llm catalog prune state migrations', () => {
  it('the columns migration is a 2 s lock_timeout and one catalog-only ALTER TABLE', async () => {
    const { db, statements } = recordingDb()
    await applyLlmCatalogPruneColumnsSchema(db)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '2s'")
    const alter = statements[1]!
    expect(alter.startsWith('ALTER TABLE llm_allowed_models ADD COLUMN ')).toBe(true)
    const clauses = alter
      .replace(/^ALTER TABLE llm_allowed_models /, '')
      .replace(/;$/, '')
      .split(/, (?=ADD )/)
    expect(clauses).toHaveLength(7)
    const columns = clauses.slice(0, 6)
    expect(columns.every(c => c.startsWith('ADD COLUMN '))).toBe(true)
    // A constraint inside a column clause is validated on the spot, scanning
    // the table under the lock; only the NOT VALID clause below may add one.
    for (const column of columns) {
      expect(column).not.toMatch(/\b(CHECK|REFERENCES|UNIQUE|PRIMARY|GENERATED)\b/i)
    }
    expect(clauses[6]).toMatch(/^ADD CONSTRAINT \S+ CHECK \(.+\) NOT VALID$/)
    // Constant defaults only: a volatile default would rewrite the table.
    expect(alter).not.toMatch(/DEFAULT (now|clock_timestamp|gen_random_uuid|random)\(/i)
  })

  it('the state migration never drops the trigger nor alters the table beyond validating', async () => {
    const { db, statements } = recordingDb()
    await applyLlmCatalogPruneStateSchema(db)
    // The table lock is taken before any row is: asked for after the backfill,
    // it can deadlock with a writer of the previous image.
    // EXCLUSIVE: SHARE ROW EXCLUSIVE lets a PUT that already holds its row FOR
    // UPDATE reach its UPDATE after the migration locked rows.
    expect(statements[0]).toBe('LOCK TABLE llm_allowed_models IN EXCLUSIVE MODE')
    const all = statements.join('\n')
    expect(all).not.toMatch(/DROP TRIGGER/i)
    expect(all.match(/LOCK TABLE/gi)).toHaveLength(1)
    expect(all).toMatch(/CREATE OR REPLACE TRIGGER llm_allowed_models_track_episodes/)
    const alters = statements.filter(s => /ALTER TABLE llm_allowed_models\b/.test(s))
    expect(alters).toEqual([
      'ALTER TABLE llm_allowed_models VALIDATE CONSTRAINT llm_allowed_models_enabled_managed_by_check;',
    ])
  })
})
