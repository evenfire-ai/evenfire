import { notFound } from 'next/navigation'
import { CONNECTOR_DETAIL_TABS, type ConnectorDetailTab } from '@constants/connectorDetail'
import McpServerDetailPage from '../page'

interface ConnectorDetailTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function ConnectorDetailTabPage({ params }: ConnectorDetailTabPageProps) {
  const { tab } = await params
  if (!CONNECTOR_DETAIL_TABS.includes(tab as ConnectorDetailTab)) {
    notFound()
  }

  return <McpServerDetailPage />
}
