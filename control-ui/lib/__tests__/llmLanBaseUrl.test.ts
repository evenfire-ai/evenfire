import { describe, expect, it } from 'vitest'
import { classifyLanBaseURL } from '@clerum/egress-policy'
import {
  type LlmModelCatalogEntry,
  type LlmPolicy,
  normalizeLlmPolicy,
  validateLlmLanBaseUrl,
  validateLlmPolicy,
} from '@/lib/llm'

// Candidate endpoints spanning every branch of the shared classifier. The
// EXPECTED verdict is derived from `classifyLanBaseURL` itself (the real
// producer), never hand-authored — so this test asserts parity with the
// authoritative rule, not a copy of it (spec R-4/D4, pr-discipline T1).
const CANDIDATES = [
  'http://192.168.1.50:8000/v1', // RFC1918 LAN → accepted
  'http://10.0.0.5:11434/v1', // RFC1918 LAN → accepted
  'http://172.16.4.4/v1', // RFC1918 LAN → accepted
  'http://169.254.169.254/latest/meta-data', // link-local metadata → rejected
  'http://100.64.0.1/v1', // CGNAT → rejected
  'http://8.8.8.8/v1', // public → rejected (not_private_lan)
  'http://model.default.svc.cluster.local/v1', // cluster DNS name → rejected (not_ip)
  'http://localhost:8000/v1', // DNS name → rejected (not_ip)
  'not a url', // unparseable → rejected (invalid_url)
]

describe('validateLlmLanBaseUrl (mirrors @clerum/egress-policy.classifyLanBaseURL)', () => {
  it('returns null exactly when the shared classifier accepts, non-null otherwise', () => {
    for (const url of CANDIDATES) {
      const accepted = classifyLanBaseURL(url).ok
      const message = validateLlmLanBaseUrl(url)
      expect(message === null, `${url} → classifier ok=${accepted}, validator=${message}`).toBe(
        accepted
      )
    }
  })

  it('treats an empty / whitespace value as required (the CRD/CEL demands it)', () => {
    expect(validateLlmLanBaseUrl('')).toMatch(/Enter the LAN endpoint/i)
    expect(validateLlmLanBaseUrl('   ')).toMatch(/Enter the LAN endpoint/i)
    expect(validateLlmLanBaseUrl(undefined)).toMatch(/Enter the LAN endpoint/i)
  })
})

const CATALOG: LlmModelCatalogEntry[] = [
  { provider: 'openai-compatible', model: 'local-llama', enabled: true },
  { provider: 'openai', model: 'gpt-5.4-mini', enabled: true },
]

describe('llmPolicy baseURL round-trip + validation', () => {
  it('normalizeLlmPolicy preserves a local fallback baseURL and drops blank ones', () => {
    const raw = {
      cooldownSeconds: 300,
      triggerOn: ['auth'],
      fallbacks: [
        { provider: 'openai-compatible', model: 'local-llama', baseURL: 'http://10.1.2.3:8000/v1' },
        { provider: 'openai-compatible', model: 'local-llama', baseURL: '   ' },
      ],
    }
    const policy = normalizeLlmPolicy(raw)
    expect(policy?.fallbacks[0].baseURL).toBe('http://10.1.2.3:8000/v1')
    expect(policy?.fallbacks[1].baseURL).toBeUndefined()
  })

  it('validateLlmPolicy flags a local fallback missing or with an invalid baseURL', () => {
    const missing: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['auth'],
      fallbacks: [{ provider: 'openai-compatible', model: 'local-llama' }],
    }
    expect(
      validateLlmPolicy(missing, CATALOG).some(e => /Fallback #1.*LAN endpoint/i.test(e))
    ).toBe(true)

    const clusterInternal: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['auth'],
      fallbacks: [
        {
          provider: 'openai-compatible',
          model: 'local-llama',
          baseURL: 'http://model.svc.cluster.local/v1',
        },
      ],
    }
    expect(validateLlmPolicy(clusterInternal, CATALOG).some(e => /Fallback #1/.test(e))).toBe(true)
  })

  it('validateLlmPolicy accepts a local fallback with a valid LAN baseURL', () => {
    const ok: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['auth'],
      fallbacks: [
        {
          provider: 'openai-compatible',
          model: 'local-llama',
          baseURL: 'http://192.168.10.10:8000/v1',
        },
      ],
    }
    expect(validateLlmPolicy(ok, CATALOG)).toEqual([])
  })
})
