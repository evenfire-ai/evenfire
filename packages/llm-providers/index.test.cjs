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

describe('image input capability', () => {
  it('fails closed for Z.AI and both oauth-broker subscriptions', () => {
    assert.deepEqual(providers.LLM_IMAGE_INPUT_UNSUPPORTED_IDS, [
      'zai',
      'codex-subscription',
      'grok-subscription',
    ])
    assert.equal(providers.llmProviderSupportsImageInput('zai'), false)
    assert.equal(providers.llmProviderSupportsImageInput('codex-subscription'), false)
    assert.equal(providers.llmProviderSupportsImageInput('grok-subscription'), false)
    assert.equal(providers.llmProviderSupportsImageInput('openai'), true)
    assert.equal(providers.llmProviderSupportsImageInput('claude'), true)
    assert.equal(providers.llmProviderSupportsImageInput('xai'), true)
    assert.equal(providers.llmProviderSupportsImageInput('unknown'), false)
    assert.equal(providers.llmProviderSupportsImageInput(''), false)
  })

  it('names the active provider in the unsupported message', () => {
    assert.match(
      providers.imageAttachmentUnsupportedMessage('grok-subscription'),
      /xAI Grok Subscription/
    )
    assert.match(
      providers.imageAttachmentUnsupportedMessage('codex-subscription'),
      /OpenAI Codex Subscription/
    )
    assert.match(providers.imageAttachmentUnsupportedMessage('zai'), /Z\.AI/)
    assert.match(providers.imageAttachmentUnsupportedMessage('not-a-provider'), /this provider/)
  })
})
