import { notFound } from 'next/navigation'
import HostDetailsPage from '../page'

interface HostTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function HostTabPage({ params }: HostTabPageProps) {
  const { tab } = await params
  const tabs = [
    'overview',
    'model',
    'approvals',
    'identity',
    'contexts',
    'env-vars',
    'member-access',
    'team-access',
    'guardrails',
  ]
  if (!tabs.includes(tab)) notFound()

  return <HostDetailsPage />
}
