'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@components/LoadingScreen'
import { CONTROL_ROUTES } from '@constants/routes'
import { useAuth } from '../../components/AuthContext'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { DashboardLayout } from '../../components/DashboardLayout'
import { McpServerTable } from '../../components/McpServerTable'
import type {
  ConnectorAccessPrincipal,
  ConnectorAccessSummary,
  ConnectorAccessSummaryMap,
} from '../../components/McpServerTable.types'
import { useToast } from '../../components/Toast'
import {
  apiSend,
  getContextTeams,
  getContextUsers,
  getHosts,
  getMcpServers,
  isSilentApiError,
} from '../../lib/api'
import type { HostResource, McpServerResource } from '../../lib/api'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '../../lib/authRedirect'

function resourceName(resource: { metadata?: { name?: string } }): string {
  return resource.metadata?.name || 'unknown'
}

function resourceNamespace(resource: { metadata?: { namespace?: string } }): string {
  return resource.metadata?.namespace || 'default'
}

function connectorKey(connector: McpServerResource): string {
  return `${resourceNamespace(connector)}/${resourceName(connector)}`
}

function getContextRef(resource: { spec?: Record<string, unknown> }): string {
  const contextRef = resource.spec?.contextRef
  return typeof contextRef === 'string' ? contextRef.trim() : ''
}

function sortPrincipals(items: ConnectorAccessPrincipal[]): ConnectorAccessPrincipal[] {
  return [...items].sort((a, b) => a.label.localeCompare(b.label))
}

function agentsForContext(hosts: HostResource[], contextRef: string): ConnectorAccessPrincipal[] {
  return sortPrincipals(
    hosts
      .filter(host => getContextRef(host) === contextRef)
      .map(host => {
        const name = resourceName(host)
        return { id: name, label: name }
      })
  )
}

async function loadContextAccess(
  contextRef: string,
  hosts: HostResource[]
): Promise<readonly [ConnectorAccessSummary, boolean]> {
  const [usersResult, teamsResult] = await Promise.allSettled([
    getContextUsers(contextRef),
    getContextTeams(contextRef),
  ])
  const accessLoadFailed = usersResult.status === 'rejected' || teamsResult.status === 'rejected'
  if (usersResult.status === 'rejected') {
    console.warn(`Failed to load users for context ${contextRef}:`, usersResult.reason)
  }
  if (teamsResult.status === 'rejected') {
    console.warn(`Failed to load teams for context ${contextRef}:`, teamsResult.reason)
  }
  const users =
    usersResult.status === 'fulfilled'
      ? sortPrincipals(
          (usersResult.value.items ?? []).map(user => ({
            id: user.id,
            label: user.displayName || user.name || user.email || user.id,
          }))
        )
      : []
  const teams =
    teamsResult.status === 'fulfilled'
      ? sortPrincipals(
          (teamsResult.value.items ?? []).map(team => ({
            id: team.id,
            label: team.name || team.id,
          }))
        )
      : []

  return [
    {
      agents: agentsForContext(hosts, contextRef),
      users,
      teams,
    },
    accessLoadFailed,
  ] as const
}

export default function McpServersPage() {
  const { authState } = useAuth()
  const router = useRouter()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mcpServers, setMcpServers] = useState<McpServerResource[]>([])
  const [accessByConnectorKey, setAccessByConnectorKey] = useState<ConnectorAccessSummaryMap>({})
  const [accessWarning, setAccessWarning] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()

  async function loadAll() {
    setLoading(true)
    setError('')
    setAccessWarning('')
    try {
      const [serversResult, hostsResult] = await Promise.all([getMcpServers(), getHosts()])
      const connectors = (serversResult.items || []) as McpServerResource[]
      const hosts = (hostsResult.items || []) as HostResource[]
      const contextRefs = [
        ...new Set(connectors.map(connector => getContextRef(connector)).filter(Boolean)),
      ]
      const accessResults = await Promise.all(
        contextRefs.map(
          async contextRef => [contextRef, await loadContextAccess(contextRef, hosts)] as const
        )
      )
      const accessByContext = new Map(
        accessResults.map(([contextRef, [summary]]) => [contextRef, summary] as const)
      )
      const accessLoadFailed = accessResults.some(([, [, failed]]) => failed)
      if (accessLoadFailed) {
        setAccessWarning(
          'Some connector access data could not be loaded. User or team access may be incomplete.'
        )
      }
      const nextAccessByConnectorKey = connectors.reduce<ConnectorAccessSummaryMap>(
        (acc, connector) => {
          const contextRef = getContextRef(connector)
          if (contextRef) {
            acc[connectorKey(connector)] = accessByContext.get(contextRef) ?? {
              agents: [],
              users: [],
              teams: [],
            }
          }
          return acc
        },
        {}
      )
      setMcpServers(connectors)
      setAccessByConnectorKey(nextAccessByConnectorKey)
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load connectors')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(server: { name: string; namespace: string }) {
    const key = `${server.namespace}/${server.name}`
    const shouldDelete = await confirm({
      title: 'Delete Connector',
      message: `Delete connector ${key}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setDeletingKey(key)
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/mcp-servers/${encodeURIComponent(server.name)}`)
      await loadAll()
      showToast(`Connector ${key} deleted.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : `Failed to delete ${key}`)
    } finally {
      setDeletingKey(null)
    }
  }

  function handleOpenContext(contextName: string) {
    const trimmed = contextName.trim()
    if (!trimmed) return
    router.push(CONTROL_ROUTES.contexts.connectors(trimmed))
  }

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      void loadAll()
    }
  }, [authState.isLoggedIn, authState.isLoading])

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  if (authState.isLoading) {
    return <LoadingScreen />
  }

  if (!authState.isLoggedIn) {
    return null
  }

  return (
    <DashboardLayout>
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      {accessWarning ? (
        <div className="cu-banner cu-banner--warning" role="status">
          {accessWarning}
        </div>
      ) : null}
      <McpServerTable
        items={mcpServers as any}
        accessByConnectorKey={accessByConnectorKey}
        onOpenContext={handleOpenContext}
        onDelete={handleDelete}
        onEdit={server => router.push(CONTROL_ROUTES.connectors.edit(server.name))}
        deletingKey={deletingKey}
        onRefresh={loadAll}
        onCreate={() => router.push(CONTROL_ROUTES.connectors.new)}
        onInstallFromRegistry={() => router.push(CONTROL_ROUTES.marketplace.root)}
        refreshing={loading}
        loading={loading && mcpServers.length === 0}
      />
      {confirmDialog}
    </DashboardLayout>
  )
}
