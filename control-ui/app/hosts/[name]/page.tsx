'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DetailPageShell } from '@components/DetailPageShell'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { useToast } from '@components/Toast'
import { HOST_DEFAULT_TAB, HOST_TABS } from '@constants/hostDetails'
import { HostApprovalSection } from '../../../components/HostApprovalSection'
import { HostEnvTable } from '../../../components/HostEnvTable'
import { HostIdentityTab } from '../../../components/HostIdentityTab'
import { IconRobot } from '../../../components/Sidebar/icons'
import { IconCheck, IconPencil, IconX } from '../../../components/icons'
import {
  apiGet,
  apiSend,
  getAdminTeamAgents,
  getAdminUserAgents,
  getAgentTeams,
  getAgentUsers,
  getHost,
  getHostDetailBundle,
  updateAdminTeamAgents,
  updateAdminUserAgents,
} from '../../../lib/api'
import {
  LLM_PROVIDER_OPTIONS,
  type LlmProvider,
  getDefaultModel,
  getModelOptions,
  getProviderLabel,
  normalizeProvider,
} from '../../../lib/llm'
import type { ChannelResource, HostTab } from './types'

const TAB_LABELS: Record<HostTab, string> = {
  details: 'Overview',
  contexts: 'Contexts',
  env: 'Env vars',
  users: 'Member access',
  teams: 'Team access',
  identity: 'Identity',
}

function parseHostTab(value: string | undefined): HostTab {
  return HOST_TABS.includes(value as HostTab) ? (value as HostTab) : HOST_DEFAULT_TAB
}

export default function HostDetailsPage() {
  const params = useParams<{ name: string; tab?: string }>()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const routeName = decodeURIComponent(params.name || '')
  const mountedRef = useRef(true)

  const [activeTab, setActiveTab] = useState<HostTab>(() => parseHostTab(params.tab))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)

  const [showAddUser, setShowAddUser] = useState(false)
  const [showAddTeam, setShowAddTeam] = useState(false)
  const [editingOverview, setEditingOverview] = useState(false)
  const [editingContext, setEditingContext] = useState(false)
  const [showDeleteAgentConfirm, setShowDeleteAgentConfirm] = useState(false)
  const [deletingAgent, setDeletingAgent] = useState(false)
  const [deleteAgentDialogError, setDeleteAgentDialogError] = useState('')

  const [hostNameDraft, setHostNameDraft] = useState(routeName)
  const [hostDisplayDraft, setHostDisplayDraft] = useState('')
  const [contextRefDraft, setContextRefDraft] = useState('')
  const [providerDraft, setProviderDraft] = useState<LlmProvider>('openai')
  const [modelNameDraft, setModelNameDraft] = useState(getDefaultModel('openai'))
  const [secretRefDraft, setSecretRefDraft] = useState('')
  const [channelsDraft, setChannelsDraft] = useState<string[]>([])
  const [approvalToolsData, setApprovalToolsData] = useState<Record<string, boolean> | undefined>(
    undefined
  )

  const [availableContexts, setAvailableContexts] = useState<string[]>([])
  const [availableSecrets, setAvailableSecrets] = useState<string[]>([])
  const [allUsers, setAllUsers] = useState<
    Array<{ id: string; email: string; name: string | null; displayName: string | null }>
  >([])
  const [allTeams, setAllTeams] = useState<
    Array<{ id: string; name: string; memberCount: number }>
  >([])
  const [usersWithAccess, setUsersWithAccess] = useState<
    Array<{ id: string; email: string; name: string | null; displayName: string | null }>
  >([])
  const [teamsWithAccess, setTeamsWithAccess] = useState<Array<{ id: string; name: string }>>([])
  const [selectedUserIdsToGrant, setSelectedUserIdsToGrant] = useState<string[]>([])
  const [selectedTeamIdsToGrant, setSelectedTeamIdsToGrant] = useState<string[]>([])

  const userIdsWithAccess = useMemo(
    () => new Set(usersWithAccess.map(u => u.id)),
    [usersWithAccess]
  )
  const teamIdsWithAccess = useMemo(
    () => new Set(teamsWithAccess.map(t => t.id)),
    [teamsWithAccess]
  )
  const memberGrantOptions = useMemo(
    () =>
      allUsers
        .filter(user => !userIdsWithAccess.has(user.id))
        .map(user => ({
          value: user.id,
          label: user.displayName || user.name || user.email || user.id,
          description: user.email || user.id,
        })),
    [allUsers, userIdsWithAccess]
  )
  const teamGrantOptions = useMemo(
    () =>
      allTeams
        .filter(team => !teamIdsWithAccess.has(team.id))
        .map(team => ({
          value: team.id,
          label: team.name,
          badge: team.memberCount === 1 ? '1 member' : `${team.memberCount} members`,
        })),
    [allTeams, teamIdsWithAccess]
  )
  const hasPendingRename = hostNameDraft.trim() && hostNameDraft.trim() !== routeName
  const providerModelOptions = useMemo(() => getModelOptions(providerDraft), [providerDraft])

  useEffect(() => {
    setActiveTab(parseHostTab(params.tab))
  }, [params.tab])

  function hostTabHref(tab: HostTab): string {
    const base = `/hosts/${encodeURIComponent(routeName)}`
    return tab === 'details' ? base : `${base}/${tab}`
  }

  function selectTab(tab: HostTab) {
    setActiveTab(tab)
    router.replace(hostTabHref(tab))
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadData() {
    setBusy(true)
    setInitialLoading(true)
    setError('')
    try {
      const detail = await getHostDetailBundle(routeName)
      const {
        host,
        contexts: contextsList,
        secrets: secretsList,
        users,
        teams,
        agentUsers,
        agentTeams,
      } = detail
      if (!mountedRef.current) return
      const spec = host.spec || {}
      setHostNameDraft(String(host.metadata?.name || routeName))
      setHostDisplayDraft(String(spec.host || host.metadata?.name || routeName))
      setContextRefDraft(String(spec.contextRef || ''))
      const nextProvider = normalizeProvider(
        String((spec.model as { provider?: string } | undefined)?.provider || 'openai')
      )
      setProviderDraft(nextProvider)
      const availableModels = getModelOptions(nextProvider)
      const currentModel = String((spec.model as { name?: string } | undefined)?.name || '').trim()
      setModelNameDraft(
        availableModels.includes(currentModel) ? currentModel : getDefaultModel(nextProvider)
      )
      setSecretRefDraft(String(spec.secretRef || ''))
      setChannelsDraft(
        Array.isArray(spec.channels) ? spec.channels.map(String).filter(Boolean) : []
      )
      const rawTools = (spec.approval as { tools?: Record<string, boolean> } | undefined)?.tools
      setApprovalToolsData(rawTools && typeof rawTools === 'object' ? rawTools : undefined)

      const contextIds = (contextsList || [])
        .map(item => String(item.spec?.contextId || item.metadata?.name || '').trim())
        .filter(Boolean)
      setAvailableContexts(Array.from(new Set(contextIds)).sort((a, b) => a.localeCompare(b)))
      const secretNames = (secretsList || []).map(item => item.name.trim()).filter(Boolean)
      setAvailableSecrets(Array.from(new Set(secretNames)).sort((a, b) => a.localeCompare(b)))
      setAllUsers(Array.isArray(users) ? users : [])
      setAllTeams(Array.isArray(teams) ? teams : [])
      setUsersWithAccess(Array.isArray(agentUsers) ? agentUsers : [])
      setTeamsWithAccess(Array.isArray(agentTeams) ? agentTeams : [])
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Failed to load agent details')
    } finally {
      if (mountedRef.current) {
        setBusy(false)
        setInitialLoading(false)
      }
    }
  }

  useEffect(() => {
    void loadData()
  }, [routeName])

  async function saveHost() {
    const nextHostName = hostNameDraft.trim()
    if (!nextHostName) return

    setBusy(true)
    setError('')
    try {
      // Re-fetch to preserve fields that aren't editable in this form. K8s
      // replaceNamespacedCustomObject is a full replace, not a merge.
      const currentHost = await getHost(routeName)
      const nextSpec = {
        ...currentHost.spec,
        host: hostDisplayDraft.trim() || nextHostName,
        contextRef: contextRefDraft.trim(),
        secretRef: secretRefDraft.trim(),
        channels: channelsDraft,
        model: {
          provider: providerDraft,
          name: modelNameDraft.trim(),
        },
      }

      if (nextHostName !== routeName) {
        let createdNewHost = false
        const updatedChannels: Array<{ name: string; previousSpec: ChannelResource['spec'] }> = []
        const previousUserAgentNamesById = new Map<string, string[]>()
        const previousTeamAgentNamesById = new Map<string, string[]>()
        try {
          await apiSend('POST', '/api/v1/admin/hosts', {
            metadata: { name: nextHostName },
            spec: nextSpec,
          })
          createdNewHost = true

          const channels = (await apiGet('/api/v1/admin/communication-channels')) as {
            items?: ChannelResource[]
          }
          for (const channel of channels.items || []) {
            if (String(channel.spec?.hostRef || '').trim() !== routeName) continue
            const channelName = String(channel.metadata?.name || '').trim()
            if (!channelName) continue
            await apiSend(
              'PUT',
              `/api/v1/admin/communication-channels/${encodeURIComponent(channelName)}`,
              {
                spec: {
                  ...(channel.spec || {}),
                  hostRef: nextHostName,
                },
              }
            )
            updatedChannels.push({ name: channelName, previousSpec: channel.spec })
          }

          for (const user of usersWithAccess) {
            const userAccess = await getAdminUserAgents(user.id)
            const previousAgentNames = (userAccess.agentNames || [])
              .map(String)
              .map(v => v.trim())
              .filter(Boolean)
            previousUserAgentNamesById.set(user.id, previousAgentNames)
            const nextAgentNames = Array.from(
              new Set(previousAgentNames.map(name => (name === routeName ? nextHostName : name)))
            )
            await updateAdminUserAgents(user.id, nextAgentNames)
          }

          for (const team of teamsWithAccess) {
            const teamAccess = await getAdminTeamAgents(team.id)
            const previousAgentNames = (teamAccess.agentNames || [])
              .map(String)
              .map(v => v.trim())
              .filter(Boolean)
            previousTeamAgentNamesById.set(team.id, previousAgentNames)
            const nextAgentNames = Array.from(
              new Set(previousAgentNames.map(name => (name === routeName ? nextHostName : name)))
            )
            await updateAdminTeamAgents(team.id, nextAgentNames)
          }

          await apiSend('DELETE', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`)
          showToast('Agent renamed and updated.', { tone: 'success' })
          router.replace(`/hosts/${encodeURIComponent(nextHostName)}`)
          return
        } catch (renameError) {
          const rollbackErrors: string[] = []
          if (createdNewHost) {
            for (const [teamId, previousAgentNames] of Array.from(
              previousTeamAgentNamesById.entries()
            ).reverse()) {
              try {
                await updateAdminTeamAgents(teamId, previousAgentNames)
              } catch (rollbackError) {
                const rollbackMessage =
                  rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'
                rollbackErrors.push(`team ${teamId}: ${rollbackMessage}`)
              }
            }
            for (const [userId, previousAgentNames] of Array.from(
              previousUserAgentNamesById.entries()
            ).reverse()) {
              try {
                await updateAdminUserAgents(userId, previousAgentNames)
              } catch (rollbackError) {
                const rollbackMessage =
                  rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'
                rollbackErrors.push(`member ${userId}: ${rollbackMessage}`)
              }
            }
            for (const channel of [...updatedChannels].reverse()) {
              try {
                await apiSend(
                  'PUT',
                  `/api/v1/admin/communication-channels/${encodeURIComponent(channel.name)}`,
                  {
                    spec: {
                      ...(channel.previousSpec || {}),
                      hostRef: routeName,
                    },
                  }
                )
              } catch (rollbackError) {
                const rollbackMessage =
                  rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'
                rollbackErrors.push(`channel ${channel.name}: ${rollbackMessage}`)
              }
            }
            try {
              await apiSend('DELETE', `/api/v1/admin/hosts/${encodeURIComponent(nextHostName)}`)
            } catch (rollbackError) {
              const rollbackMessage =
                rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'
              rollbackErrors.push(`agent ${nextHostName}: ${rollbackMessage}`)
            }
          }
          if (rollbackErrors.length > 0) {
            const renameMessage =
              renameError instanceof Error ? renameError.message : 'Failed to rename agent'
            throw new Error(`${renameMessage} (rollback issues: ${rollbackErrors.join('; ')})`)
          }
          throw renameError
        }
      }

      await apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`, {
        spec: nextSpec,
      })
      await loadData()
      showToast('Agent configuration saved.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save agent')
    } finally {
      setBusy(false)
    }
  }

  const persistApprovalTools = useCallback(
    async (tools: Record<string, boolean>) => {
      setBusy(true)
      setError('')
      try {
        const currentHost = await getHost(routeName)
        const currentApproval = (currentHost.spec?.approval as Record<string, unknown>) ?? {}
        const nextSpec = {
          ...currentHost.spec,
          approval: { ...currentApproval, tools },
        }
        await apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`, {
          spec: nextSpec,
        })
        // Reload so the section gets fresh initialTools on its next render
        await loadData()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save approval tools')
        // Re-throw so HostApprovalSection.handleSave does NOT exit edit mode
        // and the operator's draft is preserved alongside the error banner.
        throw e
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeName]
  )

  async function grantUserAccess() {
    if (selectedUserIdsToGrant.length === 0 || hasPendingRename) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedUserIdsToGrant.map(async userId => {
          const current = await getAdminUserAgents(userId)
          const next = Array.from(new Set([...(current.agentNames || []), routeName]))
          await updateAdminUserAgents(userId, next)
        })
      )
      const grantedUserIds = selectedUserIdsToGrant
      const grantedUser = allUsers.find(u => u.id === grantedUserIds[0])
      setSelectedUserIdsToGrant([])
      const refreshed = await getAgentUsers(routeName)
      setUsersWithAccess(Array.isArray(refreshed.items) ? refreshed.items : [])
      showToast(
        grantedUserIds.length === 1
          ? `${grantedUser?.displayName || grantedUser?.name || grantedUserIds[0]} can now use this agent.`
          : `${grantedUserIds.length} members can now use this agent.`,
        { tone: 'success' }
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to grant member access')
    } finally {
      setBusy(false)
    }
  }

  async function revokeUserAccess(userId: string) {
    if (hasPendingRename) return
    const user = usersWithAccess.find(item => item.id === userId)
    const shouldRevoke = await confirm({
      title: 'Revoke Member Access',
      message: `Revoke ${user?.displayName || user?.name || user?.email || 'this member'}'s access to ${routeName}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setBusy(true)
    setError('')
    try {
      const current = await getAdminUserAgents(userId)
      const next = (current.agentNames || []).filter(name => name !== routeName)
      await updateAdminUserAgents(userId, next)
      const removedUser = usersWithAccess.find(u => u.id === userId)
      setUsersWithAccess(prev => prev.filter(u => u.id !== userId))
      showToast(
        `${removedUser?.displayName || removedUser?.name || userId} can no longer use this agent.`,
        { tone: 'success' }
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke member access')
    } finally {
      setBusy(false)
    }
  }

  async function grantTeamAccess() {
    if (selectedTeamIdsToGrant.length === 0 || hasPendingRename) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedTeamIdsToGrant.map(async teamId => {
          const current = await getAdminTeamAgents(teamId)
          const next = Array.from(new Set([...(current.agentNames || []), routeName]))
          await updateAdminTeamAgents(teamId, next)
        })
      )
      const grantedTeamIds = selectedTeamIdsToGrant
      const grantedTeam = allTeams.find(t => t.id === grantedTeamIds[0])
      setSelectedTeamIdsToGrant([])
      const refreshed = await getAgentTeams(routeName)
      setTeamsWithAccess(Array.isArray(refreshed.items) ? refreshed.items : [])
      showToast(
        grantedTeamIds.length === 1
          ? `${grantedTeam?.name || grantedTeamIds[0]} can now use this agent.`
          : `${grantedTeamIds.length} teams can now use this agent.`,
        { tone: 'success' }
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to grant team access')
    } finally {
      setBusy(false)
    }
  }

  async function revokeTeamAccess(teamId: string) {
    if (hasPendingRename) return
    const team = teamsWithAccess.find(item => item.id === teamId)
    const shouldRevoke = await confirm({
      title: 'Revoke Team Access',
      message: `Revoke ${team?.name || 'this team'}'s access to ${routeName}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setBusy(true)
    setError('')
    try {
      const current = await getAdminTeamAgents(teamId)
      const next = (current.agentNames || []).filter(name => name !== routeName)
      await updateAdminTeamAgents(teamId, next)
      const removedTeam = teamsWithAccess.find(t => t.id === teamId)
      setTeamsWithAccess(prev => prev.filter(team => team.id !== teamId))
      showToast(`${removedTeam?.name || teamId} can no longer use this agent.`, {
        tone: 'success',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke team access')
    } finally {
      setBusy(false)
    }
  }

  async function deleteAgentPermanently() {
    setDeletingAgent(true)
    setDeleteAgentDialogError('')
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`)
      setShowDeleteAgentConfirm(false)
      showToast(`Agent ${routeName} deleted.`, { tone: 'success' })
      router.push('/hosts')
    } catch (e) {
      setDeleteAgentDialogError(e instanceof Error ? e.message : 'Failed to delete agent')
    } finally {
      setDeletingAgent(false)
    }
  }

  return (
    <DetailPageShell<HostTab>
      activeTab={activeTab}
      backLabel="Back to agents"
      error={error}
      icon={<IconRobot />}
      notice={
        hasPendingRename ? (
          <div className="cu-banner cu-banner--warning">
            Save agent rename before changing user or team access.
          </div>
        ) : null
      }
      onBack={() => router.push('/hosts')}
      onTabChange={selectTab}
      subtitle="Configuration and access for this agent."
      tabAriaLabel="Agent sections"
      tabClassName="cu-tabs--compact"
      tabs={HOST_TABS.map(tab => ({
        value: tab,
        label: TAB_LABELS[tab],
        href: hostTabHref(tab),
      }))}
      title={`Agent: ${routeName}`}
    >
      {activeTab === 'details' && (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '1rem',
            }}
          >
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
              Agent configuration and settings.
            </p>
            {!editingOverview && (
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setEditingOverview(true)}
                disabled={busy}
              >
                Edit
              </button>
            )}
          </div>
          <div className="cu-form-stack">
            <div className="cu-field">
              <label htmlFor="host-name">Name</label>
              {editingOverview ? (
                <input
                  id="host-name"
                  value={hostNameDraft}
                  onChange={e => setHostNameDraft(e.target.value)}
                  disabled={busy}
                  autoFocus
                />
              ) : (
                <div className="cu-field__readonly">{hostNameDraft || routeName}</div>
              )}
            </div>
            <div className="cu-field">
              <label htmlFor="host-display">Display ID</label>
              {editingOverview ? (
                <input
                  id="host-display"
                  value={hostDisplayDraft}
                  onChange={e => setHostDisplayDraft(e.target.value)}
                  disabled={busy}
                />
              ) : (
                <div className="cu-field__readonly">{hostDisplayDraft || '-'}</div>
              )}
            </div>
            <div className="cu-field">
              <label htmlFor="host-provider">Model provider</label>
              {editingOverview ? (
                <select
                  id="host-provider"
                  value={providerDraft}
                  onChange={e => {
                    const nextProvider = normalizeProvider(e.target.value)
                    setProviderDraft(nextProvider)
                    setModelNameDraft(getDefaultModel(nextProvider))
                  }}
                  disabled={busy}
                >
                  {LLM_PROVIDER_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="cu-field__readonly">{getProviderLabel(providerDraft)}</div>
              )}
            </div>
            <div className="cu-field">
              <label htmlFor="host-model">Model name</label>
              {editingOverview ? (
                <select
                  id="host-model"
                  value={modelNameDraft}
                  onChange={e => setModelNameDraft(e.target.value)}
                  disabled={busy}
                >
                  {providerModelOptions.map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="cu-field__readonly">{modelNameDraft || '-'}</div>
              )}
            </div>
            <div className="cu-field" style={{ marginBottom: 0 }}>
              <label htmlFor="host-secret">Secret ref</label>
              {editingOverview ? (
                <select
                  id="host-secret"
                  value={secretRefDraft}
                  onChange={e => setSecretRefDraft(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Select LLM secret</option>
                  {availableSecrets.map(secretName => (
                    <option key={secretName} value={secretName}>
                      {secretName}
                    </option>
                  ))}
                  {secretRefDraft && !availableSecrets.includes(secretRefDraft) ? (
                    <option value={secretRefDraft}>{secretRefDraft} (custom)</option>
                  ) : null}
                </select>
              ) : (
                <div className="cu-field__readonly">{secretRefDraft || '-'}</div>
              )}
            </div>
          </div>
          {editingOverview && (
            <div className="cu-save-bar">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setEditingOverview(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await saveHost()
                  setEditingOverview(false)
                }}
                disabled={busy || !hostNameDraft.trim()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          {!initialLoading && (
            <HostApprovalSection
              initialTools={approvalToolsData}
              onSave={persistApprovalTools}
              busy={busy}
              canWrite={
                true /* TODO: wire to actual host:write check if/when per-field RBAC lands */
              }
            />
          )}

          {!initialLoading && (
            <div
              style={{
                marginTop: '2rem',
                paddingTop: '1.25rem',
                borderTop: '1px solid var(--cu-border)',
              }}
            >
              <p className="cu-section-title" style={{ marginBottom: '0.5rem' }}>
                Danger zone
              </p>
              <p className="cu-muted" style={{ fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
                Permanently delete this agent and its direct access mappings.
              </p>
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                style={{ color: 'var(--cu-danger)' }}
                onClick={() => {
                  setDeleteAgentDialogError('')
                  setShowDeleteAgentConfirm(true)
                }}
                disabled={busy}
              >
                Delete agent...
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === 'contexts' && (
        <>
          <p className="cu-muted" style={{ fontSize: '0.875rem', marginBottom: '1rem' }}>
            Associated context for this agent.
          </p>
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band cu-table--static-rows">
              <thead>
                <tr>
                  <th>Context</th>
                  <th className="cu-table__col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialLoading ? (
                  <tr>
                    <td colSpan={2} className="cu-empty">
                      Loading…
                    </td>
                  </tr>
                ) : (
                  <tr>
                    <td>
                      {editingContext ? (
                        <select
                          className="cu-input cu-host-context-select"
                          value={contextRefDraft}
                          onChange={e => setContextRefDraft(e.target.value)}
                          disabled={busy}
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Escape') {
                              setEditingContext(false)
                            }
                          }}
                        >
                          <option value="">Select context</option>
                          {availableContexts.map(contextId => (
                            <option key={contextId} value={contextId}>
                              {contextId}
                            </option>
                          ))}
                        </select>
                      ) : contextRefDraft.trim() ? (
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() =>
                            router.push(`/contexts/${encodeURIComponent(contextRefDraft.trim())}`)
                          }
                        >
                          {contextRefDraft}
                        </button>
                      ) : (
                        <span className="cu-table__cell-muted">No context selected</span>
                      )}
                    </td>
                    <td className="cu-table__cell-actions">
                      {editingContext ? (
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--toolbar"
                          onClick={async () => {
                            await saveHost()
                            setEditingContext(false)
                          }}
                          disabled={busy}
                          aria-label="Save context"
                          title="Save context"
                        >
                          <IconCheck width={16} height={16} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--toolbar"
                          onClick={() => setEditingContext(true)}
                          disabled={busy}
                          aria-label="Edit context"
                          title="Edit context"
                        >
                          <IconPencil width={16} height={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'env' && <HostEnvTable hostRef={routeName} />}

      {activeTab === 'identity' && <HostIdentityTab hostName={routeName} />}

      {activeTab === 'users' && (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '1rem',
            }}
          >
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
              Grant or revoke which members can use this agent.
            </p>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddUser(true)}
              disabled={busy || hasPendingRename}
            >
              Add member
            </button>
          </div>
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Member</th>
                  <th className="cu-table__col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialLoading ? (
                  [1, 2, 3].map(i => (
                    <tr key={i}>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '10rem' }}
                        ></div>
                      </td>
                      <td></td>
                    </tr>
                  ))
                ) : usersWithAccess.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="cu-empty">
                      No members have access yet.
                    </td>
                  </tr>
                ) : (
                  usersWithAccess.map(user => (
                    <tr key={user.id}>
                      <td>
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() =>
                            router.push(`/profile-admin/users/${encodeURIComponent(user.id)}`)
                          }
                        >
                          {user.displayName || user.name || user.email}
                        </button>
                      </td>
                      <td className="cu-table__cell-actions">
                        <div className="cu-row-actions">
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => void revokeUserAccess(user.id)}
                            disabled={busy || hasPendingRename}
                            title="Revoke"
                            aria-label="Revoke member access"
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'teams' && (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '1rem',
            }}
          >
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
              Grant or revoke team-level access to this agent.
            </p>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddTeam(true)}
              disabled={busy || hasPendingRename}
            >
              Add team
            </button>
          </div>
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="cu-table__col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialLoading ? (
                  [1, 2, 3].map(i => (
                    <tr key={i}>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '10rem' }}
                        ></div>
                      </td>
                      <td></td>
                    </tr>
                  ))
                ) : teamsWithAccess.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="cu-empty">
                      No teams have access yet.
                    </td>
                  </tr>
                ) : (
                  teamsWithAccess.map(team => (
                    <tr key={team.id}>
                      <td>
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() =>
                            router.push(`/profile-admin/teams/${encodeURIComponent(team.id)}`)
                          }
                        >
                          {team.name}
                        </button>
                      </td>
                      <td className="cu-table__cell-actions">
                        <div className="cu-row-actions">
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => void revokeTeamAccess(team.id)}
                            disabled={busy || hasPendingRename}
                            title="Revoke"
                            aria-label="Revoke team access"
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {showAddUser && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--cu-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddUser(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-user-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-user-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add member
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddUser(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="agent-member-picker">Members</label>
              <SelectionDropdown
                id="agent-member-picker"
                inline
                value={selectedUserIdsToGrant}
                onChange={setSelectedUserIdsToGrant}
                options={memberGrantOptions}
                placeholder="Select members"
                searchPlaceholder="Search members..."
                selectionLabel="Selected members"
                emptyLabel="No available members."
                disabled={busy || hasPendingRename}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddUser(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await grantUserAccess()
                  setShowAddUser(false)
                }}
                disabled={busy || selectedUserIdsToGrant.length === 0 || hasPendingRename}
              >
                {selectedUserIdsToGrant.length > 1 ? 'Add members' : 'Add member'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddTeam && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--cu-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddTeam(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-team-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-team-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add team
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddTeam(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="agent-team-picker">Teams</label>
              <SelectionDropdown
                id="agent-team-picker"
                inline
                value={selectedTeamIdsToGrant}
                onChange={setSelectedTeamIdsToGrant}
                options={teamGrantOptions}
                placeholder="Select teams"
                searchPlaceholder="Search teams..."
                selectionLabel="Selected teams"
                emptyLabel="No available teams."
                disabled={busy || hasPendingRename}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddTeam(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await grantTeamAccess()
                  setShowAddTeam(false)
                }}
                disabled={busy || selectedTeamIdsToGrant.length === 0 || hasPendingRename}
              >
                {selectedTeamIdsToGrant.length > 1 ? 'Add teams' : 'Add team'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteAgentConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--cu-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !deletingAgent) setShowDeleteAgentConfirm(false)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="confirm-delete-agent"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="confirm-delete-agent" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Delete agent permanently?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowDeleteAgentConfirm(false)}
                disabled={deletingAgent}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              This removes <strong>{routeName}</strong> and cannot be undone.
            </p>
            {deleteAgentDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteAgentDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowDeleteAgentConfirm(false)}
                disabled={deletingAgent}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                style={{ background: 'var(--cu-danger)', borderColor: 'var(--cu-danger)' }}
                onClick={() => void deleteAgentPermanently()}
                disabled={deletingAgent}
              >
                {deletingAgent ? 'Deleting…' : 'Delete agent'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </DetailPageShell>
  )
}
