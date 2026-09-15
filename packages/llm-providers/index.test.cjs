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

  it('keeps production maps Codex-only and rejects unknown ids', () => {
    assert.deepEqual(providers.OAUTH_BROKER_IDS, ['codex-subscription'])
    assert.equal(providers.PROVIDER_AUTH_MODE['codex-subscription'], 'oauth-broker')
    assert.equal(providers.PROVIDER_AUTH_MODE.openai, 'static-credentials')
    assert.equal(providers.PROVIDER_MODEL_CATALOG_MODE['codex-subscription'], 'dynamic')
    assert.throws(() => providers.providerDescriptor('not-a-provider'))
    assert.throws(() => providers.providerDescriptor('fixture-broker'))
    const desc = providers.providerDescriptor('codex-subscription')
    assert.equal(desc.authMode, 'oauth-broker')
    assert.equal(desc.executeScope, 'llm:codex:execute')
    assert.equal(desc.proxyApp, 'codex-llm-proxy')
    assert.equal(desc.proxyService, 'codex-llm-proxy')
  })
})
