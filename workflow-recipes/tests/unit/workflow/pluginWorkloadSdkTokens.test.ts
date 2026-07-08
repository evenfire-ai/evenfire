import { describe, expect, it } from 'vitest'
import {
  pluginWorkloadSdkSecretTokensMatch,
  pluginWorkloadSdkTokenSecretKey,
} from '../../../src/workflow/pluginWorkloadSdkTokens'

describe('pluginWorkloadSdkSecretTokensMatch', () => {
  it('returns true when caller token keys and values match', () => {
    const existing = {
      [pluginWorkloadSdkTokenSecretKey('api')]: 'token-a',
      [pluginWorkloadSdkTokenSecretKey('worker')]: 'token-b',
    }
    expect(
      pluginWorkloadSdkSecretTokensMatch(existing, {
        api: 'token-a',
        worker: 'token-b',
      })
    ).toBe(true)
  })

  it('returns false when a caller token changes', () => {
    const existing = { [pluginWorkloadSdkTokenSecretKey('api')]: 'token-a' }
    expect(pluginWorkloadSdkSecretTokensMatch(existing, { api: 'token-b' })).toBe(false)
  })

  it('returns false when a stale caller key remains in the Secret', () => {
    const existing = {
      [pluginWorkloadSdkTokenSecretKey('api')]: 'token-a',
      [pluginWorkloadSdkTokenSecretKey('retired')]: 'token-old',
    }
    expect(pluginWorkloadSdkSecretTokensMatch(existing, { api: 'token-a' })).toBe(false)
  })
})
