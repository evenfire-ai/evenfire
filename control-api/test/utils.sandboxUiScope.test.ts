import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { userHasUiBearingRecipeAccess } from '../src/utils/auth/sandboxUiScope.js'

type Recipe = { metadata: { name: string; namespace: string }; spec: Record<string, unknown> }

function makeGateway(recipes: Recipe[]): { gateway: K8sGateway; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => recipes)
  return { gateway: { listResource: spy } as unknown as K8sGateway, spy }
}

function makeDb(rowCount: number): { db: DbClient; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => ({ rows: [], rowCount }))
  return { db: { query: spy } as unknown as DbClient, spy }
}

describe('userHasUiBearingRecipeAccess', () => {
  const RECIPE_WITH_UI: Recipe = {
    metadata: { name: 'r-ui', namespace: 'sandbox-recipes' },
    spec: { ui: { workloadRef: 'web', port: 8080 } },
  }
  const RECIPE_NO_UI: Recipe = {
    metadata: { name: 'r-headless', namespace: 'sandbox-recipes' },
    spec: { workloads: [{ id: 'app', type: 'deployment', image: 'app:1' }] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when userId is empty', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI])
    const { db, spy } = makeDb(0)
    const ok = await userHasUiBearingRecipeAccess('', gateway, db)
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns false when no recipes carry a ui block', async () => {
    const { gateway } = makeGateway([RECIPE_NO_UI])
    const { db, spy } = makeDb(0)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db)
    expect(ok).toBe(false)
    // DB should NOT be queried — short-circuit on empty UI-bearing set.
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns false when DB shows no allowlist hit for the UI-bearing set', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI, RECIPE_NO_UI])
    const { db, spy } = makeDb(0)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db)
    expect(ok).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    const [, params] = spy.mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBe('u1')
    expect(params[1]).toBeNull()
    expect(params[2]).toEqual(['sandbox-recipes'])
    expect(params[3]).toEqual(['r-ui'])
  })

  it('returns true when DB shows the user is allowlisted on a UI-bearing recipe', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI, RECIPE_NO_UI])
    const { db } = makeDb(1)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db)
    expect(ok).toBe(true)
  })

  it('includes active current-team trigger grants when deciding whether to grant sandbox UI scope', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI])
    const { db, spy } = makeDb(1)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db, 'team-1')
    expect(ok).toBe(true)
    const [sql, params] = spy.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('team_workflow_triggers')
    expect(String(sql)).toContain('$2::uuid IS NOT NULL')
    expect(String(sql)).toContain('tm.team_id = $2::uuid')
    expect(String(sql)).not.toMatch(/\$2\s+IS\s+NOT\s+NULL/)
    expect(String(sql)).not.toMatch(/tm\.team_id\s*=\s*\$2(?!::uuid)/)
    expect(String(sql)).toContain("tm.status = 'active'")
    expect(params).toEqual(['u1', 'team-1', ['sandbox-recipes'], ['r-ui']])
  })

  it('keeps the current-team parameter typed even when no team is present', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI])
    const { db, spy } = makeDb(0)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db, null)
    expect(ok).toBe(false)
    const [sql, params] = spy.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('$2::uuid IS NOT NULL')
    expect(String(sql)).toContain('tm.team_id = $2::uuid')
    expect(String(sql)).not.toMatch(/\$2\s+IS\s+NOT\s+NULL/)
    expect(String(sql)).not.toMatch(/tm\.team_id\s*=\s*\$2(?!::uuid)/)
    expect(params[1]).toBeNull()
  })

  it('passes only UI-bearing recipes to the DB intersection', async () => {
    const RECIPE_WITH_UI_2: Recipe = {
      metadata: { name: 'r-ui-2', namespace: 'sandbox-recipes' },
      spec: { ui: { workloadRef: 'app', port: 9090 } },
    }
    const { gateway } = makeGateway([RECIPE_WITH_UI, RECIPE_NO_UI, RECIPE_WITH_UI_2])
    const { db, spy } = makeDb(0)
    await userHasUiBearingRecipeAccess('u1', gateway, db)
    const [, params] = spy.mock.calls[0] as [string, unknown[]]
    // r-headless is filtered out — only r-ui and r-ui-2 reach the query.
    expect(params[2]).toEqual(['sandbox-recipes', 'sandbox-recipes'])
    expect(params[3]).toEqual(['r-ui', 'r-ui-2'])
  })

  it('returns false (does not throw) when listResource rejects', async () => {
    const gateway = {
      listResource: vi.fn(async () => {
        throw new Error('k8s API down')
      }),
    } as unknown as K8sGateway
    const { db, spy } = makeDb(1)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db)
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns false (does not throw) when listResource returns a non-array', async () => {
    const gateway = {
      listResource: vi.fn(async () => undefined),
    } as unknown as K8sGateway
    const { db } = makeDb(1)
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db)
    expect(ok).toBe(false)
  })

  it('returns false (does not throw) when DB query rejects', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI])
    const db = {
      query: vi.fn(async () => {
        throw new Error('db unavailable')
      }),
    } as unknown as DbClient
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db)
    expect(ok).toBe(false)
  })

  it('fails closed when a malformed current-team id trips the uuid cast', async () => {
    const { gateway } = makeGateway([RECIPE_WITH_UI])
    const query = vi.fn(async () => {
      const err = new Error('invalid input syntax for type uuid') as Error & { code: string }
      err.code = '22P02'
      throw err
    })
    const db = {
      query,
    } as unknown as DbClient
    const ok = await userHasUiBearingRecipeAccess('u1', gateway, db, 'not-a-uuid')
    expect(ok).toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('$2::uuid IS NOT NULL')
    expect(String(sql)).toContain('tm.team_id = $2::uuid')
    expect(params[1]).toBe('not-a-uuid')
  })

  it('skips recipes missing metadata.name or metadata.namespace defensively', async () => {
    const broken: Recipe = {
      metadata: { name: '', namespace: 'sandbox-recipes' },
      spec: { ui: { workloadRef: 'app', port: 8080 } },
    } as Recipe
    const { gateway } = makeGateway([broken, RECIPE_WITH_UI])
    const { db, spy } = makeDb(0)
    await userHasUiBearingRecipeAccess('u1', gateway, db)
    const [, params] = spy.mock.calls[0] as [string, unknown[]]
    expect(params[3]).toEqual(['r-ui']) // broken recipe filtered out
  })
})
