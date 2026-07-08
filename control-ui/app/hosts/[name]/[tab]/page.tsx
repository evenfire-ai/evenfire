import { notFound } from 'next/navigation'
import { HOST_DEFAULT_TAB, HOST_TABS, type HostTab } from '@constants/hostDetails'
import HostDetailsPage from '../page'

interface HostTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function HostTabPage({ params }: HostTabPageProps) {
  const { tab } = await params
  if (tab === HOST_DEFAULT_TAB || !HOST_TABS.includes(tab as HostTab)) notFound()

  return <HostDetailsPage />
}
