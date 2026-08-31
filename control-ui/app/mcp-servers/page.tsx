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
  ConnectorAgentBinding,
  ConnectorAgentTarget,
} from '../../components/McpServerTable.types'
import { useToast } from '../../components/Toast'
import {
  apiSend,
  getAgentTeams,
  getAgentUsers,
  getContexts,
  getHosts,
  getMcpServers,
  isSilentApiError,
  updateContext,
} from '../../lib/api'
import type { ContextResource, ContextSpec, HostResource, McpServerResource } from '../../lib/api'
import { mergeAccessSummaries, sortAccessPrincipals } from '../../lib/connectorAccess'
import { buildContextUpdatePayload, contextMutationError } from '../../lib/contextMutation'

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

// The agents an operator can grant connector access to. Each agent resolves to
// its private context (the write target); the context itself stays invisible.
function agentTargetsFromHosts(hosts: HostResource[]): ConnectorAgentTarget[] {
  return hosts
    .map(host => {
      const name = resourceName(host)
      const displayName =
        String((host.spec as { host?: string } | undefined)?.host || '').trim() || name
      return { name, label: displayName, contextRef: getContextRef(host) }
    })
    .filter(target => target.contextRef && target.name !== 'unknown')
    .sort((left, right) => left.label.localeCompare(right.label))
}

// Per-connector write units: every context that carries the connector and is
// owned by at least one agent becomes one binding listing those agents.
// Contexts with no owning agent (per-install and workflow-recipe private
// scopes) are intentionally invisible — they are not user-managed.
function bindingsByConnectorFromContexts(
  contexts: ContextResource[],
  agentTargets: ConnectorAgentTarget[]
): Record<string, ConnectorAgentBinding[]> {
  const targetsByContextRef = new Map<string, ConnectorAccessPrincipal[]>()
  for (const target of agentTargets) {
    const principals = targetsByContextRef.get(target.contextRef) ?? []
    principals.push({ id: target.name, label: target.label })
    targetsByContextRef.set(target.contextRef, principals)
  }

  const bindings: Record<string, ConnectorAgentBinding[]> = {}
  for (const context of contexts) {
    const ref = contextName(context)
    const agents = targetsByContextRef.get(ref)
    if (!ref || !agents || agents.length === 0) continue
    for (const serverName of context.spec?.mcpServers ?? []) {
      const list = bindings[serverName] ?? []
      list.push({ contextRef: ref, agents: sortAccessPrincipals(agents) })
      bindings[serverName] = list
    }
  }
  for (const list of Object.values(bindings)) {
    list.sort((left, right) =>
      (left.agents[0]?.label ?? '').localeCompare(right.agents[0]?.label ?? '')
    )
  }
  return bindings
}

// User/team access summaries ride the AGENTS that carry the connector (the
// same grants operators make in Users & Teams ▸ Access/Agents tabs), not the
// legacy scope-centric context mappings. Read-only groups in the table.
async function loadAgentAccess(
  agentName: string
): Promise<readonly [ConnectorAccessSummary, boolean]> {
  const [usersResult, teamsResult] = await Promise.allSettled([
    getAgentUsers(agentName),
    getAgentTeams(agentName),
  ])
  const accessLoadFailed = usersResult.status === 'rejected' || teamsResult.status === 'rejected'
  if (usersResult.status === 'rejected') {
    console.warn(`Failed to load users for agent ${agentName}:`, usersResult.reason)
  }
  if (teamsResult.status === 'rejected') {
    console.warn(`Failed to load teams for agent ${agentName}:`, teamsResult.reason)
  }
  const users =
    usersResult.status === 'fulfilled'
      ? sortAccessPrincipals(
          (usersResult.value.items ?? []).map(user => ({
            id: user.id,
            label: user.displayName || user.name || user.email || user.id,
          }))
        )
      : []
  const teams =
    teamsResult.status === 'fulfilled'
      ? sortAccessPrincipals(
          (teamsResult.value.items ?? []).map(team => ({
            id: team.id,
            label: team.name || team.id,
          }))
        )
      : []

  return [
    {
      agents: [],
      users,
      teams,
    },
    accessLoadFailed,
  ] as const
}

function connectorAccessMutationError(error: unknown, fallback: string): string {
  if ((error as { status?: unknown } | null)?.status === 409) {
    return 'This connector’s access changed since it was loaded. Reload the page and try again.'
  }
  if (error instanceof Error && /required version is unavailable/i.test(error.message)) {
    return 'This connector’s access is missing a server version. Reload the page and try again.'
  }
  return contextMutationError(error, fallback)
}

function agentListLabel(agents: ConnectorAccessPrincipal[]): string {
  if (agents.length === 1) return agents[0].label
  return `${agents.length} agents`
}

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
  const [accessByConnectorKey, setAccessByConnectorKey] = useState<ConnectorAccessSummaryMap>({})
  const [accessWarning, setAccessWarning] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [updatingAgentAccessKey, setUpdatingAgentAccessKey] = useState<string | null>(null)
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
      const nextAgentTargets = agentTargetsFromHosts(hosts)
      const nextBindings = bindingsByConnectorFromContexts(nextContexts, nextAgentTargets)

      // Read-only user/team summaries are merged across the AGENTS that
      // carry each connector (bindings), matching the grants operators see
      // in Users & Teams — never the legacy scope-centric mappings.
      const managedAgentNames = [
        ...new Set(
          Object.values(nextBindings)
            .flat()
            .flatMap(binding => binding.agents.map(agent => agent.id))
        ),
      ]
      const accessResults = await Promise.all(
        managedAgentNames.map(
          async agentName => [agentName, await loadAgentAccess(agentName)] as const
        )
      )
      const accessByAgent = new Map(
        accessResults.map(([agentName, [summary]]) => [agentName, summary] as const)
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
          const connectorBindings = nextBindings[connectorName] ?? []
          const bindingAgentNames = connectorBindings.flatMap(binding =>
            binding.agents.map(agent => agent.id)
          )
          if (bindingAgentNames.length > 0) {
            const merged = mergeAccessSummaries(
              bindingAgentNames.map(
                agentName => accessByAgent.get(agentName) ?? { agents: [], users: [], teams: [] }
              )
            )
            // The agents group must reflect the bindings (the write model) so
            // search-by-agent keeps working: accessText in the table's search
            // haystack reads summary.agents.
            const bindingAgents = connectorBindings.flatMap(binding => binding.agents)
            const seenAgentIds = new Set(
              [...bindingAgents, ...merged.agents].map(principal => principal.id)
            )
            const agents = [
              ...bindingAgents,
              ...merged.agents.filter(principal => !seenAgentIds.has(principal.id)),
            ]
            // Re-dedupe by id preserving first occurrence.
            const byId = new Map(agents.map(principal => [principal.id, principal]))
            acc[connectorKey(connector)] = {
              ...merged,
              agents: sortAccessPrincipals([...byId.values()]),
            }
          }
          return acc
        },
        {}
      )
      setMcpServers(connectors)
      setContexts(nextContexts)
      setAgentTargets(nextAgentTargets)
      setBindingsByConnectorName(nextBindings)
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

  async function addConnectorToAgents(
    server: { name: string; namespace: string },
    agents: Array<{ name: string; contextRef: string }>
  ) {
    const key = `${server.namespace}/${server.name}`
    const contextRefs = [...new Set(agents.map(agent => agent.contextRef))]
    const targets = contexts.filter(context => contextRefs.includes(contextName(context)))
    if (targets.length !== contextRefs.length) {
      setError('One or more selected agents could not be resolved. Please refresh and try again.')
      return
    }

    setUpdatingAgentAccessKey(key)
    setError('')
    try {
      await Promise.all(
        targets.map(context => {
          const name = contextName(context)
          const spec = contextSpec(context)
          return updateContext(
            name,
            buildContextUpdatePayload(context.metadata?.resourceVersion, {
              ...spec,
              mcpServers: Array.from(new Set([...spec.mcpServers, server.name])),
            })
          )
        })
      )
      await loadAll()
      showToast(
        agents.length === 1
          ? `Connector ${server.name} added to agent ${agents[0].name}.`
          : `Connector ${server.name} added to ${agents.length} agents.`,
        { tone: 'success' }
      )
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(connectorAccessMutationError(e, `Failed to give agents access to ${server.name}`))
    } finally {
      setUpdatingAgentAccessKey(null)
    }
  }

  async function removeConnectorFromAgents(
    server: { name: string; namespace: string },
    binding: ConnectorAgentBinding
  ) {
    const key = `${server.namespace}/${server.name}`
    const target = contexts.find(context => contextName(context) === binding.contextRef)
    if (!target) {
      setError('This agent’s connector set could not be loaded. Please refresh and try again.')
      return
    }

    if (binding.agents.length > 1) {
      const sharedNames = binding.agents.map(agent => agent.label).join(', ')
      const shouldRemove = await confirm({
        title: 'Remove Connector Access',
        message: `Remove connector ${server.name} from ${binding.agents.length} agents (${sharedNames})? These agents share one connector set, so the change applies to all of them.`,
        confirmLabel: 'Remove',
        tone: 'danger',
      })
      if (!shouldRemove) return
    }

    setUpdatingAgentAccessKey(key)
    setError('')
    try {
      const spec = contextSpec(target)
      await updateContext(
        binding.contextRef,
        buildContextUpdatePayload(target.metadata?.resourceVersion, {
          ...spec,
          mcpServers: spec.mcpServers.filter(name => name !== server.name),
        })
      )
      await loadAll()
      showToast(`Connector ${server.name} removed from ${agentListLabel(binding.agents)}.`, {
        tone: 'success',
      })
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(connectorAccessMutationError(e, `Failed to remove ${server.name} from agent access`))
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
      {accessWarning ? (
        <div className="cu-banner cu-banner--warning" role="status">
          {accessWarning}
        </div>
      ) : null}
      <McpServerTable
        items={mcpServers as any}
        accessByConnectorKey={accessByConnectorKey}
        agentBindingsByConnectorName={bindingsByConnectorName}
        agentTargets={agentTargets}
        onAddToAgents={addConnectorToAgents}
        onRemoveFromAgents={removeConnectorFromAgents}
        updatingAgentAccessKey={updatingAgentAccessKey}
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
