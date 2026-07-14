import { notFound } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { SettingsContent } from '../../SettingsContent'
import { PROFILE_SOCIAL_CHANNEL_TABS } from '../../constants'
import type { SocialChannelTabKey } from '../../types'

interface SocialNetworkSettingsPageProps {
  params: Promise<{ network: string }>
}

export default async function SocialNetworkSettingsPage({
  params,
}: SocialNetworkSettingsPageProps) {
  const { network } = await params
  const activeSocialTab = PROFILE_SOCIAL_CHANNEL_TABS.some(tab => tab.key === network)
    ? (network as SocialChannelTabKey)
    : null
  if (!activeSocialTab) notFound()

  return (
    <AuthGate>
      <SettingsContent activeSettingsTab="social" activeSocialTab={activeSocialTab} />
    </AuthGate>
  )
}
