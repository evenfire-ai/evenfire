import { notFound } from 'next/navigation'
import UserDetailsPage from '../page'

interface UserTabPageProps {
  params: Promise<{ tab: string }>
}

const USER_DETAIL_TABS = [
  'contact',
  'approval-dms',
  'communication-channels',
  'contexts',
  'teams',
  'agents',
]

export default async function UserTabPage({ params }: UserTabPageProps) {
  const { tab } = await params
  if (!USER_DETAIL_TABS.includes(tab)) notFound()

  return <UserDetailsPage />
}
