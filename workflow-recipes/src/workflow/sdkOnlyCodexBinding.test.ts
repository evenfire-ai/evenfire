import { describe, expect, it, vi } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import {
  deriveSdkOnlyCodexBinding,
  isPluginWorkloadSdkCodexBindingProof,
  readVerifiedSdkOnlyCodexBinding,
  resolveSdkOnlyCodexBinding,
  verifySdkOnlyCodexBindingHash,
} from './sdkOnlyCodexBinding'

const MODEL = 'gpt-5.6-luna'

const HASH = computeCodexPolicyHash({
  model: MODEL,
  catalogRevision: 3,
  credentialRevision: 1,
  connectionKey: 'team-plus',
})

/**
 * An executable allowlist ConfigMap in the legacy (map-less) shape: the Codex
 * flag is on, the connection is `connected`, and the catalog actually lists the
 * model. Every one of those is load-bearing — the binding gate is the same
 * cascade that derives `llm:codex:execute`, so dropping any of them must drop
 * the binding too.
 */
function eligibleLegacyConfigMap(overrides?: {
  annotations?: Record<string, string>
  stale?: boolean
  models?: string[]
}) {
  const models = overrides?.models ?? [MODEL]
  return {
    metadata: {
      annotations: {
        'clerum.io/catalog-revision': '3',
        'clerum.io/connection-revision': '1',
        'clerum.io/codex-connection-status': 'connected',
        'clerum.io/codex-enabled': 'true',
        ...overrides?.annotations,
      },
    },
    data: {
      'codex-subscription': JSON.stringify(
        models.map(model => ({ model, stale: overrides?.stale === true }))
      ),
    },
  }
}

/** The same grant expressed through the per-connection map. */
function eligibleMappedConfigMap(overrides?: {
  status?: string
  models?: string[]
  catalogModels?: string[]
}) {
  return {
    metadata: {
      annotations: {
        'clerum.io/catalog-revision': '9',
        'clerum.io/connection-revision': '9',
        'clerum.io/codex-enabled': 'true',
        'clerum.io/codex-connections': JSON.stringify({
          'team-plus': {
            status: overrides?.status ?? 'connected',
            catalogRevision: 3,
            connectionRevision: 1,
            models: overrides?.models ?? [MODEL],
          },
        }),
      },
    },
    data: {
      'codex-subscription': JSON.stringify(
        (overrides?.catalogModels ?? [MODEL]).map(model => ({ model, stale: false }))
      ),
    },
  }
}

describe('deriveSdkOnlyCodexBinding', () => {
  it('returns a hashed v3 proof for an assigned executable catalog', () => {
    const binding = deriveSdkOnlyCodexBinding({
      provider: 'codex-subscription',
      model: MODEL,
      connectionKey: 'team-plus',
      configMap: eligibleLegacyConfigMap(),
    })
    expect(binding).toEqual({
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
    })
    expect(verifySdkOnlyCodexBindingHash(binding!)).toBe(true)
    expect(isPluginWorkloadSdkCodexBindingProof(binding)).toBe(true)
  })

  it('prefers the assigned connection revisions over the global annotations', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: eligibleMappedConfigMap(),
      })
    ).toEqual({
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
    })
  })

  it('returns null when the assigned catalog excludes the requested model', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: eligibleMappedConfigMap({ models: ['gpt-5.1'], catalogModels: ['gpt-5.1'] }),
      })
    ).toBeNull()
  })

  it('returns null when the connection is not connected', () => {
    // The revocation path: revisions and catalog are intact, only the status
    // degraded. Reading revisions structurally (the Host-chat `toPolicyBinding`
    // contract) would still mint here — the execution gate must not.
    for (const status of ['reauth-required', 'unavailable', 'revoked', 'disconnected']) {
      expect(
        deriveSdkOnlyCodexBinding({
          provider: 'codex-subscription',
          model: MODEL,
          connectionKey: 'team-plus',
          configMap: eligibleLegacyConfigMap({
            annotations: { 'clerum.io/codex-connection-status': status },
          }),
        })
      ).toBeNull()
    }
  })

  it('returns null when the Codex feature flag is off', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: eligibleLegacyConfigMap({
          annotations: { 'clerum.io/codex-enabled': 'false' },
        }),
      })
    ).toBeNull()
  })

  it('returns null when the catalog row is stale', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: eligibleLegacyConfigMap({ stale: true }),
      })
    ).toBeNull()
  })

  it('returns null for a revisions-only ConfigMap that lists no catalog', () => {
    // Divergence #5: a legacy ConfigMap carrying nothing but revision
    // annotations used to mint a live execution binding while the reconciler
    // withheld `llm:codex:execute` for the very same ConfigMap.
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: {
          metadata: {
            annotations: {
              'clerum.io/catalog-revision': '3',
              'clerum.io/connection-revision': '1',
            },
          },
        },
      })
    ).toBeNull()
  })

  it('returns null when the ConfigMap could not be read', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: undefined,
      })
    ).toBeNull()
  })

  // R4-B1: the reconciler used to answer "was the catalog decidable?" from a
  // pure IO flag, which is true for a ConfigMap that reads fine and parses
  // badly. These pin the single verdict both paths now share: an unreadable
  // ConfigMap and a malformed one are equally `uncertain`, while a deliberate
  // "Codex is off" is `ineligible` — a decision, not a doubt.
  it('reports an unreadable ConfigMap as uncertain', () => {
    expect(
      resolveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: undefined,
      })
    ).toMatchObject({ binding: null, eligibility: 'uncertain' })
  })

  it('reports a readable but malformed ConfigMap as uncertain, not as a decision', () => {
    const malformed = eligibleLegacyConfigMap()
    malformed.metadata!.annotations!['clerum.io/catalog-revision'] = 'not-a-number'

    expect(
      resolveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: malformed,
      })
    ).toMatchObject({ binding: null, eligibility: 'uncertain' })
  })

  it('reports a non-Codex provider as ineligible rather than uncertain', () => {
    expect(
      resolveSdkOnlyCodexBinding({
        provider: 'openai',
        model: MODEL,
        connectionKey: 'team-plus',
        configMap: eligibleLegacyConfigMap(),
      })
    ).toMatchObject({ binding: null, eligibility: 'ineligible' })
  })

  it('returns null for non-Codex providers and unassigned grants', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'openai',
        model: 'gpt-5.4-mini',
        connectionKey: 'team-plus',
        configMap: eligibleLegacyConfigMap({ models: ['gpt-5.4-mini'] }),
      })
    ).toBeNull()
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: MODEL,
        connectionKey: 'unassigned',
        configMap: eligibleLegacyConfigMap(),
      })
    ).toBeNull()
  })

  it('logs the withholding reason so an operator sees why the binding vanished', () => {
    const debug = vi.fn()
    deriveSdkOnlyCodexBinding({
      provider: 'codex-subscription',
      model: MODEL,
      connectionKey: 'team-plus',
      configMap: eligibleLegacyConfigMap({
        annotations: { 'clerum.io/codex-connection-status': 'reauth-required' },
      }),
      log: { debug },
    })
    expect(debug).toHaveBeenCalledWith(
      'Codex execution binding withheld',
      expect.objectContaining({ reason: 'connection_reauth-required', eligibility: 'ineligible' })
    )
  })

  it('rebuilds a five-field proof and drops extra keys', () => {
    const proof = {
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
      extra: true,
    }
    // R4-L1: the model is a required argument now. This call used to omit it,
    // which silently skipped the pin — the very gap the change closes.
    expect(readVerifiedSdkOnlyCodexBinding(proof, MODEL)).toEqual({
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
    })
  })

  it('rejects a well-formed proof minted for another model', () => {
    const proof = {
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
    }
    expect(readVerifiedSdkOnlyCodexBinding(proof, 'gpt-5.1')).toBeNull()
    expect(readVerifiedSdkOnlyCodexBinding(proof, MODEL)).toEqual(proof)
  })
})
