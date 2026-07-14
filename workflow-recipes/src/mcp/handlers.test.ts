import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRecipeProvider } from '../k8sClient'
import { WorkflowRecipeCRD } from '../types'
import {
  handleDeleteRecipe,
  handleDeployRecipe,
  handleGetRecipeStatus,
  handleListPolicies,
  handleListRecipes,
  handleRollbackRecipe,
  handleSearchRegistry,
  handleValidateRecipe,
  validateHeaders,
} from './handlers'

// Mock the clerumRegistryClient so handleSearchRegistry tests don't hit the
// real network. The mock is overridden per-test via `searchEntriesMock`.
const searchEntriesMock = vi.fn()
vi.mock('../registry/clerumRegistryClient.js', () => ({
  searchEntries: (...args: unknown[]) => searchEntriesMock(...args),
}))

// ─── Test Helpers ──────────────────────────────────────────────────

function makeProvider(recipes: WorkflowRecipeCRD[] = []): WorkflowRecipeProvider {
  return {
    getAllRecipes: () => recipes,
    start: async () => {},
    stop: async () => {},
    getTokenFactory: () => null,
    getDbRunProcessor: () => null,
  }
}

function makeRecipe(name: string, phase?: string, contextRef?: string): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: 'mcp-server' },
    spec: {
      workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      contextRef,
    },
    status: phase
      ? {
          phase: phase as WorkflowRecipeCRD['status'] extends undefined
            ? never
            : NonNullable<WorkflowRecipeCRD['status']>['phase'],
        }
      : undefined,
  }
}

function parseResponse(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

// ─── Header Validation (Risk 4.9) ─────────────────────────────────

describe('validateHeaders', () => {
  it('returns 401 without X-Clerum-Agent-Id (4.9a)', () => {
    const result = validateHeaders({ 'x-clerum-context-ref': 'ctx' })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.isError).toBe(true)
      const body = parseResponse(result.error) as { error: string }
      expect(body.error).toContain('Agent-Id')
    }
  })

  it('returns 401 without X-Clerum-Context-Ref (4.9b)', () => {
    const result = validateHeaders({ 'x-clerum-agent-id': 'agent' })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.isError).toBe(true)
      const body = parseResponse(result.error) as { error: string }
      expect(body.error).toContain('Context-Ref')
    }
  })

  it('returns identity with valid headers (4.9c)', () => {
    const result = validateHeaders({
      'x-clerum-agent-id': 'agent-1',
      'x-clerum-context-ref': 'ctx-a',
    })
    expect('identity' in result).toBe(true)
    if ('identity' in result) {
      expect(result.identity.agentId).toBe('agent-1')
      expect(result.identity.contextRef).toBe('ctx-a')
    }
  })
})

// ─── Handler Functional Tests ──────────────────────────────────────

describe('handleListRecipes', () => {
  it('returns array of recipes with status (4.10a)', () => {
    const provider = makeProvider([makeRecipe('app-a', 'active'), makeRecipe('app-b', 'failed')])
    const result = handleListRecipes({}, provider)
    const data = parseResponse(result) as Array<{ name: string; phase: string }>
    expect(data).toHaveLength(2)
    expect(data[0].name).toBe('app-a')
    expect(data[0].phase).toBe('active')
  })

  it('filters by status_filter', () => {
    const provider = makeProvider([makeRecipe('app-a', 'active'), makeRecipe('app-b', 'failed')])
    const result = handleListRecipes({ status_filter: 'active' }, provider)
    const data = parseResponse(result) as Array<{ name: string }>
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('app-a')
  })
})

describe('handleGetRecipeStatus', () => {
  it("returns 'not found' for non-existent name (4.10b)", () => {
    const provider = makeProvider([])
    const result = handleGetRecipeStatus({ name: 'nope' }, provider)
    expect(result.isError).toBe(true)
    const body = parseResponse(result) as { error: string }
    expect(body.error).toContain('not found')
  })

  it('returns recipe status for existing recipe', () => {
    const provider = makeProvider([makeRecipe('app', 'active')])
    const result = handleGetRecipeStatus({ name: 'app' }, provider)
    const body = parseResponse(result) as { phase: string }
    expect(body.phase).toBe('active')
  })
})

describe('handleValidateRecipe', () => {
  it('returns errors for invalid YAML (4.10c)', () => {
    const result = handleValidateRecipe({ recipe_yaml: 'not json' })
    const body = parseResponse(result) as { valid: boolean; errors: string[] }
    expect(body.valid).toBe(false)
    expect(body.errors[0]).toContain('Invalid JSON')
  })

  it('returns {valid: true} for valid recipe (4.10d)', () => {
    const validRecipe = JSON.stringify({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
    })
    const result = handleValidateRecipe({ recipe_yaml: validRecipe })
    const body = parseResponse(result) as { valid: boolean; errors: string[] }
    expect(body.valid).toBe(true)
    expect(body.errors).toHaveLength(0)
  })
})

// ─── Context Authorization (Risk 4.11) ────────────────────────────

describe('handleDeployRecipe', () => {
  it('returns 403 on contextRef mismatch (4.11a)', () => {
    const provider = makeProvider([makeRecipe('app', 'active', 'ctx-b')])
    const result = handleDeployRecipe({ recipe_name: 'app' }, provider, {
      agentId: 'agent-1',
      contextRef: 'ctx-a',
    })
    expect(result.isError).toBe(true)
    const body = parseResponse(result) as { code: number }
    expect(body.code).toBe(403)
  })

  it('proceeds with matching contextRef (4.11b)', () => {
    const provider = makeProvider([makeRecipe('app', 'active', 'ctx-a')])
    const result = handleDeployRecipe({ recipe_name: 'app' }, provider, {
      agentId: 'agent-1',
      contextRef: 'ctx-a',
    })
    expect(result.isError).toBeUndefined()
    const body = parseResponse(result) as { status: string }
    expect(body.status).toBe('accepted')
  })
})

// ─── MCP Response Format (4.12a) ──────────────────────────────────

describe('MCP response format', () => {
  it("returns {content: [{type: 'text', text: '...'}]} (4.12a)", async () => {
    const mockCustomApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as import('@kubernetes/client-node').CustomObjectsApi
    const result = await handleListPolicies(mockCustomApi, 'mcp-server')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(typeof result.content[0].text).toBe('string')
    JSON.parse(result.content[0].text) // Must be valid JSON
  })
})

// ─── Stub Handlers ─────────────────────────────────────────────────

describe('handleSearchRegistry', () => {
  beforeEach(() => {
    searchEntriesMock.mockReset()
  })

  it('returns results from clerumRegistryClient.searchEntries on success', async () => {
    searchEntriesMock.mockResolvedValueOnce({
      results: [
        { name: 'recipe-a', version: '1.0.0', description: 'first hit' },
        { name: 'recipe-b', version: '0.2.1', description: 'second hit' },
      ],
      total: 2,
    })

    const result = await handleSearchRegistry({ query: 'recipe', category: 'data' })
    const body = parseResponse(result) as {
      results: Array<{ name: string }>
      total: number
      query: string
      category: string
    }

    expect(body.results).toHaveLength(2)
    expect(body.results[0].name).toBe('recipe-a')
    expect(body.total).toBe(2)
    expect(body.query).toBe('recipe')
    expect(body.category).toBe('data')
    // `category` is accepted on the tool surface but currently ignored by the
    // npm-style registry backend, so it's NOT forwarded to searchEntries.
    expect(searchEntriesMock).toHaveBeenCalledWith({ query: 'recipe' })
  })

  it('returns empty results (not error) when registry returns no hits', async () => {
    searchEntriesMock.mockResolvedValueOnce({ results: [], total: 0 })

    const result = await handleSearchRegistry({ query: 'no-such-thing' })
    const body = parseResponse(result) as { results: unknown[]; total: number; query: string }

    expect(result.isError).toBeFalsy()
    expect(body.results).toHaveLength(0)
    expect(body.total).toBe(0)
    expect(body.query).toBe('no-such-thing')
  })

  it('returns a fail result (not thrown) when searchEntries throws', async () => {
    searchEntriesMock.mockRejectedValueOnce(new Error('boom: 502 from registry'))

    const result = await handleSearchRegistry({ query: 'whatever' })
    expect(result.isError).toBe(true)

    const body = parseResponse(result) as { error: string }
    expect(body.error).toContain('Registry search failed')
    expect(body.error).toContain('boom: 502 from registry')
  })

  it('works with no arguments (no query, no category)', async () => {
    searchEntriesMock.mockResolvedValueOnce({ results: [], total: 0 })

    const result = await handleSearchRegistry({})
    const body = parseResponse(result) as { query: string; category: string }

    expect(result.isError).toBeFalsy()
    expect(body.query).toBe('')
    expect(body.category).toBe('')
    expect(searchEntriesMock).toHaveBeenCalledWith({ query: undefined })
  })

  it('does not require an explicit registry client (auth handled by client)', async () => {
    // Default dev env has CLERUM_REGISTRY_AUTH_ENABLED=false. The handler must
    // not gate on any client argument; it should always delegate to
    // searchEntries which the client itself handles (auth disabled or otherwise).
    searchEntriesMock.mockResolvedValueOnce({
      results: [{ name: 'dev-recipe', version: '0.1.0' }],
      total: 1,
    })

    const result = await handleSearchRegistry({ query: 'dev' })
    const body = parseResponse(result) as { results: Array<{ name: string }>; total: number }

    expect(result.isError).toBeFalsy()
    expect(body.results).toHaveLength(1)
    expect(body.total).toBe(1)
  })
})

describe('stub handlers', () => {
  it('handleRollbackRecipe returns not found for missing recipe', () => {
    const result = handleRollbackRecipe({ name: 'nope' }, makeProvider([]))
    expect(result.isError).toBe(true)
  })

  it('handleDeleteRecipe returns not found for missing recipe', () => {
    const result = handleDeleteRecipe({ name: 'nope' }, makeProvider([]))
    expect(result.isError).toBe(true)
  })
})
