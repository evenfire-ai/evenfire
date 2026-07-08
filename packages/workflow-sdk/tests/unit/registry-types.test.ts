import { describe, expect, it } from 'vitest'
import type {
  ArtifactManifest,
  PushRecipeRequest,
  RegistryClient,
  RegistryRecipe,
  SearchParams,
} from '../../src/index'

describe('Registry Types', () => {
  describe('RegistryRecipe type', () => {
    it('accepts a valid only-workloads recipe', () => {
      const recipe: RegistryRecipe = {
        name: 'mcp-postgres',
        version: '1.0.0',
        description: 'PostgreSQL MCP server',
        recipeType: 'only-workloads',
        ociReference: 'registry.example.com/recipes/mcp-postgres:1.0.0',
        stepCount: 0,
        mcpServerIds: ['postgres-mcp'],
        hasAgent: false,
        hasSoulMd: false,
        qualityTier: 'unverified',
        deprecated: false,
        createdAt: '2026-03-17T14:00:00Z',
      }
      expect(recipe.recipeType).toBe('only-workloads')
      expect(recipe.stepCount).toBe(0)
      expect(recipe.hasAgent).toBe(false)
    })

    it('accepts a valid workflow recipe', () => {
      const recipe: RegistryRecipe = {
        name: 'market-report-workflow',
        version: '1.0.0',
        description: 'Multi-step market research',
        recipeType: 'workflow',
        ociReference: 'registry.example.com/recipes/market-report-workflow:1.0.0',
        stepCount: 3,
        mcpServerIds: ['web-search', 'data-analyzer'],
        hasAgent: true,
        hasSoulMd: true,
        outputType: 'document',
        sdkVersion: '1.0.0-beta.0',
        qualityTier: 'verified',
        deprecated: false,
        createdAt: '2026-03-17T14:00:00Z',
      }
      expect(recipe.recipeType).toBe('workflow')
      expect(recipe.stepCount).toBe(3)
      expect(recipe.hasAgent).toBe(true)
      expect(recipe.hasSoulMd).toBe(true)
    })
  })

  describe('ArtifactManifest type', () => {
    it('accepts empty manifest', () => {
      const manifest: ArtifactManifest = {}
      expect(manifest.soulMd).toBeUndefined()
    })

    it('accepts manifest with global and per-step SOUL.md', () => {
      const manifest: ArtifactManifest = {
        soulMd: 's3://bucket/recipe/SOUL.md',
        stepSoulMds: {
          'gather-data': 's3://bucket/recipe/steps/gather-data/SOUL.md',
          'generate-report': 's3://bucket/recipe/steps/generate-report/SOUL.md',
        },
      }
      expect(manifest.soulMd).toContain('SOUL.md')
      expect(Object.keys(manifest.stepSoulMds!)).toHaveLength(2)
    })
  })

  describe('PushRecipeRequest type', () => {
    it('accepts a valid push request', () => {
      const req: PushRecipeRequest = {
        name: 'test-workflow',
        version: '0.1.0',
        description: 'Test',
        author: 'agent-1',
        origin: 'agent-generated',
        category: 'workflow',
        visibility: 'public',
        recipe: 'apiVersion: clerum.io/v1alpha1\nkind: WorkflowRecipe\n...',
      }
      expect(req.origin).toBe('agent-generated')
      expect(req.visibility).toBe('public')
    })

    it('accepts push request with artifacts', () => {
      const req: PushRecipeRequest = {
        name: 'soul-workflow',
        version: '1.0.0',
        description: 'Workflow with SOUL',
        author: 'platform-team',
        origin: 'human-authored',
        category: 'workflow',
        visibility: 'private',
        recipe: '...',
        artifacts: {
          soulMd: 'base64-encoded-soul',
          stepSoulMds: { 'step-1': 'base64-encoded-step-soul' },
        },
      }
      expect(req.artifacts?.soulMd).toBeDefined()
    })
  })

  describe('SearchParams type', () => {
    it('accepts minimal search params', () => {
      const params: SearchParams = {}
      expect(params.q).toBeUndefined()
    })

    it('accepts full search params', () => {
      const params: SearchParams = {
        q: 'postgres',
        category: 'databases',
        recipeType: 'only-workloads',
        origin: 'human-authored',
        hasAgent: false,
        hasSoulMd: false,
        deprecated: false,
        visibility: 'public',
        sort: 'downloads',
        limit: 20,
        offset: 0,
      }
      expect(params.sort).toBe('downloads')
      expect(params.limit).toBe(20)
    })
  })

  describe('RegistryClient interface contract', () => {
    it('can be satisfied by a mock implementation', async () => {
      const mockRecipe: RegistryRecipe = {
        name: 'test',
        version: '1.0.0',
        description: 'mock',
        recipeType: 'workflow',
        ociReference: 'reg/test:1.0.0',
        stepCount: 1,
        mcpServerIds: [],
        hasAgent: false,
        hasSoulMd: false,
        qualityTier: 'unverified',
        deprecated: false,
        createdAt: new Date().toISOString(),
      }

      const client: RegistryClient = {
        push: async () => ({
          name: 'test',
          version: '1.0.0',
          recipeType: 'workflow',
          stepCount: 1,
          ociReference: 'reg/test:1.0.0',
          createdAt: new Date().toISOString(),
        }),
        pull: async () => mockRecipe,
        pullVersion: async () => mockRecipe,
        search: async () => ({ recipes: [mockRecipe], total: 1, limit: 50, offset: 0 }),
        uploadArtifacts: async () => {},
        listArtifacts: async () => ({}),
        health: async () => ({ status: 'ok' }),
      }

      const result = await client.pull('test')
      expect(result).toBeDefined()
      expect(result!.name).toBe('test')

      const searchResult = await client.search({ q: 'test' })
      expect(searchResult.total).toBe(1)

      const health = await client.health()
      expect(health.status).toBe('ok')
    })
  })
})
