'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const providers = require('./index.cjs')

describe('buildProviderMaps', () => {
  it('exports a pure builder that classifies injected broker ids without editing production maps', () => {
    assert.equal(typeof providers.buildProviderMaps, 'function')
    const maps = providers.buildProviderMaps(
      ['openai', 'codex-subscription', 'fixture-broker'],
      ['codex-subscription', 'fixture-broker']
    )
    assert.equal(maps.PROVIDER_AUTH_MODE['fixture-broker'], 'oauth-broker')
    assert.equal(maps.PROVIDER_AUTH_MODE.openai, 'static-credentials')
    assert.equal(maps.PROVIDER_AUTH_MODE['codex-subscription'], 'oauth-broker')
    assert.equal(maps.PROVIDER_MODEL_CATALOG_MODE['fixture-broker'], 'dynamic')
    assert.equal(maps.PROVIDER_MODEL_CATALOG_MODE.openai, 'static')
  })

  it('keeps production maps to known oauth-broker ids and rejects unknown ids', () => {
    assert.deepEqual(providers.OAUTH_BROKER_IDS, ['codex-subscription', 'grok-subscription'])
    assert.equal(providers.PROVIDER_AUTH_MODE['codex-subscription'], 'oauth-broker')
    assert.equal(providers.PROVIDER_AUTH_MODE['grok-subscription'], 'oauth-broker')
    assert.equal(providers.PROVIDER_AUTH_MODE.xai, 'static-credentials')
    assert.equal(providers.PROVIDER_AUTH_MODE.openai, 'static-credentials')
    assert.equal(providers.PROVIDER_MODEL_CATALOG_MODE['grok-subscription'], 'dynamic')
    assert.throws(() => providers.providerDescriptor('not-a-provider'))
    assert.throws(() => providers.providerDescriptor('fixture-broker'))
    const desc = providers.providerDescriptor('grok-subscription')
    assert.equal(desc.authMode, 'oauth-broker')
    assert.equal(desc.executeScope, 'llm:grok:execute')
    assert.equal(desc.proxyApp, 'grok-llm-proxy')
    assert.equal(desc.proxyService, 'grok-llm-proxy')
    assert.deepEqual(desc.credentialSlots, [])
  })
})

describe('provider families', () => {
  it('maps every provider id to a family owned by a real provider id', () => {
    assert.equal(typeof providers.PROVIDER_FAMILY, 'object')
    // Exhaustive by assertion: a provider added without a family entry is a bug,
    // never a silent default.
    assert.deepEqual(
      Object.keys(providers.PROVIDER_FAMILY).sort(),
      [...providers.PROVIDER_IDS].sort()
    )
    for (const id of providers.PROVIDER_IDS) {
      const family = providers.PROVIDER_FAMILY[id]
      assert.ok(
        providers.isLlmProviderId(family),
        `family '${family}' of '${id}' is not a provider id`
      )
      // Closed: the owner of a family belongs to its own family, so resolving
      // twice equals resolving once and no chain can form.
      assert.equal(
        providers.PROVIDER_FAMILY[family],
        family,
        `family '${family}' is not its own owner`
      )
    }
  })

  it('groups the two subscription brokers with the vendor that owns them', () => {
    assert.equal(providers.providerFamily('openai'), 'openai')
    assert.equal(providers.providerFamily('codex-subscription'), 'openai')
    assert.equal(providers.providerFamily('xai'), 'xai')
    assert.equal(providers.providerFamily('grok-subscription'), 'xai')
  })

  it('leaves every other provider in a family of its own', () => {
    const grouped = new Set(['openai', 'codex-subscription', 'xai', 'grok-subscription'])
    for (const id of providers.PROVIDER_IDS) {
      if (grouped.has(id)) continue
      assert.equal(providers.providerFamily(id), id)
    }
  })

  it('rejects an unknown provider instead of inventing a family for it', () => {
    // The predicate is load-bearing: a bare assert.throws is satisfied by
    // `providerFamily is not a function`, so it would pass against no
    // implementation at all. Require the rejection this function owns.
    assert.throws(() => providers.providerFamily('not-a-provider'), /unknown provider/)
    assert.throws(() => providers.providerFamily(undefined), /unknown provider/)
  })

  it('lists family members in PROVIDER_IDS order, and nothing for an unknown family', () => {
    assert.deepEqual(providers.familyProviderIds('openai'), ['openai', 'codex-subscription'])
    assert.deepEqual(providers.familyProviderIds('xai'), ['xai', 'grok-subscription'])
    assert.deepEqual(providers.familyProviderIds('claude'), ['claude'])
    // A free-form provider string reaches this from the prices table. The honest
    // answer is that no known provider belongs to that family.
    assert.deepEqual(providers.familyProviderIds('not-a-provider'), [])
  })

  it('carries the family on the descriptor', () => {
    assert.equal(providers.providerDescriptor('grok-subscription').family, 'xai')
    assert.equal(providers.providerDescriptor('xai').family, 'xai')
    assert.equal(providers.providerDescriptor('codex-subscription').family, 'openai')
    assert.equal(providers.providerDescriptor('claude').family, 'claude')
  })
})
