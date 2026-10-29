'use client'

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { BodyLoadingSkeleton } from '@components/BodyLoadingSkeleton'
import { ConnectorSecretKeys } from '@components/ConnectorSecretKeys'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconKey } from '@components/Sidebar/icons'
import { TabBar } from '@components/TabBar'
import { UpdateConnectorCredentials } from '@components/UpdateConnectorCredentials'
import {
  nonCanonicalEnvSecretName,
  resolveEnvSecret,
  resolveRegistryCredentialSource,
} from '@components/UpdateConnectorCredentials/mcpServerCredentialResolvers'
import { isRecipeOwned } from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import { CONTROL_ROUTES } from '@constants/routes'
import { getMcpServers, listMcpSecrets } from '@lib/api'
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
  const serverQueryValues = searchParams.getAll('server')
  const requestedServer = serverQueryValues[0]
  const serverQueryError =
    serverQueryValues.length > 0 &&
    (serverQueryValues.length !== 1 ||
      !requestedServer ||
      requestedServer !== requestedServer.trim())
      ? 'Choose exactly one connector from this Secret. The server link is invalid.'
      : ''

  const [servers, setServers] = useState<McpServerResource[] | null>(null)
  const [loadError, setLoadError] = useState('')
  // The provisioned Secret listing: undefined while loading, null when the
  // Secret does not exist, otherwise its name + key names (never values).
  const [secretSummary, setSecretSummary] = useState<
    { name: string; keys: string[] } | null | undefined
  >(undefined)
  const [secretLoadError, setSecretLoadError] = useState('')

  useEffect(() => {
    if (!secretName) {
      setLoadError('Missing secret name in URL.')
      setServers([])
      setSecretSummary(null)
      return
    }
    let cancelled = false
    getMcpServers()
      .then(result => {
        if (cancelled) return
        setServers(result.items ?? [])
      })
      .catch(error => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'Failed to load connector secret references'
          )
          setServers([])
        }
      })
    listMcpSecrets()
      .then(result => {
        if (cancelled) return
        const match = (result.items ?? []).find(item => item.name === secretName)
        setSecretSummary(match ? { name: match.name, keys: match.keys } : null)
      })
      .catch(error => {
        if (!cancelled)
          setSecretLoadError(error instanceof Error ? error.message : 'Failed to load Secret keys')
      })
    return () => {
      cancelled = true
    }
  }, [secretName])

  const attachedServers = useMemo(
    () =>
      (servers ?? [])
        .filter(server => serverRefersToSecret(server, secretName))
        .sort((a, b) =>
          String(a.metadata?.name ?? '').localeCompare(String(b.metadata?.name ?? ''))
        ),
    [servers, secretName]
  )
  const nonCanonicalReferences = useMemo(
    () =>
      (servers ?? [])
        .map(server => ({
          connector: String(server.metadata?.name ?? ''),
          name: nonCanonicalEnvSecretName(server.spec as Record<string, unknown> | undefined),
        }))
        .filter(ref => ref.name !== undefined && ref.name.trim() === secretName.trim()),
    [servers, secretName]
  )
  const identityError =
    secretName !== secretName.trim()
      ? `Secret name in the URL is non-canonical: ${JSON.stringify(secretName)}. Correct the connector reference before editing credentials.`
      : nonCanonicalReferences.length > 0
        ? `Connector ${nonCanonicalReferences.map(ref => ref.connector).join(', ')} stores a non-canonical Secret name: ${nonCanonicalReferences.map(ref => JSON.stringify(ref.name)).join(', ')}. Correct the connector reference before editing credentials.`
        : ''
  const unknownServerError =
    servers !== null &&
    !loadError &&
    !identityError &&
    !serverQueryError &&
    serverQueryValues.length === 1 &&
    !attachedServers.some(server => server.metadata?.name === requestedServer)
      ? `Connector ${requestedServer} does not reference this Secret. Choose a connector that does.`
      : ''

  const selected = useMemo(() => {
    if (serverQueryError || unknownServerError || identityError || attachedServers.length === 0) {
      return undefined
    }
    return serverQueryValues.length === 1
      ? attachedServers.find(s => String(s.metadata?.name ?? '') === requestedServer)
      : attachedServers[0]
  }, [
    attachedServers,
    identityError,
    requestedServer,
    serverQueryError,
    serverQueryValues.length,
    unknownServerError,
  ])
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
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconKey />}
              title={`Edit connector secret${secretName ? `: ${secretName}` : ''}`}
              subtitle="Manage stored keys and rotate individual values."
              backLabel="Back to secrets"
              onBack={backToList}
            />
          }
        >
          <div className="cu-connector-edit-form cu-connector-edit-content">
            {loadError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            ) : null}
            {identityError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {identityError}
              </div>
            ) : null}
            {serverQueryError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {serverQueryError}
              </div>
            ) : null}
            {unknownServerError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {unknownServerError}
              </div>
            ) : null}

            {secretLoadError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {secretLoadError}
              </div>
            ) : null}
            {!loadError &&
            !secretLoadError &&
            !identityError &&
            !serverQueryError &&
            !unknownServerError ? (
              servers === null || secretSummary === undefined ? (
                <p className="cu-muted" role="status">
                  Loading connector secret…
                </p>
              ) : (
                <>
                  {attachedServers.length > 1 ? (
                    <TabBar
                      activeValue={selectedName}
                      ariaLabel="Connectors referencing this secret"
                      className="cu-tabs--flush"
                      options={attachedServers.map(server => {
                        const name = String(server.metadata?.name ?? '')
                        return {
                          value: name,
                          label: name,
                          href: CONTROL_ROUTES.secrets.editConnector(secretName, { server: name }),
                        }
                      })}
                    />
                  ) : null}
                  {secretSummary ? (
                    <ConnectorSecretKeys
                      key={`${secretName}:${selectedName}`}
                      secretName={secretName}
                      keys={secretSummary.keys}
                      serverName={selectedName || undefined}
                      envSecret={selectedEnvSecret}
                      server={selected}
                      referencingConnectors={attachedServers.map(server =>
                        String(server.metadata?.name ?? '')
                      )}
                      onKeysChange={keys => setSecretSummary({ name: secretName, keys })}
                      onMissing={() => setSecretSummary(null)}
                      onServerChange={updated =>
                        setServers(
                          current =>
                            current?.map(server =>
                              server.metadata?.name === updated.metadata?.name ? updated : server
                            ) ?? []
                        )
                      }
                    />
                  ) : selected && secretMatches ? (
                    <UpdateConnectorCredentials
                      key={selectedName}
                      serverName={selectedName}
                      envSecret={selectedEnvSecret}
                      surface={
                        isRecipeOwned(selected.spec as { managed?: boolean } | undefined)
                          ? 'recipe-owned'
                          : 'set'
                      }
                      recipeOwned={isRecipeOwned(
                        selected.spec as { managed?: boolean } | undefined
                      )}
                      registryCredentialSource={resolveRegistryCredentialSource(selected.metadata)}
                    />
                  ) : (
                    <div className="cu-banner cu-banner--error" role="alert">
                      No connector secret named <code>{secretName || '(unnamed)'}</code> exists. It
                      may have been deleted.
                    </div>
                  )}
                </>
              )
            ) : null}
          </div>
        </CreateFlowPanel>
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
