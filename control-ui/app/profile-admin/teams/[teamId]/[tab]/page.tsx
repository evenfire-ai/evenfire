import { notFound } from 'next/navigation'
import TeamDetailsPage from '../page'

interface TeamTabPageProps {
  params: Promise<{ tab: string }>
}

const TEAM_DETAIL_TABS = ['members', 'access']

export default async function TeamTabPage({ params }: TeamTabPageProps) {
  const { tab } = await params
  if (!TEAM_DETAIL_TABS.includes(tab)) notFound()

  return <TeamDetailsPage />
}
