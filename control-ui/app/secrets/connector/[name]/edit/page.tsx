'use client'

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { BodyLoadingSkeleton } from '@components/BodyLoadingSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconKey } from '@components/Sidebar/icons'
import { TabBar } from '@components/TabBar'
import { UpdateConnectorCredentials } from '@components/UpdateConnectorCredentials'
import {
  resolveEnvSecret,
  resolveRegistryCredentialSource,
} from '@components/UpdateConnectorCredentials/mcpServerCredentialResolvers'
import {
  isRecipeOwned,
  resolveCredentialSurface,
} from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import { CONTROL_ROUTES } from '@constants/routes'
import { getMcpServers } from '@lib/api'
import type { McpServerResource } from '@lib/api'

function serverRefersToSecret(server: McpServerResource, secretName: string): boolean {
  return resolveEnvSecret(server.spec as Record<string, unknown> | undefined)?.name === secretName
}

function EditConnectorSecretContent() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const searchParams = useSearchParams()

  const secretName = useMemo(() => {
    const raw = params?.name
    const value = Array.isArray(raw) ? raw[0] : raw
    try {
      return decodeURIComponent(value ?? '')
    } catch {
      return value ?? ''
    }
  }, [params])
  const requestedServer = (searchParams.get('server') ?? '').trim()

  const [servers, setServers] = useState<McpServerResource[] | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!secretName) {
      setLoadError('Missing secret name in URL.')
      setServers([])
      return
    }
    let cancelled = false
    getMcpServers()
      .then(result => {
        if (cancelled) return
        const attached = (result.items ?? [])
          .filter(server => serverRefersToSecret(server, secretName))
          .sort((a, b) =>
            String(a.metadata?.name ?? '').localeCompare(String(b.metadata?.name ?? ''))
          )
        setServers(attached)
      })
      .catch(error => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'Failed to load connector secret references'
          )
          setServers([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [secretName])

  const selected = useMemo(() => {
    if (!servers || servers.length === 0) return undefined
    return requestedServer
      ? servers.find(s => String(s.metadata?.name ?? '') === requestedServer)
      : servers[0]
  }, [servers, requestedServer])
  const selectedName = selected ? String(selected.metadata?.name ?? '') : ''
  const selectedEnvSecret = selected
    ? resolveEnvSecret(selected.spec as Record<string, unknown> | undefined)
    : undefined
  const secretMatches = selectedEnvSecret?.name === secretName

  function backToList() {
    router.push(CONTROL_ROUTES.secrets.connector)
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreatePageHeader
          icon={<IconKey />}
          title={`Edit connector secret${secretName ? `: ${secretName}` : ''}`}
          subtitle="Update the values stored in this Secret through a connector that references it. Values are write-only; the form explains which keys are required."
          backLabel="Back to secrets"
          onBack={backToList}
        />

        <div className="cu-create-panel">
          <div className="cu-create-content">
            {loadError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            ) : null}

            {servers === null ? (
              <p className="cu-muted" role="status">
                Loading attached connectors…
              </p>
            ) : servers.length === 0 && !loadError ? (
              <div className="cu-banner cu-banner--error">
                No connector currently references Secret <code>{secretName || '(unnamed)'}</code>.
                Attach it to a connector before rotating it from here.
              </div>
            ) : (
              <>
                {servers.length > 1 ? (
                  <TabBar
                    activeValue={selectedName}
                    ariaLabel="Connectors referencing this secret"
                    className="cu-tabs--flush"
                    options={servers.map(server => {
                      const name = String(server.metadata?.name ?? '')
                      return {
                        value: name,
                        label: name,
                        href: CONTROL_ROUTES.secrets.editConnector(secretName, { server: name }),
                      }
                    })}
                  />
                ) : null}

                {requestedServer && !selected ? (
                  <div className="cu-banner cu-banner--error" role="alert">
                    Connector <code>{requestedServer}</code> does not reference this Secret. Choose
                    a connector that does.
                  </div>
                ) : null}

                {selected && !secretMatches ? (
                  <div className="cu-banner cu-banner--error" role="alert">
                    This connector does not reference Secret <code>{secretName}</code>. Choose a
                    connector that does.
                  </div>
                ) : null}

                {selected && secretMatches ? (
                  <UpdateConnectorCredentials
                    key={selectedName}
                    serverName={selectedName}
                    envSecret={selectedEnvSecret}
                    surface={resolveCredentialSurface(
                      selected.status?.conditions,
                      selected.spec as { managed?: boolean } | undefined
                    )}
                    recipeOwned={isRecipeOwned(selected.spec as { managed?: boolean } | undefined)}
                    registryCredentialSource={resolveRegistryCredentialSource(selected.metadata)}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGate>
  )
}

export default function EditConnectorSecretPage() {
  return (
    <Suspense
      fallback={
        <BodyLoadingSkeleton
          backLabel="Back to secrets"
          icon={<IconKey />}
          primaryActionLabel="Rotate credentials"
          sections={2}
          subtitle="Load the connectors referencing this secret before rotating stored values."
          title="Edit connector secret"
        />
      }
    >
      <EditConnectorSecretContent />
    </Suspense>
  )
}
