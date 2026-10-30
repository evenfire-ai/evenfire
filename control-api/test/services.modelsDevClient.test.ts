import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_IDS } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT_CAPTURED_AT } from '../src/data/modelsDevSnapshot.js'
import {
  MODELS_DEV_API_URL,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  imageInputStateFromModalities,
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
        modalities: { input: ['text', 'image'] },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        modalities: { input: ['text'] },
      },
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

// What the mapper emits for an entry that carries none of the auto-enable
// fields (as these older-shape entries don't): no tools, no text output, no
// status, unpriced.
const NO_AUTO_ENABLE_FIELDS = {
  text_output: false,
  tool_call: false,
  catalog_status: null,
  cost: null,
} as const

describe('modelsDevClient — PROVIDER_KEY_MAP', () => {
  it('maps every static provider to a models.dev key and excludes oauth-broker ids', () => {
    const staticIds = PROVIDER_IDS.filter(
      id => id !== 'codex-subscription' && id !== 'grok-subscription'
    )
    for (const id of staticIds) {
      expect(typeof PROVIDER_KEY_MAP[id]).toBe('string')
      expect(PROVIDER_KEY_MAP[id].length).toBeGreaterThan(0)
    }
    expect(Object.keys(PROVIDER_KEY_MAP).sort()).toEqual([...staticIds].sort())
    expect('codex-subscription' in PROVIDER_KEY_MAP).toBe(false)
    expect('grok-subscription' in PROVIDER_KEY_MAP).toBe(false)
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
      {
        model_id: 'claude-haiku-4-5',
        display_name: 'Claude Haiku 4.5',
        image_input_state: 'unsupported',
        ...NO_AUTO_ENABLE_FIELDS,
      },
      {
        model_id: 'claude-opus-4-5',
        display_name: 'Claude Opus 4.5',
        context_window_tokens: 200000,
        image_input_state: 'supported',
        ...NO_AUTO_ENABLE_FIELDS,
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
        // No `modalities` in the fixture — the catalog said nothing, so neither do we.
        image_input_state: 'unknown',
        ...NO_AUTO_ENABLE_FIELDS,
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
    expect(claude).toEqual([
      {
        model_id: 'good',
        display_name: 'ok',
        image_input_state: 'unknown',
        ...NO_AUTO_ENABLE_FIELDS,
      },
    ])
  })

  describe('display_name is bounded to 256 bytes of UTF-8 as serialized to JSON, at ingest', () => {
    // What the allowlist ConfigMap stores for the name, without the quotes.
    const servedBytes = (s: string) => Buffer.byteLength(JSON.stringify(s), 'utf8') - 2

    function displayNameOf(name: string): string | undefined {
      const catalog: RawModelsDevCatalog = {
        anthropic: { name: 'Anthropic', models: { 'm-1': { id: 'm-1', name } } },
      }
      const [model] = mapCatalogToProviders(catalog).claude
      expect(model.model_id).toBe('m-1')
      return model.display_name
    }

    // A lone surrogate is what a UTF-16 cut leaves behind; `encodeURIComponent`
    // refuses exactly those.
    function isWellFormed(s: string): boolean {
      try {
        encodeURIComponent(s)
        return true
      } catch {
        return false
      }
    }

    it('keeps an ASCII name of exactly 256 bytes and clamps one byte more (keeps the model)', () => {
      expect(displayNameOf('n'.repeat(256))).toBe('n'.repeat(256))
      expect(displayNameOf('n'.repeat(401))).toBe('n'.repeat(256))
    })

    it('never splits a 3-byte character: 400 × "€" keeps 85 whole characters (255 bytes)', () => {
      const name = displayNameOf('€'.repeat(400))!
      expect(name).toBe('€'.repeat(85))
      expect(Buffer.byteLength(name, 'utf8')).toBe(255)
    })

    it('never leaves half a surrogate pair: a 4-byte character that does not fit is dropped whole', () => {
      // 1 + 63 × 4 = 253 bytes; the 64th emoji would reach 257. A cut at 400
      // UTF-16 units would also have split the 200th pair.
      const raw = `a${'😀'.repeat(399)}`
      const name = displayNameOf(raw)!
      expect(name).toBe(`a${'😀'.repeat(63)}`)
      expect(Buffer.byteLength(name, 'utf8')).toBe(253)
      expect(isWellFormed(name)).toBe(true)
      expect(raw.startsWith(name)).toBe(true)
    })

    it('counts a quote and a backslash as the 2 bytes JSON escapes them to', () => {
      const name = displayNameOf('"\\'.repeat(200))!
      expect(name).toBe('"\\'.repeat(64))
      expect(servedBytes(name)).toBe(256)
      expect(Buffer.byteLength(name, 'utf8')).toBe(128)
    })

    it('mixes escapes and multibyte characters without splitting either', () => {
      const raw = `"${'😀\\€'.repeat(100)}`
      const name = displayNameOf(raw)!
      expect(servedBytes(name)).toBeLessThanOrEqual(256)
      expect(servedBytes(name)).toBeGreaterThan(256 - 4)
      expect(isWellFormed(name)).toBe(true)
      expect(raw.startsWith(name)).toBe(true)
    })

    it('counts a lone surrogate from the source as the 6-byte escape JSON writes for it', () => {
      const name = displayNameOf('\uD83D'.repeat(100))!
      expect(name.length).toBe(42)
      expect(servedBytes(name)).toBe(252)
    })
  })

  it('keeps a 400-char id (boundary) — only >400 is rejected', () => {
    const id400 = 'a'.repeat(400)
    const catalog: RawModelsDevCatalog = {
      anthropic: { name: 'Anthropic', models: { [id400]: { id: id400 } } },
    }
    expect(mapCatalogToProviders(catalog).claude).toEqual([
      { model_id: id400, image_input_state: 'unknown', ...NO_AUTO_ENABLE_FIELDS },
    ])
  })

  it('carries image_input_state per discovered model', () => {
    const catalog: RawModelsDevCatalog = {
      anthropic: {
        name: 'Anthropic',
        models: {
          'sees-images': { id: 'sees-images', modalities: { input: ['text', 'image'] } },
          'text-only': { id: 'text-only', modalities: { input: ['text'] } },
          'no-modalities': { id: 'no-modalities' },
        },
      },
    }
    const claude = mapCatalogToProviders(catalog).claude
    // Witness: all three entries survived the mapping, so the states below are
    // read off real rows and not off an empty list.
    expect(claude.map(m => m.model_id)).toEqual(['no-modalities', 'sees-images', 'text-only'])
    expect(claude.map(m => m.image_input_state)).toEqual(['unknown', 'supported', 'unsupported'])
  })
})

describe('modelsDevClient — imageInputStateFromModalities', () => {
  it('returns supported when modalities.input includes "image"', () => {
    expect(imageInputStateFromModalities({ modalities: { input: ['text', 'image'] } })).toBe(
      'supported'
    )
    expect(imageInputStateFromModalities({ modalities: { input: ['image'] } })).toBe('supported')
  })

  it('returns unsupported for a non-empty string array without "image"', () => {
    expect(imageInputStateFromModalities({ modalities: { input: ['text'] } })).toBe('unsupported')
    expect(imageInputStateFromModalities({ modalities: { input: ['text', 'audio'] } })).toBe(
      'unsupported'
    )
    // The token is matched exactly: models.dev writes it lowercase.
    expect(imageInputStateFromModalities({ modalities: { input: ['text', 'Image'] } })).toBe(
      'unsupported'
    )
  })

  it('returns unknown when modalities is absent', () => {
    expect(imageInputStateFromModalities({})).toBe('unknown')
    expect(imageInputStateFromModalities({ id: 'm-1', name: 'M1' })).toBe('unknown')
  })

  it('returns unknown when modalities.input is absent, not an array, or empty', () => {
    expect(imageInputStateFromModalities({ modalities: {} })).toBe('unknown')
    expect(imageInputStateFromModalities({ modalities: { input: 'image' } })).toBe('unknown')
    expect(imageInputStateFromModalities({ modalities: { input: null } })).toBe('unknown')
    expect(imageInputStateFromModalities({ modalities: { input: {} } })).toBe('unknown')
    expect(imageInputStateFromModalities({ modalities: { input: [] } })).toBe('unknown')
  })

  it('returns unknown when any element is not a string', () => {
    expect(imageInputStateFromModalities({ modalities: { input: ['text', 1] } })).toBe('unknown')
    // Load-bearing: the array DOES contain 'image', and the answer is still
    // unknown — a malformed list is not evidence of anything.
    expect(imageInputStateFromModalities({ modalities: { input: ['image', null] } })).toBe(
      'unknown'
    )
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
    // Live data IS the observation: acquisition and capture coincide.
    expect(res.capturedAt).toBe(res.fetchedAt)
  })

  it('falls back to the vendored snapshot when the fetch throws (network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await loadModelsDevCatalog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // A vendored fallback loaded today is NOT a fresh observation: the capture
      // stamp stays the snapshot's baked date.
      now: () => new Date('2026-09-16T12:00:00.000Z'),
    })
    expect(res.source).toBe('vendored')
    expect(res.fetchedAt).toBe('2026-09-16T12:00:00.000Z')
    expect(res.capturedAt).toBe(VENDORED_MODELS_DEV_SNAPSHOT_CAPTURED_AT)
    expect(res.capturedAt).not.toBe(res.fetchedAt)
    // The vendored snapshot must carry our mapped providers so the sync has data.
    const byProvider = mapCatalogToProviders(res.catalog)
    expect(byProvider.claude.length).toBeGreaterThan(0)
    expect(byProvider.openai.length).toBeGreaterThan(0)
    // #654: it must also carry `modalities.input`. The offline path is the one
    // taken when there is NO network — exactly where an operator cannot go look
    // the answer up — so a snapshot regenerated without modalities would report
    // every model's image capability as `unknown` and make the feature inert
    // precisely where it is least recoverable. Both verdicts are asserted: a
    // snapshot that only ever answers `supported` would be just as wrong.
    const states = Object.values(byProvider)
      .flat()
      .map(m => m.image_input_state)
    expect(states.filter(s => s === 'supported').length).toBeGreaterThan(0)
    expect(states.filter(s => s === 'unsupported').length).toBeGreaterThan(0)
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
