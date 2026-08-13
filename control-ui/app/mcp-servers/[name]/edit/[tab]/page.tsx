import { notFound } from 'next/navigation'
import { CONNECTOR_EDIT_TABS, type ConnectorEditTab } from '@constants/connectorEdit'
import EditMcpServerPage from '../page'

interface ConnectorEditTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function ConnectorEditTabPage({ params }: ConnectorEditTabPageProps) {
  const { tab } = await params
  if (!CONNECTOR_EDIT_TABS.includes(tab as ConnectorEditTab)) {
    notFound()
  }

  return <EditMcpServerPage />
}
