import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CREDENTIAL_SLOTS,
  PROVIDER_DISPLAY_LABELS,
  PROVIDER_IDS,
  PROVIDER_NON_SECRET_ENV,
  isCredentialSlotOwnedByProvider,
  isLlmProviderId,
} from '@clerum/llm-providers'

// Unit tests for the shared @clerum/llm-providers package (spec §3-R4). Hosted
// here because the package ships as prebuilt cjs+d.ts with no local test runner
// (same convention as @clerum/image-policy → control-api/test/imagePolicy.test.ts).

describe('PROVIDER_IDS', () => {
  it('is the canonical 22-provider set in auto-detect priority order', () => {
    expect([...PROVIDER_IDS]).toEqual([
      'openai',
      'claude',
      'zai',
      'bailian',
      'vertex',
      'bedrock',
      'openrouter',
      'gemini',
      'deepseek',
      'groq',
      'together',
      'fireworks',
      'mistral',
      'xai',
      'cerebras',
      'deepinfra',
      'perplexity',
      'moonshot',
      'nebius',
      'novita',
      'minimax',
      'azure',
    ])
  })

  it('has a display label and a credential-slot entry for every id', () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_DISPLAY_LABELS[id]).toBeTruthy()
      expect(PROVIDER_CREDENTIAL_SLOTS[id].length).toBeGreaterThan(0)
      expect(PROVIDER_NON_SECRET_ENV[id]).toBeInstanceOf(Array)
    }
  })
})

describe('isLlmProviderId', () => {
  it('accepts every canonical id', () => {
    for (const id of PROVIDER_IDS) expect(isLlmProviderId(id)).toBe(true)
  })

  it('accepts the newly added providers (single-key + azure)', () => {
    expect(isLlmProviderId('groq')).toBe(true)
    expect(isLlmProviderId('openrouter')).toBe(true)
    expect(isLlmProviderId('gemini')).toBe(true)
    expect(isLlmProviderId('azure')).toBe(true)
  })

  it('rejects unknown providers', () => {
    expect(isLlmProviderId('not-a-provider')).toBe(false)
    expect(isLlmProviderId('')).toBe(false)
  })

  // SECURITY: the guard must use an own-property check, not `in` — otherwise
  // prototype-chain keys pass and blow up downstream (workflowService.configure,
  // control-api provider validation).
  it('is prototype-safe (own-property check, not `in`)', () => {
    expect(isLlmProviderId('constructor')).toBe(false)
    expect(isLlmProviderId('__proto__')).toBe(false)
    expect(isLlmProviderId('hasOwnProperty')).toBe(false)
    expect(isLlmProviderId('toString')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isLlmProviderId(null)).toBe(false)
    expect(isLlmProviderId(undefined)).toBe(false)
    expect(isLlmProviderId(42)).toBe(false)
    expect(isLlmProviderId({})).toBe(false)
  })
})

describe('credential slots', () => {
  it('models the multi-slot providers from B1', () => {
    expect(PROVIDER_CREDENTIAL_SLOTS.openai).toEqual([
      { dataKey: 'openai-api-key', envName: 'OPENAI_API_KEY', required: true },
    ])
    // Vertex: single service-account JSON slot.
    expect(PROVIDER_CREDENTIAL_SLOTS.vertex).toEqual([
      {
        dataKey: 'vertex-service-account-json',
        envName: 'VERTEX_SERVICE_ACCOUNT_JSON',
        required: true,
        // Explicit JSON/multi-line flag (retired the -json name heuristic).
        multiline: true,
      },
    ])
    // Bedrock: the AWS access-key pair (two required slots).
    expect(PROVIDER_CREDENTIAL_SLOTS.bedrock.map(s => s.dataKey)).toEqual([
      'aws-access-key-id',
      'aws-secret-access-key',
    ])
    expect(PROVIDER_CREDENTIAL_SLOTS.bedrock.every(s => s.required)).toBe(true)
  })

  it('uses one ownership rule for additive and structured provider slots', () => {
    expect(isCredentialSlotOwnedByProvider('openai', 'openai-api-key-fallback-a')).toBe(true)
    expect(isCredentialSlotOwnedByProvider('zai', 'zai-api-key-fallback-a')).toBe(true)
    expect(isCredentialSlotOwnedByProvider('bedrock', 'aws-access-key-id-fallback')).toBe(false)
    expect(isCredentialSlotOwnedByProvider('bedrock', 'aws-access-key-id')).toBe(true)
    expect(isCredentialSlotOwnedByProvider('vertex', 'vertex-service-account-json-fallback')).toBe(
      false
    )
    expect(isCredentialSlotOwnedByProvider('vertex', 'vertex-service-account-json')).toBe(true)
  })
})

describe('non-secret per-Host env', () => {
  it('declares Vertex project/location and Bedrock region; none for API-key providers', () => {
    expect(PROVIDER_NON_SECRET_ENV.vertex).toEqual([
      { envName: 'VERTEX_PROJECT_ID', required: true },
      { envName: 'VERTEX_LOCATION', required: false },
    ])
    expect(PROVIDER_NON_SECRET_ENV.bedrock).toEqual([{ envName: 'AWS_REGION', required: true }])
    expect(PROVIDER_NON_SECRET_ENV.openai).toEqual([])
    expect(PROVIDER_NON_SECRET_ENV.claude).toEqual([])
    expect(PROVIDER_NON_SECRET_ENV.zai).toEqual([])
    expect(PROVIDER_NON_SECRET_ENV.bailian).toEqual([])
  })

  it('declares azure required AZURE_OPENAI_ENDPOINT; the 15 single-key providers have none', () => {
    // azure carries a REQUIRED non-secret env — the reason it is admissible on a
    // Host (host-<ref>-env delivers it) but excluded from the mono-credential
    // WRC/workflowrecipe path.
    expect(PROVIDER_NON_SECRET_ENV.azure).toContainEqual({
      envName: 'AZURE_OPENAI_ENDPOINT',
      required: true,
    })
    for (const id of [
      'openrouter',
      'gemini',
      'deepseek',
      'groq',
      'together',
      'fireworks',
      'mistral',
      'xai',
      'cerebras',
      'deepinfra',
      'perplexity',
      'moonshot',
      'nebius',
      'novita',
      'minimax',
    ] as const) {
      expect(PROVIDER_NON_SECRET_ENV[id]).toEqual([])
    }
  })
})
