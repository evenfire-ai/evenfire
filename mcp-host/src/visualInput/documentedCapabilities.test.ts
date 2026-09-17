import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENTED_OPENAI_IMAGE_MODELS,
  OFFICIAL_OPENAI_BASE_URL,
  OPENAI_DOCUMENTED_EVIDENCE,
  OPENAI_PROVIDER,
  getDocumentedOpenAIImageCapability,
} from './documentedCapabilities'

const OFFICIAL = OFFICIAL_OPENAI_BASE_URL
/** The exact default the OpenAI SDK resolves for an absent base URL. */
const SDK_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DOCUMENTED_MODEL = 'gpt-4.1'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function expectSupported(model: string, baseURL: string | undefined): void {
  expect(getDocumentedOpenAIImageCapability(model, baseURL)).toEqual({
    status: 'supported',
    provider: 'openai',
    model,
    evidence: 'openai-documented-model-contract',
  })
}

function expectUnknown(model: string, baseURL: string | undefined = OFFICIAL): void {
  expect(getDocumentedOpenAIImageCapability(model, baseURL)).toEqual({ status: 'unknown' })
}

describe('getDocumentedOpenAIImageCapability', () => {
  it('reports the documented contract for every table entry, alias and snapshot alike', () => {
    expect(OPENAI_PROVIDER).toBe('openai')
    expect(OPENAI_DOCUMENTED_EVIDENCE).toBe('openai-documented-model-contract')
    expect(OFFICIAL_OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(DOCUMENTED_OPENAI_IMAGE_MODELS.length).toBeGreaterThan(0)

    for (const entry of DOCUMENTED_OPENAI_IMAGE_MODELS) {
      expectSupported(entry.id, OFFICIAL)
      // The SDK default and the explicit official base must agree.
      expectSupported(entry.id, SDK_DEFAULT_BASE_URL)
      expect(getDocumentedOpenAIImageCapability(entry.id, undefined)).toEqual({ status: 'unknown' })
      for (const snapshot of entry.snapshots) expectSupported(snapshot, OFFICIAL)
    }
  })

  it('answers for the model the OpenAI provider actually defaults to', () => {
    expectSupported('gpt-5.4-mini', SDK_DEFAULT_BASE_URL)
    expectSupported('gpt-5.4-mini-2026-03-17', SDK_DEFAULT_BASE_URL)
  })

  it('keeps one source of truth per documented id, with no collisions', () => {
    const seen = new Map<string, string>()
    for (const entry of DOCUMENTED_OPENAI_IMAGE_MODELS) {
      expect(entry.source).toBe(`https://developers.openai.com/api/docs/models/${entry.id}`)
      for (const id of [entry.id, ...entry.snapshots]) {
        expect(seen.has(id)).toBe(false)
        seen.set(id, entry.source)
      }
      for (const snapshot of entry.snapshots) {
        // A snapshot of another model must never be reachable through this entry.
        expect(snapshot.startsWith(`${entry.id}-`)).toBe(true)
      }
    }
    // Every documented id the getter accepts is covered by the table above.
    expect([...seen.keys()]).toContain(DOCUMENTED_MODEL)
  })

  it('binds the answer to the official endpoint, with one trailing slash at most', () => {
    expectSupported(DOCUMENTED_MODEL, 'https://api.openai.com/v1')
    expectSupported(DOCUMENTED_MODEL, 'https://api.openai.com/v1/')
    // Host names are case-insensitive; the explicit default port is the same origin.
    expectSupported(DOCUMENTED_MODEL, 'https://API.OPENAI.COM/v1')
    expectSupported(DOCUMENTED_MODEL, 'https://api.openai.com:443/v1')
  })

  it('returns unknown for every other origin, path, scheme, or credentials', () => {
    const rejected = [
      // Different scheme, host, or port: a different deployment.
      'http://api.openai.com/v1',
      'https://api.openai.com.evil.example/v1',
      'https://api.openai.com.evil.example./v1',
      'https://evil.example/?next=https://api.openai.com/v1',
      'https://evil.example/api.openai.com/v1',
      'https://api.openai.com:8443/v1',
      'https://api.openai.com./v1',
      // Credentials, query, or fragment change the request target.
      'https://user:password@api.openai.com/v1',
      'https://api.openai.com@evil.example/v1',
      'https://api.openai.com/v1?x=1',
      'https://api.openai.com/v1#fragment',
      'https://api.openai.com/v1#@evil.example',
      // Paths that are not the documented base.
      'https://api.openai.com',
      'https://api.openai.com/',
      'https://api.openai.com/v1//',
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v2',
      'https://api.openai.com/V1',
      // Other documented OpenAI base URLs and gateways.
      'https://openrouter.ai/api/v1',
      'https://example.openai.azure.com/openai/deployments/gpt-4.1',
      'http://127.0.0.1:11434/v1',
      'https://api.anthropic.com/v1',
      // Not a usable absolute base URL.
      '',
      '/v1',
      'api.openai.com/v1',
      'not a url',
    ]

    for (const baseURL of rejected) expectUnknown(DOCUMENTED_MODEL, baseURL)
  })

  it('never infers support from a prefix, family, or neighbouring id', () => {
    const undocumented = [
      // Same families, ids that are not in the table.
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4.1-preview',
      'gpt-4.1-2025-04-14x',
      'gpt-4.1-20250414',
      'gpt-4o-2024-05-14',
      'gpt-4o-audio-preview',
      'gpt-4o-mini-realtime-preview',
      'gpt-4o-transcribe',
      'gpt-5-pro',
      'gpt-5.2-pro',
      'gpt-5.5-pro',
      'gpt-5.5',
      'gpt-5.4-pro',
      'gpt-5.4-mini-2026-03-17x',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.3-codex-spark',
      'gpt-6',
      'o3',
      'o4-mini',
      'text-embedding-3-large',
      'gpt-image-1',
      'dall-e-3',
      'whisper-1',
      'tts-1',
      // Adjacent or injected spellings of a documented id.
      'gpt-4.1 ',
      ' gpt-4.1',
      'gpt-4.1\n',
      'gpt-4.1\t',
      'GPT-4.1',
      'xgpt-4.1',
      'gpt-4.1/../gpt-4.1',
      'gpt-4.1%00',
      'gpt-4.1-2025-04-14.',
      'gpt-4.1-evil',
      '',
      ' ',
    ]

    for (const model of undocumented) expectUnknown(model)
  })

  it('does not trim, fold, or otherwise normalize the requested id', () => {
    // The documented id is answered verbatim; the same letters with any added
    // character are a different id and stay unknown.
    expect(getDocumentedOpenAIImageCapability(`  ${DOCUMENTED_MODEL}`, OFFICIAL)).toEqual({
      status: 'unknown',
    })
    expect(getDocumentedOpenAIImageCapability(DOCUMENTED_MODEL.toUpperCase(), OFFICIAL)).toEqual({
      status: 'unknown',
    })
    expectSupported(DOCUMENTED_MODEL, OFFICIAL)
  })

  it('answers without any network request or credential', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expectSupported(DOCUMENTED_MODEL, OFFICIAL)
    expectUnknown('gpt-4.1-nope')
    expectUnknown(DOCUMENTED_MODEL, 'https://proxy.example/v1')

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
