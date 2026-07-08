import { redirect } from 'next/navigation'

export default async function CommunicationChannelDetailsRedirect({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const { name } = await params

  redirect(`/communication-channels/${encodeURIComponent(name)}/edit`)
}
