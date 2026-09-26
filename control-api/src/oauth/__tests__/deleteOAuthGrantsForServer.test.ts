import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../../db.js'
import { deleteOAuthGrantsForServer } from '../store.js'

/**
 * Server-teardown purge (H-3, DEC-R2; fenced by cr_uid in R3-H5): delete EVERY
 * oauth_grants row of ONE McpServer installation, across all flavors. This unit
 * layer pins the SQL contract — scope, the cr_uid fence, and the absence of any
 * per-flavor narrowing that would leave grants behind. The T4 observable-list
 * behavior (which rows survived) is pinned in the real-Postgres suites
 * (oauth.deleteOAuthGrantsForServer / oauth.mcpServerOAuthTeardown).
 */
describe('deleteOAuthGrantsForServer — full server-scoped wipe (fenced by cr_uid)', () => {
  const COORDS = { recipeNamespace: 'mcp-servers', recipeName: 'gdrive', crUid: 'uid-abc' }

  function fakeDb(rowCount: number | null) {
    const query = vi.fn(async () => ({ rowCount, rows: [] }))
    return { db: { query } as unknown as DbClient, query }
  }

  it('issues exactly one DELETE scoped to owner_kind=mcpserver + ns + name, all-flavors, fenced by cr_uid', async () => {
    const { db, query } = fakeDb(3)

    await deleteOAuthGrantsForServer(db, COORDS)

    expect(query).toHaveBeenCalledTimes(1)
    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('DELETE FROM oauth_grants')
    // Scope: server-owned rows only, keyed by the server coordinate.
    expect(sql).toContain("owner_kind = 'mcpserver'")
    expect(sql).toContain('recipe_namespace = $1')
    expect(sql).toContain('recipe_name = $2')
    // Fenced: this installation's uid OR a legacy (NULL) row — never another uid's.
    expect(sql).toContain('cr_uid = $3 OR cr_uid IS NULL')
    // All-flavors wipe: NONE of these narrowings may appear, or grants survive.
    expect(sql).not.toContain('user_id')
    expect(sql).not.toContain('context_id')
    expect(sql).not.toContain('oauth_client_id')
    expect(sql).not.toContain('grant_kind')
  })

  it('binds params to exactly [recipeNamespace, recipeName, crUid]', async () => {
    const { db, query } = fakeDb(3)

    await deleteOAuthGrantsForServer(db, COORDS)

    expect(query.mock.calls[0][1]).toEqual(['mcp-servers', 'gdrive', 'uid-abc'])
  })

  it('returns the deleted row count', async () => {
    const { db } = fakeDb(3)
    expect(await deleteOAuthGrantsForServer(db, COORDS)).toBe(3)
  })

  it('returns 0 when the driver reports a null rowCount (idempotent, nothing purged)', async () => {
    const { db } = fakeDb(null)
    expect(await deleteOAuthGrantsForServer(db, COORDS)).toBe(0)
  })
})
