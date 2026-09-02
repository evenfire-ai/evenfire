import { describe, expect, it, vi } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import {
  isPluginWorkloadSdkCodexBindingProof,
  readVerifiedSdkOnlyCodexBinding,
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

describe('readVerifiedSdkOnlyCodexBinding', () => {
  // The derive/resolve suite moved to codexRecipeVerdict.test.ts along with
  // the functions themselves (R5-B1): those entry points were blind to
  // provenance and are deleted, not deprecated.
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
