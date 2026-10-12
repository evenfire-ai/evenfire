'use client'

import type { ReactNode } from 'react'
import { useSelectedLayoutSegment } from 'next/navigation'
import { ConnectorDetailAccessProvider } from '@components/ConnectorDetailAccessProvider'
import { ConnectorDetailProvider } from '@components/ConnectorDetailProvider'
import { CONNECTOR_DETAIL_TABS } from '@constants/connectorDetail'

export default function ConnectorLayout({ children }: { children: ReactNode }) {
  const selectedSegment = useSelectedLayoutSegment()
  const isDetailRoute =
    selectedSegment === null || CONNECTOR_DETAIL_TABS.some(tab => tab === selectedSegment)

  return isDetailRoute ? (
    <ConnectorDetailProvider>
      <ConnectorDetailAccessProvider>{children}</ConnectorDetailAccessProvider>
    </ConnectorDetailProvider>
  ) : (
    children
  )
}
