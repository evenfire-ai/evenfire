import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default async function CommunicationChannelDetailsRedirect({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const { name } = await params

  redirect(CONTROL_ROUTES.externalChannels.edit(name))
}
