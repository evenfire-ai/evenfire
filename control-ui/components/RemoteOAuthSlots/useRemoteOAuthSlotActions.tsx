'use client'

import React, { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { ConnectorAgentAccessDialog } from '@components/ConnectorAgentAccessDialog'
import type {
  ConnectorAgentBinding,
  ConnectorAgentTarget,
  ServerRef,
} from '@components/McpServerTable.types'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type ContextResource,
  McpServerUninstallIncompleteError,
  deleteMcpServer,
  getContexts,
  getHosts,
  isSilentApiError,
} from '@lib/api'
import {
  addConnectorToAgentContexts,
  connectorAccessMutationError,
  connectorAgentBindingsFromContexts,
  connectorAgentTargetsFromHosts,
} from '@lib/connectorAccessManagement'
import { unknownMcpServerNames } from '@lib/contextMutation'
import type { RemoteOAuthSlotActions, UseRemoteOAuthSlotActionsOptions } from './types'

type AgentAccessSnapshot = {
  serverName: string
  contexts: ContextResource[]
  agentTargets: ConnectorAgentTarget[]
  bindings: ConnectorAgentBinding[]
}

async function loadAgentAccess(serverName: string): Promise<AgentAccessSnapshot> {
  const [contextsResult, hostsResult] = await Promise.all([getContexts(), getHosts()])
  const contexts = contextsResult.items ?? []
  const agentTargets = connectorAgentTargetsFromHosts(hostsResult.items ?? [])
  return {
    serverName,
    contexts,
    agentTargets,
    bindings: connectorAgentBindingsFromContexts(contexts, agentTargets)[serverName] ?? [],
  }
}

/**
 * Install, agent access and uninstall for the slots of a Marketplace remote-OAuth entry.
 * They reuse the Connectors flows on the slot's `serverName`: the remote wizard in
 * catalog mode, the agent-access dialog over the generic context PUT, and the generic
 * connector DELETE.
 */
export function useRemoteOAuthSlotActions({
  onChanged,
}: UseRemoteOAuthSlotActionsOptions): RemoteOAuthSlotActions {
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [agentAccess, setAgentAccess] = useState<AgentAccessSnapshot | null>(null)
  // One entry per connector with an action in flight: actions on different slots can
  // overlap, and one finishing must not re-enable the other's buttons.
  const [busyServerNames, setBusyServerNames] = useState<ReadonlySet<string>>(new Set())
  const markBusy = useCallback((serverName: string, busy: boolean) => {
    setBusyServerNames(current => {
      const next = new Set(current)
      if (busy) next.add(serverName)
      else next.delete(serverName)
      return next
    })
  }, [])
  const isBusy = useCallback(
    (serverName: string) => busyServerNames.has(serverName),
    [busyServerNames]
  )
  const [addingAgents, setAddingAgents] = useState(false)
  const [error, setError] = useState('')

  const install = useCallback<RemoteOAuthSlotActions['install']>(
    (entry, scope) => {
      router.push(
        CONTROL_ROUTES.connectors.remoteNew({ entry: entry.name, version: entry.version, scope })
      )
    },
    [router]
  )

  const openAgents = useCallback(
    async (serverName: string) => {
      markBusy(serverName, true)
      setError('')
      try {
        setAgentAccess(await loadAgentAccess(serverName))
      } catch (caught) {
        if (isSilentApiError(caught)) return
        setError(caught instanceof Error ? caught.message : 'Failed to load agents.')
      } finally {
        markBusy(serverName, false)
      }
    },
    [markBusy]
  )

  const uninstall = useCallback(
    async (serverName: string) => {
      const confirmed = await confirm({
        title: 'Uninstall connector',
        message: `Uninstall ${serverName}? Agents lose access to it and its OAuth grants are revoked.`,
        confirmLabel: 'Uninstall',
        tone: 'danger',
      })
      if (!confirmed) return
      markBusy(serverName, true)
      setError('')
      try {
        await deleteMcpServer(serverName)
        showToast(`Connector ${serverName} uninstalled.`, { tone: 'success' })
        await onChanged()
      } catch (caught) {
        if (isSilentApiError(caught)) return
        if (caught instanceof McpServerUninstallIncompleteError) {
          // Part of the teardown already ran; re-read so the slot shows what is left.
          await onChanged()
          setError(`${serverName}: ${caught.message}`)
          return
        }
        setError(caught instanceof Error ? caught.message : `Failed to uninstall ${serverName}`)
      } finally {
        markBusy(serverName, false)
      }
    },
    [confirm, markBusy, onChanged, showToast]
  )

  const addAgents = useCallback(
    async (
      server: ServerRef,
      agents: Array<Pick<ConnectorAgentTarget, 'name' | 'contextRef'>>
    ): Promise<boolean> => {
      if (!agentAccess) return false
      setAddingAgents(true)
      setError('')
      try {
        await addConnectorToAgentContexts(server, agents, agentAccess.contexts)
        showToast(
          agents.length === 1
            ? `Connector ${server.name} added to agent ${agents[0].name}.`
            : `Connector ${server.name} added to ${agents.length} agents.`,
          { tone: 'success' }
        )
        return true
      } catch (caught) {
        if (isSilentApiError(caught)) return false
        const message = connectorAccessMutationError(
          caught,
          `Failed to give agents access to ${server.name}`
        )
        if (unknownMcpServerNames(caught) !== null) {
          // The connector is gone: nothing in the dialog can succeed any more, so it
          // closes and the slot is re-read.
          setAgentAccess(null)
          setError(message)
          await onChanged()
          return false
        }
        // Some contexts may have taken the connector before another write failed;
        // reload so the dialog offers only the agents still without it.
        try {
          setAgentAccess(await loadAgentAccess(server.name))
        } catch {
          // The failure message below already asks for a reload.
        }
        setError(message)
        return false
      } finally {
        setAddingAgents(false)
      }
    },
    [agentAccess, onChanged, showToast]
  )

  const dialogs = (
    <>
      {agentAccess ? (
        <ConnectorAgentAccessDialog
          key={agentAccess.serverName}
          // The dialog hands the reference back to `addAgents`, which reads only the name.
          server={{ name: agentAccess.serverName, namespace: '' }}
          agentTargets={agentAccess.agentTargets}
          boundAgentNames={agentAccess.bindings.flatMap(binding =>
            binding.agents.map(agent => agent.id)
          )}
          pending={addingAgents}
          onAdd={addAgents}
          onDismiss={() => {
            if (!addingAgents) setAgentAccess(null)
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  )

  return { install, openAgents, uninstall, isBusy, error, dialogs }
}
