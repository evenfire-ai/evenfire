import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../../db.js'
import { deleteOAuthGrantsForServer } from '../store.js'

/**
 * Server-teardown purge (H-3, DEC-R2): delete EVERY oauth_grants row owned by one
 * McpServer, across all flavors. The SQL scoping IS the testable contract at this
 * layer — the service has no real-DB store harness (dynamicClientStore.ts and
 * cleanupDynamicClientForServer are likewise untested), so a T4 observable-list
 * assertion (which rows survived) is not achievable here. What we CAN pin is that
 * the emitted DELETE is scoped to owner_kind='mcpserver' + the server coordinate
 * and carries NO per-flavor narrowing that would leave grants behind.
 */
describe('deleteOAuthGrantsForServer — full server-scoped wipe', () => {
  const COORDS = { recipeNamespace: 'mcp-servers', recipeName: 'gdrive' }

  function fakeDb(rowCount: number | null) {
    const query = vi.fn(async () => ({ rowCount, rows: [] }))
    return { db: { query } as unknown as DbClient, query }
  }

  it('issues exactly one DELETE scoped to owner_kind=mcpserver + ns + name, all-flavors', async () => {
    const { db, query } = fakeDb(3)

    await deleteOAuthGrantsForServer(db, COORDS)

    expect(query).toHaveBeenCalledTimes(1)
    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('DELETE FROM oauth_grants')
    // Scope: server-owned rows only, keyed by the server coordinate.
    expect(sql).toContain("owner_kind = 'mcpserver'")
    expect(sql).toContain('recipe_namespace = $1')
    expect(sql).toContain('recipe_name = $2')
    // All-flavors wipe: NONE of these narrowings may appear, or grants survive.
    expect(sql).not.toContain('user_id')
    expect(sql).not.toContain('context_id')
    expect(sql).not.toContain('oauth_client_id')
    expect(sql).not.toContain('grant_kind')
  })

  it('binds params to exactly [recipeNamespace, recipeName]', async () => {
    const { db, query } = fakeDb(3)

    await deleteOAuthGrantsForServer(db, COORDS)

    expect(query.mock.calls[0][1]).toEqual(['mcp-servers', 'gdrive'])
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
