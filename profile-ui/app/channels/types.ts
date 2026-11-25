import type { ProfileChannelSection } from '../settings/types'

export type SocialChannelTabKey = 'telegram' | 'slack' | 'teams'

export type SocialChannelTab = {
  key: SocialChannelTabKey
  label: string
  description: string
  sections: ProfileChannelSection[]
  status: 'active' | 'request' | 'comingSoon'
}
