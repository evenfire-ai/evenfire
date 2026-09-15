import { describe, expect, it } from 'vitest'
import { CODEX_CONNECTION_REF_ANNOTATION } from '../src/services/codexSubscriptionConnection.js'
import {
  SUBSCRIPTION_CONNECTION_REF_ANNOTATION,
  attestRequestedBrokerProvider,
  collectHostOauthBrokerProviders,
  collectRecipeOauthBrokerProviders,
  readSubscriptionConnectionRef,
} from '../src/services/subscriptionGrantIdentity.js'

describe('collectHostOauthBrokerProviders', () => {
  it('includes Codex fallbacks when the primary is static', () => {
    expect(
      collectHostOauthBrokerProviders({
        model: { provider: 'openai', name: 'gpt-5.1' },
        secretRef: 'llm',
        llmPolicy: { fallbacks: [{ provider: 'codex-subscription', name: 'gpt-5.3-codex' }] },
        allowedModels: [{ provider: 'codex-subscription', name: 'gpt-5.3-codex' }],
      })
    ).toEqual(['codex-subscription'])
  })

  it('returns empty when every target is static', () => {
    expect(
      collectHostOauthBrokerProviders({
        model: { provider: 'openai', name: 'gpt-5.1' },
      })
    ).toEqual([])
  })
})

describe('attestRequestedBrokerProvider', () => {
  it('allows a static primary plus Codex fallback to spend Codex', () => {
    const result = attestRequestedBrokerProvider({
      requestedProvider: 'codex-subscription',
      liveBrokerProviders: collectHostOauthBrokerProviders({
        model: { provider: 'openai' },
        llmPolicy: { fallbacks: [{ provider: 'codex-subscription' }] },
      }),
      liveConnectionRef: 'team-plus',
    })
    expect(result).toEqual({
      ok: true,
      provider: 'codex-subscription',
      connectionKey: 'team-plus',
    })
  })

  it('denies a Codex body on a static-only Host', () => {
    const result = attestRequestedBrokerProvider({
      requestedProvider: 'codex-subscription',
      liveBrokerProviders: collectHostOauthBrokerProviders({
        model: { provider: 'openai' },
      }),
      liveConnectionRef: 'team-plus',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('host_binding_mismatch')
  })

  it('returns unassigned when connectionRef is empty', () => {
    const result = attestRequestedBrokerProvider({
      requestedProvider: 'codex-subscription',
      liveBrokerProviders: ['codex-subscription'],
      liveConnectionRef: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unassigned_connection')
  })
})

describe('readSubscriptionConnectionRef', () => {
  it('reads the Codex alias when only that key is set', () => {
    const result = readSubscriptionConnectionRef({
      provider: 'codex-subscription',
      annotations: { [CODEX_CONNECTION_REF_ANNOTATION]: 'team-plus' },
    })
    expect(result).toEqual({ ok: true, connectionKey: 'team-plus' })
  })

  it('fails closed when Codex annotations disagree', () => {
    const result = readSubscriptionConnectionRef({
      provider: 'codex-subscription',
      annotations: {
        [CODEX_CONNECTION_REF_ANNOTATION]: 'team-plus',
        [SUBSCRIPTION_CONNECTION_REF_ANNOTATION]: 'other-key',
      },
    })
    expect(result.ok).toBe(false)
  })

  it('fails closed when a non-Codex broker still has the Codex alias', () => {
    const result = readSubscriptionConnectionRef({
      provider: 'openai',
      annotations: { [CODEX_CONNECTION_REF_ANNOTATION]: 'team-plus' },
    })
    expect(result.ok).toBe(false)
  })
})

describe('collectRecipeOauthBrokerProviders', () => {
  it('includes Codex promptTargets when the recipe agent is static', () => {
    expect(
      collectRecipeOauthBrokerProviders({
        agent: { provider: 'openai' },
        promptTargets: [{ provider: 'codex-subscription' }],
      })
    ).toEqual(['codex-subscription'])
  })
})
