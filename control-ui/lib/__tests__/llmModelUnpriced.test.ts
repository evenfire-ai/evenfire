import { describe, expect, it } from 'vitest'
import { buildUnpricedKeys, isUnpricedAllowedModel } from '../llmModelUnpriced'

describe('buildUnpricedKeys', () => {
  it('keys each entry as provider/model and bare model', () => {
    const keys = buildUnpricedKeys([{ provider: 'claude', model: 'claude-haiku-4-5' }])
    expect(keys.has('claude/claude-haiku-4-5')).toBe(true)
    expect(keys.has('claude-haiku-4-5')).toBe(true)
  })

  it('keys a provider-less entry (budget pins a model without a provider) only bare', () => {
    const keys = buildUnpricedKeys([{ provider: null, model: 'glm-5.1' }])
    expect(keys.has('glm-5.1')).toBe(true)
    expect(keys.size).toBe(1)
  })
})

describe('isUnpricedAllowedModel', () => {
  const keys = buildUnpricedKeys([
    { provider: 'claude', model: 'claude-haiku-4-5' },
    { provider: null, model: 'glm-5.1' },
  ])

  it('flags an enabled allowed model matched by provider/model', () => {
    expect(
      isUnpricedAllowedModel({ provider: 'claude', model: 'claude-haiku-4-5', enabled: true }, keys)
    ).toBe(true)
  })

  it('flags an enabled allowed model matched only by bare model name', () => {
    expect(isUnpricedAllowedModel({ provider: 'zai', model: 'glm-5.1', enabled: true }, keys)).toBe(
      true
    )
  })

  it('never flags a disabled model (it cannot incur cost)', () => {
    expect(
      isUnpricedAllowedModel(
        { provider: 'claude', model: 'claude-haiku-4-5', enabled: false },
        keys
      )
    ).toBe(false)
  })

  it('does not flag a priced model', () => {
    expect(
      isUnpricedAllowedModel({ provider: 'openai', model: 'gpt-5.4', enabled: true }, keys)
    ).toBe(false)
  })
})
