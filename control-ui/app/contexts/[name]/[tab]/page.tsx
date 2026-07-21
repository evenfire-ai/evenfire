import { notFound } from 'next/navigation'
import ContextDetailsPage from '../page'

interface ContextTabPageProps {
  params: Promise<{ tab: string }>
}

const CONTEXT_DETAIL_TABS = ['connectors', 'agent-files', 'agents', 'teams', 'members']

export default async function ContextTabPage({ params }: ContextTabPageProps) {
  const { tab } = await params
  if (!CONTEXT_DETAIL_TABS.includes(tab)) notFound()

  return <ContextDetailsPage />
}
