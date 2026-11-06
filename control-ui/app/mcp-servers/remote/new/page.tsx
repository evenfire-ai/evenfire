'use client'

import React, { Suspense, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AddRemoteServerWizard } from '@components/AddRemoteServerWizard'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconServer, IconStore } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button } from '@components/ui'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import { useRemoteCatalogTarget } from '@lib/hooks/useRemoteCatalogTarget'
import { parseRemoteWizardQuery } from '@lib/remoteMcp'
import type { RemoteCatalogEntryRef, RemoteGrantScope } from '@lib/remoteMcp.types'

function ManualRemoteServerWizard() {
  const router = useRouter()
  return (
    <AddRemoteServerWizard
      onInstalled={() => router.push(CONTROL_ROUTES.connectors.root)}
      onCancel={() => router.push(CONTROL_ROUTES.connectors.root)}
      pageHeader={
        <CreatePageHeader
          icon={<IconServer />}
          title="Add remote server"
          subtitle="Discover a remote MCP server by URL and install it as an OAuth connector."
          backLabel="Back to connectors"
          onBack={() => router.push(CONTROL_ROUTES.connectors.root)}
        />
      }
    />
  )
}

function CatalogErrorPanel({ message }: { message: string }) {
  const router = useRouter()
  const back = () => router.push(CONTROL_ROUTES.marketplace.connectors)
  return (
    <CreateFlowPanel
      header={
        <CreatePageHeader
          icon={<IconStore />}
          title="Install from Marketplace"
          subtitle="This Marketplace connector cannot be installed."
          backLabel="Back to Marketplace"
          onBack={back}
        />
      }
    >
      <div className="cu-banner cu-banner--error" role="alert">
        {message}
      </div>
      <div className="cu-create-actions">
        <Button onClick={back} size="sm" variant="ghost">
          Back to Marketplace
        </Button>
      </div>
    </CreateFlowPanel>
  )
}

function CatalogRemoteServerWizard({
  entry,
  grantScope,
}: {
  entry: RemoteCatalogEntryRef
  grantScope: RemoteGrantScope
}) {
  const router = useRouter()
  const { showToast } = useToast()
  const state = useRemoteCatalogTarget(entry, grantScope)
  const back = () => router.push(CONTROL_ROUTES.marketplace.connectors)

  if (state.status === 'loading') {
    return (
      <CreateFlowSkeleton
        {...CREATE_FLOW_LOADING.installRemoteCatalogEntry}
        onBack={back}
        backDisabled={false}
      />
    )
  }
  if (state.status === 'error') return <CatalogErrorPanel message={state.message} />

  const { target } = state
  return (
    <AddRemoteServerWizard
      catalog={target}
      onInstalled={back}
      onCancel={back}
      onSlotTaken={message => {
        showToast(message, { tone: 'error' })
        back()
      }}
      pageHeader={
        <CreatePageHeader
          icon={<IconStore />}
          title="Install from Marketplace"
          subtitle={`Install ${target.entry.name} as a remote OAuth connector, ${
            target.grantScope === 'user' ? 'per user' : 'per context'
          }.`}
          backLabel="Back to Marketplace"
          onBack={back}
        />
      }
    />
  )
}

function AddRemoteServerPageContent() {
  const searchParams = useSearchParams()
  const query = useMemo(
    () =>
      parseRemoteWizardQuery({
        entry: searchParams.get('entry'),
        version: searchParams.get('version'),
        scope: searchParams.get('scope'),
      }),
    [searchParams]
  )

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        {query.mode === 'manual' ? (
          <ManualRemoteServerWizard />
        ) : query.mode === 'invalid' ? (
          <CatalogErrorPanel message={query.message} />
        ) : (
          <CatalogRemoteServerWizard
            key={`${query.entry.name}@${query.entry.version}:${query.grantScope}`}
            entry={query.entry}
            grantScope={query.grantScope}
          />
        )}
      </DashboardLayout>
    </AuthGate>
  )
}

export default function AddRemoteServerPage() {
  return (
    <Suspense
      fallback={
        <AuthGate>
          <DashboardLayout isDetailPage>
            <CreateFlowSkeleton {...CREATE_FLOW_LOADING.addRemoteServer} />
          </DashboardLayout>
        </AuthGate>
      }
    >
      <AddRemoteServerPageContent />
    </Suspense>
  )
}
