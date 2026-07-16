import type { ChannelType } from './channelTypes'

export type CommunicationChannelProvider = Extract<ChannelType, 'telegram' | 'slack' | 'teams'>

export const COMMUNICATION_CHANNEL_PROVIDERS = [
  'telegram',
  'slack',
  'teams',
] as const satisfies readonly CommunicationChannelProvider[]

export const COMMUNICATION_CHANNEL_PROVIDER_OPTIONS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'slack', label: 'Slack' },
  { value: 'teams', label: 'Microsoft Teams' },
] as const

export function communicationChannelProviderLabel(provider: CommunicationChannelProvider): string {
  if (provider === 'telegram') return 'Telegram'
  if (provider === 'slack') return 'Slack'
  return 'Microsoft Teams'
}

export function communicationChannelProviderServiceLabel(
  provider: CommunicationChannelProvider
): string {
  if (provider === 'telegram') return 'Telegram bot'
  if (provider === 'slack') return 'Slack app'
  return 'Teams bot'
}
