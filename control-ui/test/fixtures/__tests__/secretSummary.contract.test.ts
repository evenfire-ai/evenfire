import { describe, expect, it } from 'vitest'
import { buildSecretList, buildSecretSummary } from '../secretSummary'

describe('Secret producer fixture contract', () => {
  it('locks the exact control-api Secret list wire shape without sensitive fields', () => {
    const secret = buildSecretSummary({ name: 's1', keys: ['openai-api-key'] })

    expect(buildSecretList([secret])).toEqual({
      items: [{ name: 's1', keys: ['openai-api-key'] }],
    })
    expect(Object.keys(secret).sort()).toEqual(['keys', 'name'])
    expect(secret).not.toHaveProperty('value')
    expect(secret).not.toHaveProperty('values')
    expect(secret).not.toHaveProperty('metadata')
  })
})
