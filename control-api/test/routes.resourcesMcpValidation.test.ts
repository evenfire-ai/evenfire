import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import { getEntryVersion, reportInstall } from '../src/services/registryClient.js'
import { MockGateway } from './mockGateway.js'

// ── Mock the registry client ─────────────────────────────────────────────────
vi.mock('../src/services/registryClient.js', () => ({
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  getEntryVersion: vi.fn(),
  getCredentialSchema: vi.fn(),
  getCategories: vi.fn(),
  reportInstall: vi.fn(),
  downloadBundle: vi.fn(),
  getDigest: vi.fn(),
  uploadArtifacts: vi.fn(),
  updateVersionMetadata: vi.fn(),
  deleteVersion: vi.fn(),
  publishEntry: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
})

function makeApp(gateway?: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gateway as unknown as import('../src/k8s.js').K8sGateway))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

// ── POST /admin/registry/upgrade-recipe ────────────────────────────────────────
describe('POST /admin/registry/upgrade-recipe', () => {
  const validRecipeEntry = {
    entry_type: 'recipe',
    recipe_meta: {
      recipeYaml: JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'test-recipe' },
        spec: {
          description: 'Test recipe',
          steps: [{ id: 'step1', instruction: 'Do something' }],
        },
      }),
    },
  }

  it('returns 400 when missing required fields', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    const app = makeApp(gateway)
    // Missing registryEntryVersion
    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({ recipeName: 'my-recipe', registryEntryName: 'test-recipe' })
      .expect(400)
    expect(res.body.error).toContain('required')
  })

  it('returns 404 when recipe does not exist', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    const app = makeApp(gateway)

    // getEntryVersion returns valid entry, but recipe doesn't exist in gateway
    vi.mocked(getEntryVersion).mockResolvedValueOnce(validRecipeEntry as never)

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'nonexistent',
        registryEntryName: 'test-recipe',
        registryEntryVersion: '2.0.0',
      })
      .expect(404)
    expect(res.body.error).toContain('not found')
  })

  it('returns 400 when entry is not a recipe', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    // Create the recipe first
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'my-recipe' },
      spec: { description: 'original' },
    })
    const app = makeApp(gateway)

    vi.mocked(getEntryVersion).mockResolvedValueOnce({ entry_type: 'mcp_server' } as never)

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'my-recipe',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
      })
      .expect(400)
    expect(res.body.error).toContain('not a recipe')
  })

  it('returns 422 when entry has no recipe YAML', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'my-recipe' },
      spec: { description: 'original' },
    })
    const app = makeApp(gateway)

    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      entry_type: 'recipe',
      recipe_meta: {},
    } as never)

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'my-recipe',
        registryEntryName: 'test-recipe',
        registryEntryVersion: '2.0.0',
      })
      .expect(422)
    expect(res.body.error).toContain('no recipe YAML')
  })

  it('successfully upgrades recipe spec', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'my-recipe' },
      spec: { description: 'original v1' },
    })
    const app = makeApp(gateway)

    vi.mocked(getEntryVersion).mockResolvedValueOnce(validRecipeEntry as never)

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'my-recipe',
        registryEntryName: 'test-recipe',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)

    expect(res.body.upgraded).toBe(true)
    expect(res.body.recipeName).toBe('my-recipe')
    expect(res.body.registryVersion).toBe('2.0.0')
    expect(res.body.correlationId).toBeDefined()

    // Verify spec was updated in gateway
    const updated = (await gateway.getResource('workflowrecipes', 'my-recipe')) as {
      spec: Record<string, unknown>
    }
    expect(updated.spec.description).toBe('Test recipe')
  })

  it('applies inputValues with type validation', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'my-recipe' },
      spec: { description: 'original' },
    })
    const app = makeApp(gateway)

    const recipeWithContract = {
      entry_type: 'recipe',
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Recipe with contract',
            inputContract: {
              properties: {
                topic: { type: 'string', default: 'AI' },
                count: { type: 'number', default: 5 },
              },
            },
            steps: [{ id: 'step1', instruction: 'Research {{inputs.topic}}' }],
          },
        }),
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(recipeWithContract as never)

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'my-recipe',
        registryEntryName: 'test-recipe',
        registryEntryVersion: '2.0.0',
        inputValues: { topic: 'blockchain', count: 10 },
      })
      .expect(200)

    expect(res.body.upgraded).toBe(true)
  })

  it('rejects wrong type in inputValues', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'my-recipe' },
      spec: { description: 'original' },
    })
    const app = makeApp(gateway)

    const recipeWithContract = {
      entry_type: 'recipe',
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Recipe with contract',
            inputContract: {
              properties: {
                topic: { type: 'string', default: 'AI' },
              },
            },
            steps: [{ id: 'step1', instruction: 'Research {{inputs.topic}}' }],
          },
        }),
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(recipeWithContract as never)

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'my-recipe',
        registryEntryName: 'test-recipe',
        registryEntryVersion: '2.0.0',
        inputValues: { topic: 123 }, // number instead of string
      })
      .expect(400)
    expect(res.body.error).toContain('expected string')
  })
})
