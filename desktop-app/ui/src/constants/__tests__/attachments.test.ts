import { describe, expect, it } from 'vitest'
import {
  COMPOSER_IMAGE_UNSUPPORTED_PROVIDERS,
  composerImageUnsupportedMessage,
  composerProviderSupportsImageInput,
} from '../attachments'

describe('composer image capability', () => {
  it('blocks Z.AI and both oauth-broker subscriptions', () => {
    expect([...COMPOSER_IMAGE_UNSUPPORTED_PROVIDERS]).toEqual([
      'zai',
      'codex-subscription',
      'grok-subscription',
    ])
    expect(composerProviderSupportsImageInput('zai')).toBe(false)
    expect(composerProviderSupportsImageInput('codex-subscription')).toBe(false)
    expect(composerProviderSupportsImageInput('grok-subscription')).toBe(false)
    expect(composerProviderSupportsImageInput('openai')).toBe(true)
    expect(composerProviderSupportsImageInput('xai')).toBe(true)
    expect(composerProviderSupportsImageInput(null)).toBe(true)
  })

  it('names the active provider', () => {
    expect(composerImageUnsupportedMessage('grok-subscription')).toMatch(/xAI Grok Subscription/)
    expect(composerImageUnsupportedMessage('codex-subscription')).toMatch(
      /OpenAI Codex Subscription/
    )
    expect(composerImageUnsupportedMessage('zai')).toMatch(/Z\.AI/)
  })
})
