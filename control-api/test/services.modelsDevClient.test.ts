import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_IDS } from '@clerum/llm-providers'
import {
  MODELS_DEV_API_URL,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  loadModelsDevCatalog,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'

// A tiny catalog fixture shaped exactly like models.dev api.json (and the
// vendored snapshot): models.dev provider key → { name?, models: id → entry }.
const FIXTURE: RawModelsDevCatalog = {
  anthropic: {
    name: 'Anthropic',
    models: {
      'claude-opus-4-5': {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        limit: { context: 200000 },
      },
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    },
  },
  google: {
    name: 'Google',
    models: {
      // Google-native `models/` prefix must be normalized away.
      'models/gemini-3.1-flash': {
        id: 'models/gemini-3.1-flash',
        name: 'Gemini 3.1 Flash',
        limit: { context: 1000000 },
      },
    },
  },
  openai: { name: 'OpenAI', models: {} },
}

describe('modelsDevClient — PROVIDER_KEY_MAP', () => {
  it('maps every one of our 21 providers to a models.dev key', () => {
    for (const id of PROVIDER_IDS) {
      expect(typeof PROVIDER_KEY_MAP[id]).toBe('string')
      expect(PROVIDER_KEY_MAP[id].length).toBeGreaterThan(0)
    }
    expect(Object.keys(PROVIDER_KEY_MAP).sort()).toEqual([...PROVIDER_IDS].sort())
  })

  it('pins the non-obvious / ambiguous choices (zai coding-plan, bailian→alibaba)', () => {
    expect(PROVIDER_KEY_MAP.zai).toBe('zai-coding-plan')
    expect(PROVIDER_KEY_MAP.bailian).toBe('alibaba')
    expect(PROVIDER_KEY_MAP.claude).toBe('anthropic')
    expect(PROVIDER_KEY_MAP.gemini).toBe('google')
    expect(PROVIDER_KEY_MAP.vertex).toBe('google-vertex')
    expect(PROVIDER_KEY_MAP.bedrock).toBe('amazon-bedrock')
    expect(PROVIDER_KEY_MAP.together).toBe('togetherai')
    expect(PROVIDER_KEY_MAP.fireworks).toBe('fireworks-ai')
    expect(PROVIDER_KEY_MAP.moonshot).toBe('moonshotai')
    expect(PROVIDER_KEY_MAP.novita).toBe('novita-ai')
  })
})

describe('modelsDevClient — mapCatalogToProviders', () => {
  it('maps a provider key to our provider id with ctx + display_name, no vendor', () => {
    const byProvider = mapCatalogToProviders(FIXTURE)
    const claude = byProvider.claude
    expect(claude).toEqual([
      { model_id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
      {
        model_id: 'claude-opus-4-5',
        display_name: 'Claude Opus 4.5',
        context_window_tokens: 200000,
      },
    ])
    // vendor is never derived from models.dev (no reliable per-model field).
    for (const m of claude) expect('vendor' in m).toBe(false)
  })

  it('normalizes a `models/` prefixed id (gemini native style)', () => {
    const byProvider = mapCatalogToProviders(FIXTURE)
    expect(byProvider.gemini).toEqual([
      {
        model_id: 'gemini-3.1-flash',
        display_name: 'Gemini 3.1 Flash',
        context_window_tokens: 1000000,
      },
    ])
  })

  it('yields an empty list for a mapped provider absent from the catalog or with no models', () => {
    const byProvider = mapCatalogToProviders(FIXTURE)
    expect(byProvider.openai).toEqual([]) // present but empty models
    expect(byProvider.groq).toEqual([]) // absent from fixture
  })

  it('is defined for every provider id (never undefined)', () => {
    const byProvider = mapCatalogToProviders(FIXTURE)
    for (const id of PROVIDER_IDS) expect(Array.isArray(byProvider[id])).toBe(true)
  })

  it('SKIPs a model whose id exceeds the operator-API length cap (400) or has control chars', () => {
    const longId = 'x'.repeat(401)
    const catalog: RawModelsDevCatalog = {
      anthropic: {
        name: 'Anthropic',
        models: {
          [longId]: { id: longId, name: 'too long' },
          'bad\nid': { id: 'bad\nid', name: 'newline id' },
          'has\u0000null': { id: 'has\u0000null', name: 'null byte' },
          good: { id: 'good', name: 'ok' },
        },
      },
    }
    const claude = mapCatalogToProviders(catalog).claude
    // Only the well-formed id survives; the three malformed ones are dropped.
    expect(claude).toEqual([{ model_id: 'good', display_name: 'ok' }])
  })

  it('CLAMPs an over-long display_name to 400 chars (keeps the model)', () => {
    const longName = 'n'.repeat(401)
    const catalog: RawModelsDevCatalog = {
      anthropic: { name: 'Anthropic', models: { 'm-1': { id: 'm-1', name: longName } } },
    }
    const [model] = mapCatalogToProviders(catalog).claude
    expect(model.model_id).toBe('m-1')
    expect(model.display_name).toBe('n'.repeat(400))
    expect(model.display_name!.length).toBe(400)
  })

  it('keeps a 400-char id (boundary) — only >400 is rejected', () => {
    const id400 = 'a'.repeat(400)
    const catalog: RawModelsDevCatalog = {
      anthropic: { name: 'Anthropic', models: { [id400]: { id: id400 } } },
    }
    expect(mapCatalogToProviders(catalog).claude).toEqual([{ model_id: id400 }])
  })
})

describe('modelsDevClient — loadModelsDevCatalog', () => {
  function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    })
  }

  it('returns source=live on a successful, well-shaped fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FIXTURE))
    const res = await loadModelsDevCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.source).toBe('live')
    expect(res.catalog.anthropic?.models['claude-opus-4-5']?.id).toBe('claude-opus-4-5')
    expect(fetchImpl).toHaveBeenCalledWith(
      MODELS_DEV_API_URL,
      expect.objectContaining({ redirect: 'error' })
    )
    expect(typeof res.fetchedAt).toBe('string')
  })

  it('falls back to the vendored snapshot when the fetch throws (network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await loadModelsDevCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.source).toBe('vendored')
    // The vendored snapshot must carry our mapped providers so the sync has data.
    const byProvider = mapCatalogToProviders(res.catalog)
    expect(byProvider.claude.length).toBeGreaterThan(0)
    expect(byProvider.openai.length).toBeGreaterThan(0)
  })

  it('falls back to vendored on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }))
    const res = await loadModelsDevCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.source).toBe('vendored')
  })

  it('falls back to vendored on malformed JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{not json', { status: 200 }))
    const res = await loadModelsDevCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.source).toBe('vendored')
  })

  it('falls back to vendored on a well-formed but wrong-shape body (parse-guard)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([1, 2, 3]))
    const res = await loadModelsDevCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.source).toBe('vendored')
  })
})
