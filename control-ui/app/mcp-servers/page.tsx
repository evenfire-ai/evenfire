'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
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
  getContexts,
  getHosts,
  getMcpServers,
  isSilentApiError,
  updateContext,
} from '../../lib/api'
import type { ContextResource, ContextSpec, HostResource, McpServerResource } from '../../lib/api'

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

function mergeAccessSummaries(summaries: ConnectorAccessSummary[]): ConnectorAccessSummary {
  const mergeGroup = (group: keyof ConnectorAccessSummary) => {
    const items = summaries.flatMap(summary => summary[group])
    return sortPrincipals(Array.from(new Map(items.map(item => [item.id, item] as const)).values()))
  }

  return {
    agents: mergeGroup('agents'),
    users: mergeGroup('users'),
    teams: mergeGroup('teams'),
  }
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
  const router = useRouter()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mcpServers, setMcpServers] = useState<McpServerResource[]>([])
  const [contexts, setContexts] = useState<ContextResource[]>([])
  const [accessByConnectorKey, setAccessByConnectorKey] = useState<ConnectorAccessSummaryMap>({})
  const [accessWarning, setAccessWarning] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [updatingContextMembershipKey, setUpdatingContextMembershipKey] = useState<string | null>(
    null
  )
  const { confirm, confirmDialog } = useConfirmDialog()

  async function loadAll() {
    setLoading(true)
    setError('')
    setAccessWarning('')
    try {
      const [serversResult, hostsResult, contextsResult] = await Promise.all([
        getMcpServers(),
        getHosts(),
        getContexts(),
      ])
      const connectors = (serversResult.items || []) as McpServerResource[]
      const hosts = (hostsResult.items || []) as HostResource[]
      const nextContexts = (contextsResult.items || []) as ContextResource[]
      const contextRefs = [
        ...new Set([
          ...connectors.map(connector => getContextRef(connector)).filter(Boolean),
          ...nextContexts
            .map(context => String(context.metadata?.name || context.spec?.contextId || '').trim())
            .filter(Boolean),
        ]),
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
          const connectorName = resourceName(connector)
          const connectorContexts = new Set(
            [
              getContextRef(connector),
              ...nextContexts
                .filter(context => context.spec?.mcpServers?.includes(connectorName))
                .map(context =>
                  String(context.metadata?.name || context.spec?.contextId || '').trim()
                ),
            ].filter(Boolean)
          )
          if (connectorContexts.size > 0) {
            acc[connectorKey(connector)] = mergeAccessSummaries(
              [...connectorContexts].map(
                contextRef =>
                  accessByContext.get(contextRef) ?? { agents: [], users: [], teams: [] }
              )
            )
          }
          return acc
        },
        {}
      )
      setMcpServers(connectors)
      setContexts(nextContexts)
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

  function contextName(context: ContextResource): string {
    return String(context.metadata?.name || context.spec?.contextId || '').trim()
  }

  function contextSpec(context: ContextResource): ContextSpec {
    const name = contextName(context)
    return {
      contextId: context.spec?.contextId || name,
      description: context.spec?.description,
      mcpServers: Array.isArray(context.spec?.mcpServers) ? context.spec.mcpServers : [],
      sharedFileSystems: context.spec?.sharedFileSystems ?? [],
    }
  }

  async function addConnectorToContexts(
    server: { name: string; namespace: string },
    contextNames: string[]
  ) {
    const key = `${server.namespace}/${server.name}`
    const targets = contexts.filter(context => contextNames.includes(contextName(context)))
    if (targets.length !== contextNames.length) {
      setError('One or more selected contexts could not be loaded. Please refresh and try again.')
      return
    }

    setUpdatingContextMembershipKey(key)
    setError('')
    try {
      await Promise.all(
        targets.map(context => {
          const name = contextName(context)
          const spec = contextSpec(context)
          return updateContext(name, {
            spec: {
              ...spec,
              mcpServers: Array.from(new Set([...spec.mcpServers, server.name])),
            },
          })
        })
      )
      await loadAll()
      showToast(
        contextNames.length === 1
          ? `Connector ${server.name} added to context.`
          : `Connector ${server.name} added to ${contextNames.length} contexts.`,
        { tone: 'success' }
      )
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : `Failed to add ${server.name} to contexts`)
    } finally {
      setUpdatingContextMembershipKey(null)
    }
  }

  async function removeConnectorFromContext(
    server: { name: string; namespace: string },
    targetContextName: string
  ) {
    const key = `${server.namespace}/${server.name}`
    const target = contexts.find(context => contextName(context) === targetContextName)
    if (!target) {
      setError('Context could not be loaded. Please refresh and try again.')
      return
    }

    setUpdatingContextMembershipKey(key)
    setError('')
    try {
      const spec = contextSpec(target)
      await updateContext(targetContextName, {
        spec: {
          ...spec,
          mcpServers: spec.mcpServers.filter(name => name !== server.name),
        },
      })
      await loadAll()
      showToast(`Connector ${server.name} removed from ${targetContextName}.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : `Failed to remove ${server.name} from context`)
    } finally {
      setUpdatingContextMembershipKey(null)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

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
        contexts={contexts
          .map(context => ({
            name: contextName(context),
            description: context.spec?.description,
            mcpServers: context.spec?.mcpServers ?? [],
          }))
          .filter(context => context.name)}
        onOpenContext={handleOpenContext}
        onAddToContexts={addConnectorToContexts}
        onRemoveFromContext={removeConnectorFromContext}
        updatingContextMembershipKey={updatingContextMembershipKey}
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
