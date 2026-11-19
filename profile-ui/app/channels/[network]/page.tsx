import { notFound } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ChannelsContent } from '../ChannelsContent'
import { PROFILE_SOCIAL_CHANNEL_TABS } from '../constants'
import type { SocialChannelTabKey } from '../types'

interface SocialChannelPageProps {
  params: Promise<{ network: string }>
}

export default async function SocialChannelPage({ params }: SocialChannelPageProps) {
  const { network } = await params
  const activeSocialTab = PROFILE_SOCIAL_CHANNEL_TABS.some(tab => tab.key === network)
    ? (network as SocialChannelTabKey)
    : null
  if (!activeSocialTab) notFound()

  return (
    <AuthGate>
      <ChannelsContent activeChannel={activeSocialTab} />
    </AuthGate>
  )
}
