import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminRecipesRouter } from '../src/routes/admin/recipes.js'

interface MockRecipe {
  metadata: { name: string; namespace: string }
  status?: { phase?: string }
}

function createGateway(recipes: MockRecipe[]) {
  const map = new Map(recipes.map(r => [r.metadata.name, r]))
  return {
    getResource: vi.fn(async (_plural: string, name: string) => {
      const r = map.get(name)
      if (!r) {
        // Mirror resourceService.K8sNotFoundError shape used by the gateway.
        const err = Object.assign(new Error(`workflowrecipes/${name} not found`), {
          statusCode: 404,
        }) as Error & { statusCode: number }
        throw err
      }
      return r
    }),
    patchResourceStatus: vi.fn(
      async (
        _plural: string,
        name: string,
        statusPatch: Record<string, unknown>,
        _namespace?: string
      ) => {
        const r = map.get(name)
        if (r) r.status = { ...(r.status ?? {}), ...statusPatch }
        return r
      }
    ),
    // The route uses several other gateway methods that aren't exercised by
    // the retry endpoint; stub them out so the router constructs.
    listResource: vi.fn(async () => []),
    createResource: vi.fn(),
    updateResource: vi.fn(),
    deleteResource: vi.fn(),
  }
}

function makeApp(gateway: ReturnType<typeof createGateway>) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRecipesRouter(gateway as never))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

describe('POST /admin/recipes/:name/retry', () => {
  it('rejects 400 for an invalid recipe name', async () => {
    const app = makeApp(createGateway([]))
    const res = await request(app).post('/admin/recipes/Invalid_Name/retry').expect(400)
    expect(res.body.error).toMatch(/Invalid recipe name/)
  })

  it('returns 404 when the recipe does not exist', async () => {
    const app = makeApp(createGateway([]))
    await request(app).post('/admin/recipes/no-such-recipe/retry').expect(404)
  })

  it('rejects 409 when recipe is not in the failed phase', async () => {
    const gateway = createGateway([
      {
        metadata: { name: 'r', namespace: 'sandbox-recipes' },
        status: { phase: 'active' },
      },
    ])
    const res = await request(makeApp(gateway)).post('/admin/recipes/r/retry').expect(409)
    expect(res.body.error).toBe('invalid_transition')
    expect(res.body.message).toMatch(/"active"/)
    expect(gateway.patchResourceStatus).not.toHaveBeenCalled()
  })

  it('patches status.phase from failed to candidate on success', async () => {
    const gateway = createGateway([
      {
        metadata: { name: 'r', namespace: 'sandbox-recipes' },
        status: { phase: 'failed' },
      },
    ])
    const res = await request(makeApp(gateway)).post('/admin/recipes/r/retry').expect(200)
    expect(res.body).toEqual({ name: 'r', phase: 'candidate' })
    expect(gateway.patchResourceStatus).toHaveBeenCalledTimes(1)
    const [plural, name, statusPatch, ns] = gateway.patchResourceStatus.mock.calls[0]
    expect(plural).toBe('workflowrecipes')
    expect(name).toBe('r')
    expect(statusPatch).toMatchObject({ phase: 'candidate' })
    expect(typeof (statusPatch as { message?: string }).message).toBe('string')
    expect(ns).toBe('sandbox-recipes')
  })
})
