import { redirect } from 'next/navigation'
import { PROFILE_ROUTES } from '@constants/routes'

export default async function LegacySocialChannelPage({
  params,
}: {
  params: Promise<{ network: string }>
}) {
  const { network } = await params
  redirect(PROFILE_ROUTES.channels.channel(network))
}
