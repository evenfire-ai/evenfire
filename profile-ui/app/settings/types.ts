import type { Channels } from '@/app/types/profile'

export type ProfileChannelKey = keyof Channels

export type ProfileChannelRow = {
  id: string
  value: string
}

export type ReadonlyChannelValue = {
  id: string
  value: string
  caption: string
  actionLabel?: string
}

export type ProfileChannelDraft = Record<ProfileChannelKey, ProfileChannelRow[]>

export type ProfileChannelSection = {
  key: ProfileChannelKey
  title: string
  description: string
  placeholder: string
  addLabel: string
}

export type SocialChannelTabKey = 'telegram' | 'slack'

export type SocialChannelTab = {
  key: SocialChannelTabKey
  label: string
  description: string
  sections: ProfileChannelSection[]
  status: 'active' | 'request' | 'comingSoon'
}
