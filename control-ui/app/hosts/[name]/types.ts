import type { HostTab } from '@constants/hostDetails'

export type ChannelResource = {
  metadata?: { name?: string; namespace?: string }
  spec?: Record<string, unknown> & { hostRef?: string }
}

export type SecretResource = {
  name?: string
  metadata?: { name?: string }
}

export type { HostTab }
