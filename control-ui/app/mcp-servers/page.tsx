'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { DashboardLayout } from '../../components/DashboardLayout'
import { McpServerTable } from '../../components/McpServerTable'
import type {
  ConnectorAgentBinding,
  ConnectorAgentTarget,
} from '../../components/McpServerTable.types'
import { useToast } from '../../components/Toast'
import {
  McpServerUninstallIncompleteError,
  deleteMcpServer,
  getContexts,
  getHosts,
  getMcpServers,
  isSilentApiError,
} from '../../lib/api'
import type { ContextResource, McpServerResource } from '../../lib/api'
import {
  addConnectorToAgentContexts,
  connectorAccessMutationError,
  connectorAgentBindingsFromContexts,
  connectorAgentTargetsFromHosts,
  connectorResourceKey,
} from '../../lib/connectorAccessManagement'

export default function McpServersPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mcpServers, setMcpServers] = useState<McpServerResource[]>([])
  const [contexts, setContexts] = useState<ContextResource[]>([])
  const [agentTargets, setAgentTargets] = useState<ConnectorAgentTarget[]>([])
  const [bindingsByConnectorName, setBindingsByConnectorName] = useState<
    Record<string, ConnectorAgentBinding[]>
  >({})
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [updatingAgentAccessKey, setUpdatingAgentAccessKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()

  /** Resolves to the load error it displayed, or '' when the reload succeeded. */
  async function loadAll(): Promise<string> {
    setLoading(true)
    setError('')
    try {
      const [serversResult, hostsResult, contextsResult] = await Promise.all([
        getMcpServers(),
        getHosts(),
        getContexts(),
      ])
      const connectors = (serversResult.items || []) as McpServerResource[]
      const hosts = hostsResult.items || []
      const nextContexts = (contextsResult.items || []) as ContextResource[]
      const nextAgentTargets = connectorAgentTargetsFromHosts(hosts)
      setMcpServers(connectors)
      setContexts(nextContexts)
      setAgentTargets(nextAgentTargets)
      setBindingsByConnectorName(connectorAgentBindingsFromContexts(nextContexts, nextAgentTargets))
      return ''
    } catch (e) {
      if (isSilentApiError(e)) return ''
      const message = e instanceof Error ? e.message : 'Failed to load connectors'
      setError(message)
      return message
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
      await deleteMcpServer(server.name)
      await loadAll()
      showToast(`Connector ${key} deleted.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      if (e instanceof McpServerUninstallIncompleteError) {
        // Part of the cleanup already ran (e.g. agent access removed) while the
        // connector stays listed; reload so the row reflects that before retrying.
        const refreshError = await loadAll()
        setError(
          [
            `${key}: ${e.message}`,
            refreshError && `The list could not be refreshed: ${refreshError}`,
          ]
            .filter(Boolean)
            .join(' ')
        )
        return
      }
      setError(e instanceof Error ? e.message : `Failed to delete ${key}`)
    } finally {
      setDeletingKey(null)
    }
  }

  async function addConnectorToAgents(
    server: { name: string; namespace: string },
    agents: Array<{ name: string; contextRef: string }>
  ): Promise<boolean> {
    const key = `${server.namespace}/${server.name}`
    const connector = mcpServers.find(item => connectorResourceKey(item) === key)
    setUpdatingAgentAccessKey(key)
    setError('')
    try {
      await addConnectorToAgentContexts(server, agents, contexts, connector?.spec)
      await loadAll()
      showToast(
        agents.length === 1
          ? `Connector ${server.name} added to agent ${agents[0].name}.`
          : `Connector ${server.name} added to ${agents.length} agents.`,
        { tone: 'success' }
      )
      return true
    } catch (e) {
      if (isSilentApiError(e)) return false
      setError(connectorAccessMutationError(e, `Failed to give agents access to ${server.name}`))
      return false
    } finally {
      setUpdatingAgentAccessKey(null)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  return (
    <DashboardLayout>
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      <McpServerTable
        items={mcpServers as any}
        agentBindingsByConnectorName={bindingsByConnectorName}
        agentTargets={agentTargets}
        onAddToAgents={addConnectorToAgents}
        updatingAgentAccessKey={updatingAgentAccessKey}
        onDelete={handleDelete}
        onOpen={server => router.push(CONTROL_ROUTES.connectors.detail(server.name))}
        deletingKey={deletingKey}
        onRefresh={loadAll}
        onCreate={() => router.push(CONTROL_ROUTES.connectors.new)}
        onAddRemote={() => router.push(CONTROL_ROUTES.connectors.remoteNew)}
        onInstallFromRegistry={() => router.push(CONTROL_ROUTES.marketplace.root)}
        refreshing={loading}
        loading={loading && mcpServers.length === 0}
      />
      {confirmDialog}
    </DashboardLayout>
  )
}
