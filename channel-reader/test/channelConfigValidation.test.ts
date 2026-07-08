import { describe, expect, it } from 'vitest'
import { validateCommunicationChannelConfig } from '../src/channelConfigValidation'
import type { CommunicationChannelCRD } from '../src/types'

function telegramChannel(userIds?: string[]): CommunicationChannelCRD {
  return {
    name: 'telegram-verification',
    namespace: 'channels',
    spec: {
      hostRef: 'chatllm',
      credentialsSecretRef: { name: 'telegram-verification-credentials' },
      telegram: [{ channelId: 'verification-bootstrap', userIds }],
    },
  }
}

describe('validateCommunicationChannelConfig telegram userIds', () => {
  it('allows a Telegram bot target before any user is verified', () => {
    expect(() => validateCommunicationChannelConfig(telegramChannel())).not.toThrow()
    expect(() => validateCommunicationChannelConfig(telegramChannel([]))).not.toThrow()
  })

  it('still rejects blank Telegram user ids when configured', () => {
    expect(() => validateCommunicationChannelConfig(telegramChannel(['123456', '']))).toThrow(
      /userIds contains empty values/
    )
  })
})
