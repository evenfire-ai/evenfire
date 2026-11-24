import { notFound } from 'next/navigation'
import { CommunicationChannelsContent } from '@components/CommunicationChannelsContent'
import { COMMUNICATION_CHANNEL_PROVIDERS } from '@lib/communicationChannelProviders'

export default async function ProviderChannelsPage({
  params,
}: {
  params: Promise<{ provider: string }>
}) {
  const { provider } = await params
  const selected = COMMUNICATION_CHANNEL_PROVIDERS.find(value => value === provider)
  if (!selected) notFound()
  return <CommunicationChannelsContent provider={selected} />
}
