import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLlmModel,
  deleteLlmModel,
  getAdminAttention,
  getLlmModel,
  getLlmModels,
  getModelInUseImpact,
  isLlmModelConfigMapDeferred,
  updateLlmModel,
} from '../api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const SAMPLE = {
  id: '11111111-1111-1111-1111-111111111111',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  vendor: 'Anthropic',
  display_name: 'Claude Haiku 4.5',
  context_window_tokens: 200000,
  enabled: true,
  created_at: '2026-07-09T00:00:00Z',
  updated_at: '2026-07-09T00:00:00Z',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('llm allowed-models api helpers', () => {
  it('getLlmModels GETs the admin list endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ rows: [SAMPLE] }))
    const res = await getLlmModels()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-models')
    expect(init.credentials).toBe('include')
    expect(res.rows[0].model).toBe('claude-haiku-4-5')
  })

  it('getLlmModel encodes the id in the path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE))
    await getLlmModel(SAMPLE.id)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v1/admin/llm-models/${SAMPLE.id}`)
  })

  it('createLlmModel POSTs the body to the collection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE, 201))
    await createLlmModel({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      vendor: 'Anthropic',
      display_name: 'Claude Haiku 4.5',
      context_window_tokens: 200000,
      enabled: true,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-models')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body)).model).toBe('claude-haiku-4-5')
  })

  it('updateLlmModel PUTs a partial body with null to clear a column', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE))
    await updateLlmModel(SAMPLE.id, { vendor: null, enabled: false })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v1/admin/llm-models/${SAMPLE.id}`)
    expect(init.method).toBe('PUT')
    const parsed = JSON.parse(String(init.body))
    expect(parsed.vendor).toBeNull()
    expect(parsed.enabled).toBe(false)
  })

  it('deleteLlmModel accepts a 204 empty response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteLlmModel(SAMPLE.id)).resolves.toBeUndefined()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
  })

  it('flags a 503 configmap_write_failed as a deferred (saved) write', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'configmap_write_failed', message: 'delayed' }, 503)
    )
    try {
      await createLlmModel({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect.unreachable('createLlmModel should reject on 503')
    } catch (err) {
      expect(isLlmModelConfigMapDeferred(err)).toBe(true)
    }
  })

  it('does not flag a bodyless infra 503 (gateway, no JSON code) as deferred', async () => {
    // Without the configmap_write_failed code the row may never have been
    // saved — this must surface as a failure, not a "saved, delayed" toast.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    )
    try {
      await createLlmModel({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect.unreachable('createLlmModel should reject on 503')
    } catch (err) {
      expect(isLlmModelConfigMapDeferred(err)).toBe(false)
    }
  })

  it('does not flag an ordinary conflict as deferred', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'conflict', message: 'already exists' }, 409)
    )
    try {
      await createLlmModel({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect.unreachable('createLlmModel should reject on 409')
    } catch (err) {
      expect(isLlmModelConfigMapDeferred(err)).toBe(false)
    }
  })
})

describe('disable/delete impact gate (?force)', () => {
  it('updateLlmModel appends ?force=true only when force is set', async () => {
    // Fresh Response per call — a single mocked body can only be read once.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(SAMPLE))

    await updateLlmModel(SAMPLE.id, { enabled: false }, { force: true })
    const [forcedUrl, forcedInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(forcedInit.method).toBe('PUT')
    expect(forcedUrl).toContain('force=true')

    await updateLlmModel(SAMPLE.id, { enabled: false })
    const [plainUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(plainUrl).not.toContain('force')
  })

  it('deleteLlmModel appends ?force=true only when force is set', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }))

    await deleteLlmModel(SAMPLE.id, { force: true })
    const [forcedUrl, forcedInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(forcedInit.method).toBe('DELETE')
    expect(forcedUrl).toContain('force=true')

    await deleteLlmModel(SAMPLE.id)
    const [plainUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(plainUrl).not.toContain('force')
  })

  it('getModelInUseImpact extracts the impact from a 409 model_in_use', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: 'model_in_use',
          message: 'still referenced',
          impact: {
            provider: 'claude',
            model: 'claude-haiku-4-5',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
            grantsAffected: [
              {
                id: 'g1',
                recipeNamespace: 'sandbox-recipes',
                recipeName: 'nightly-summary',
                capabilityFamily: 'promptBridge',
              },
            ],
          },
        },
        409
      )
    )
    try {
      await deleteLlmModel(SAMPLE.id)
      expect.unreachable('deleteLlmModel should reject on 409')
    } catch (err) {
      const impact = getModelInUseImpact(err)
      expect(impact).not.toBeNull()
      expect(impact?.hostsAffected).toEqual([
        { namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] },
      ])
      expect(impact?.grantsAffected[0].capabilityFamily).toBe('promptBridge')
    }
  })

  it('getModelInUseImpact returns null for an unrelated 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'conflict', message: 'already exists' }, 409)
    )
    try {
      await deleteLlmModel(SAMPLE.id)
      expect.unreachable('deleteLlmModel should reject on 409')
    } catch (err) {
      expect(getModelInUseImpact(err)).toBeNull()
    }
  })
})

describe('getAdminAttention', () => {
  it('GETs the feed and normalizes items, keeping an unknown kind', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        items: [
          {
            kind: 'stale_model_referenced',
            provider: 'claude',
            model: 'claude-haiku-4-5',
            displayName: 'Claude Haiku',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
            grantsAffected: [],
          },
          // A kind the current UI does not know: it must survive normalization
          // (the banner decides what to render) and never throw here.
          { kind: 'future_kind', provider: 'openai', model: 'gpt-5' },
          // Malformed item (no model) is dropped rather than tumbling the feed.
          { kind: 'stale_model_referenced', provider: 'openai' },
        ],
        generatedAt: '2026-08-12T00:00:00.000Z',
      })
    )
    const report = await getAdminAttention()
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/attention')
    expect(report.items).toHaveLength(2)
    expect(report.items[0].displayName).toBe('Claude Haiku')
    expect(report.items[0].hostsAffected[0].name).toBe('agent-a')
    expect(report.items[1].kind).toBe('future_kind')
    expect(report.generatedAt).toBe('2026-08-12T00:00:00.000Z')
  })

  it('returns an empty feed when items is missing/empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ generatedAt: 'x' }))
    const report = await getAdminAttention()
    expect(report.items).toEqual([])
  })
})
