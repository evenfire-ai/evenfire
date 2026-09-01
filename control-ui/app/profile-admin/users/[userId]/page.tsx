'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DetailPageShell } from '@components/DetailPageShell'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TeamRolePermissionEditor } from '@components/TeamRolePermissionEditor'
import { useToast } from '@components/Toast'
import { CheckboxField } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { accessScopeLabeler } from '@lib/accessScopeLabels'
import { partitionVisibleAccess } from '@lib/accessVisibility'
import { getAgentDisplayName } from '@lib/agentName'
import type { DeleteCandidateTeam } from '@lib/profileAdminDelete'
import { formatTeamNames, getSoloMemberTeamsForUser } from '@lib/profileAdminDelete'
import { ConnectorCountCell } from '../../../../components/ConnectorCountCell'
import { IconUsers } from '../../../../components/Sidebar/icons'
import { UserApprovalMediumsPanel } from '../../../../components/UserApprovalMediumsPanel'
import { IconPencil, IconX } from '../../../../components/icons'
import {
  AdminUserChannels,
  ContextResource,
  DeleteAdminUserRequest,
  HostResource,
  addAdminTeamMember,
  apiGet,
  createDeleteAdminUserRequest,
  deleteAdminMember,
  deleteAdminTeam,
  deleteAdminUser,
  getAdminTeam,
  getAdminTeams,
  getAdminUserAgents,
  getAdminUserContext,
  getAdminUserContexts,
  getAdminUserTeams,
  getContexts,
  getHosts,
  updateAdminMemberRole,
  updateAdminUserAgents,
  updateAdminUserContext,
  updateAdminUserContexts,
} from '../../../../lib/api'
import {
  type CommunicationChannelItem,
  formatCommunicationChannelConfirmedAt,
} from '../../../../lib/communicationChannels'
import { formatTeamRole, permissionsForTeamRole } from '../../../../lib/teamRoles'

type TeamRole = 'admin' | 'inviter' | 'member'

type UserTab = 'contact' | 'approval-dms' | 'communication-channels' | 'agents' | 'teams'
const USER_TABS: UserTab[] = [
  'contact',
  'approval-dms',
  'communication-channels',
  'agents',
  'teams',
]

const USER_TAB_LABELS: Record<UserTab, string> = {
  contact: 'Contact',
  'approval-dms': 'Approval DMs',
  'communication-channels': 'Communication Channels',
  agents: 'Agents',
  teams: 'Teams',
}

function parseUserTab(value: string | undefined): UserTab {
  return USER_TABS.includes(value as UserTab) ? (value as UserTab) : 'contact'
}

export default function UserDetailsPage() {
  const params = useParams<{ userId: string; tab?: string }>()
  const router = useRouter()
  const userId = decodeURIComponent(params.userId || '')
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const deleteUserTeamCheckIdRef = useRef(0)
  const deleteUserRequestRef = useRef<DeleteAdminUserRequest | null>(null)

  const [activeTab, setActiveTab] = useState<UserTab>(() => parseUserTab(params.tab))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)
  const [editingContact, setEditingContact] = useState(false)
  const [showAddContext, setShowAddContext] = useState(false)
  const [showAddTeam, setShowAddTeam] = useState(false)

  const [showDeleteUserConfirm, setShowDeleteUserConfirm] = useState(false)
  const [deletingUserAccount, setDeletingUserAccount] = useState(false)
  const [deleteUserDialogError, setDeleteUserDialogError] = useState('')
  const [deleteUserSoloTeams, setDeleteUserSoloTeams] = useState<DeleteCandidateTeam[]>([])
  const [deleteUserTeamCheckError, setDeleteUserTeamCheckError] = useState('')
  const [deleteUserTeamCheckLoading, setDeleteUserTeamCheckLoading] = useState(false)
  const [deleteEmptyTeamsWithUser, setDeleteEmptyTeamsWithUser] = useState(false)

  const [userName, setUserName] = useState('')
  const [emailDraft, setEmailDraft] = useState('')
  const [contactEmailsDraft, setContactEmailsDraft] = useState<string[]>([])
  const [slackHandlesDraft, setSlackHandlesDraft] = useState<string[]>([])
  const [telegramIdsDraft, setTelegramIdsDraft] = useState<string[]>([])
  const [newContactEmail, setNewContactEmail] = useState('')
  const [newSlackHandle, setNewSlackHandle] = useState('')
  const [newTelegramId, setNewTelegramId] = useState('')

  const [contextResources, setContextResources] = useState<ContextResource[]>([])
  const [availableContextIds, setAvailableContextIds] = useState<string[]>([])
  const [assignedContextIds, setAssignedContextIds] = useState<string[]>([])
  const [deletedContextIds, setDeletedContextIds] = useState<string[]>([])
  const [selectedContextIdsToAdd, setSelectedContextIdsToAdd] = useState<string[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [assignedAgentNames, setAssignedAgentNames] = useState<string[]>([])
  const [deletedAgentNames, setDeletedAgentNames] = useState<string[]>([])
  const [observedAgentNames, setObservedAgentNames] = useState<string[]>([])
  const [selectedAgentNamesToAdd, setSelectedAgentNamesToAdd] = useState<string[]>([])
  const [communicationChannels, setCommunicationChannels] = useState<CommunicationChannelItem[]>([])

  const [userTeams, setUserTeams] = useState<Array<{ id: string; name: string; role: TeamRole }>>(
    []
  )
  const [allTeams, setAllTeams] = useState<
    Array<{ id: string; name: string; memberCount: number }>
  >([])
  const [selectedTeamIdsToAdd, setSelectedTeamIdsToAdd] = useState<string[]>([])
  const [selectedRoleToAdd, setSelectedRoleToAdd] = useState<TeamRole>('member')
  const [roleEditTeam, setRoleEditTeam] = useState<{
    id: string
    name: string
    role: TeamRole
  } | null>(null)
  const [roleEditDraft, setRoleEditDraft] = useState<TeamRole>('member')

  const existingTeamIds = useMemo(() => new Set(userTeams.map(team => team.id)), [userTeams])
  // Label resolution must be declared before its first consumer
  // (`availableContextOptions` below) — accessing it earlier throws a TDZ
  // ReferenceError that takes the whole member page down.
  // contextRef → attached connector names (for the per-agent Connectors column,
  // same design and hover logic as the Agents table).
  const contextsByRef = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const context of contextResources) {
      const ref = String(context.spec?.contextId || context.metadata?.name || '').trim()
      if (!ref) continue
      map[ref] = Array.isArray(context.spec?.mcpServers) ? context.spec.mcpServers.map(String) : []
    }
    return map
  }, [contextResources])

  const hostsByName = useMemo(() => {
    const map = new Map<string, HostResource>()
    for (const host of hosts || []) {
      const name = String(host.metadata?.name || '').trim()
      if (name) map.set(name, host)
    }
    return map
  }, [hosts])

  // The granted set is agent-centric (D8): the direct member↔agent mapping,
  // unioned with agents resolved from legacy scope-only mappings so nothing
  // granted before this change disappears.
  const grantedAgentNames = useMemo(() => {
    const granted = new Set(assignedAgentNames)
    for (const contextId of assignedContextIds) {
      for (const [name, host] of hostsByName) {
        if (
          String((host.spec as { contextRef?: string } | undefined)?.contextRef || '').trim() ===
          contextId
        ) {
          granted.add(name)
        }
      }
    }
    return [...granted].sort((a, b) => a.localeCompare(b))
  }, [assignedAgentNames, assignedContextIds, hostsByName])

  const agentDisplay = (agentName: string): string => {
    const host = hostsByName.get(agentName)
    return String((host?.spec as { host?: string } | undefined)?.host || '').trim() || agentName
  }

  const agentContextRef = (agentName: string): string => {
    const host = hostsByName.get(agentName)
    return String((host?.spec as { contextRef?: string } | undefined)?.contextRef || '').trim()
  }

  const accessLabeler = useMemo(
    () => accessScopeLabeler(contextResources, hosts || []),
    [contextResources, hosts]
  )
  function accessLabelFor(contextId: string): { label: string; resolved: boolean } {
    return accessLabeler(contextId)
  }
  const hostNameOptions = useMemo(
    () =>
      Array.from(
        new Set((hosts || []).map(host => String(host.metadata?.name || '').trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [hosts]
  )
  const availableTeamOptions = useMemo(
    () =>
      allTeams
        .filter(team => !existingTeamIds.has(team.id))
        .map(team => ({
          value: team.id,
          label: team.name,
          badge: team.memberCount === 1 ? '1 member' : `${team.memberCount} members`,
        })),
    [allTeams, existingTeamIds]
  )
  const availableAgentOptions = useMemo(
    () =>
      hostNameOptions
        .filter(agentName => !assignedAgentNames.includes(agentName))
        .map(agentName => ({
          value: agentName,
          label: getAgentDisplayName(agentName, hosts),
          description: agentName,
        })),
    [assignedAgentNames, hostNameOptions, hosts]
  )
  const userCommunicationConversations = useMemo(
    () =>
      communicationChannels.flatMap(channel => {
        const channelName = channel.metadata?.name || ''
        return (channel.spec?.telegram || [])
          .filter(group => group.confirmedByUserId === userId)
          .map(group => ({
            channelName,
            conversation: group,
          }))
      }),
    [communicationChannels, userId]
  )

  useEffect(() => {
    setActiveTab(parseUserTab(params.tab))
  }, [params.tab])

  function userTabHref(tab: UserTab): string {
    return CONTROL_ROUTES.usersAndTeams.userTab(userId, tab)
  }

  function selectTab(tab: UserTab) {
    setActiveTab(tab)
    router.replace(userTabHref(tab))
  }

  function uniqueTrimmed(values: string[], lowerCase = false): string[] {
    const seen = new Set<string>()
    const output: string[] = []
    values.forEach(raw => {
      const trimmed = (lowerCase ? raw.toLowerCase() : raw).trim()
      if (!trimmed || seen.has(trimmed)) return
      seen.add(trimmed)
      output.push(trimmed)
    })
    return output
  }

  function contextIdFromResource(item: {
    metadata?: { name?: string }
    spec?: { contextId?: string }
  }) {
    return String(item.spec?.contextId || item.metadata?.name || '').trim()
  }

  async function loadData() {
    setBusy(true)
    setError('')
    try {
      const [
        context,
        contexts,
        contextAccess,
        teamsData,
        userTeamsData,
        hostsData,
        userAgentAccess,
        communicationChannelsData,
      ] = await Promise.all([
        getAdminUserContext(userId),
        getContexts(),
        getAdminUserContexts(userId),
        getAdminTeams(),
        getAdminUserTeams(userId),
        getHosts(),
        getAdminUserAgents(userId),
        apiGet(
          `/api/v1/admin/communication-channels?confirmedByUserId=${encodeURIComponent(userId)}`
        ) as Promise<{ items?: CommunicationChannelItem[] }>,
      ])

      setEmailDraft(context.email || '')
      setUserName(context.name || context.displayName || context.email || '')
      setContactEmailsDraft(uniqueTrimmed(context.channels.emails || [], true))
      setSlackHandlesDraft(uniqueTrimmed(context.channels.slackUserNames || []))
      setTelegramIdsDraft(uniqueTrimmed(context.channels.telegramIds || []))
      const ids = (contexts.items || [])
        .map(item => contextIdFromResource(item as never))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
      const hostNames = Array.from(
        new Set(
          (hostsData.items || [])
            .map(host => String(host.metadata?.name || '').trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b))
      const contextPartition = partitionVisibleAccess(
        Array.isArray(contextAccess.contextIds) ? contextAccess.contextIds : [],
        ids,
        Array.isArray(contextAccess.deletedContextIds) ? contextAccess.deletedContextIds : []
      )
      const agentPartition = partitionVisibleAccess(
        Array.isArray(userAgentAccess.agentNames) ? userAgentAccess.agentNames : [],
        hostNames,
        Array.isArray(userAgentAccess.deletedAgentNames) ? userAgentAccess.deletedAgentNames : []
      )
      setAssignedContextIds(contextPartition.active)
      setDeletedContextIds(contextPartition.deleted)
      setAllTeams(Array.isArray(teamsData.items) ? teamsData.items : [])
      setUserTeams(Array.isArray(userTeamsData.items) ? userTeamsData.items : [])
      setHosts(Array.isArray(hostsData.items) ? hostsData.items : [])
      setAssignedAgentNames(agentPartition.active)
      setDeletedAgentNames(agentPartition.deleted)
      setObservedAgentNames([
        ...(userAgentAccess.agentNames || []),
        ...(userAgentAccess.deletedAgentNames || []),
      ])
      setCommunicationChannels(communicationChannelsData.items || [])
      setAvailableContextIds(ids)
      setContextResources((contexts.items || []) as ContextResource[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load member details')
    } finally {
      setBusy(false)
      setInitialLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [userId])

  async function saveProfile() {
    setBusy(true)
    setError('')
    try {
      const payload: { email: string; name: string; channels: AdminUserChannels } = {
        email: emailDraft.trim().toLowerCase(),
        name: userName.trim(),
        channels: {
          emails: uniqueTrimmed(contactEmailsDraft, true),
          slackUserNames: uniqueTrimmed(slackHandlesDraft),
          telegramIds: uniqueTrimmed(telegramIdsDraft),
        },
      }
      const updated = await updateAdminUserContext(userId, payload)
      setUserName(updated.name || updated.displayName || updated.email || '')
      setEmailDraft(updated.email || '')
      const requestedName = payload.name.trim()
      const persistedName = String(updated.name || updated.displayName || '').trim()
      if (requestedName && persistedName && requestedName !== persistedName) {
        setError(
          'Member name was not persisted by the API. The running control-api service is likely outdated and needs redeploy.'
        )
        showToast('Member contact channels updated, but name update was not applied.', {
          tone: 'success',
        })
      } else if (requestedName && !persistedName) {
        setError(
          'Member name was not returned by the API after save. The running control-api service is likely outdated.'
        )
        showToast('Member contact channels updated, but name update was not applied.', {
          tone: 'success',
        })
      } else {
        showToast('Member contact details updated.', { tone: 'success' })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update member profile')
    } finally {
      setBusy(false)
    }
  }

  async function addUserToTeams() {
    if (selectedTeamIdsToAdd.length === 0) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedTeamIdsToAdd.map(teamId => addAdminTeamMember(teamId, userId, selectedRoleToAdd))
      )
      const teams = await Promise.all(selectedTeamIdsToAdd.map(teamId => getAdminTeam(teamId)))
      setUserTeams(prev => [
        ...prev,
        ...teams.map(team => ({ id: team.id, name: team.name, role: selectedRoleToAdd })),
      ])
      const addedCount = selectedTeamIdsToAdd.length
      setSelectedTeamIdsToAdd([])
      showToast(addedCount === 1 ? 'Member associated to team.' : 'Member associated to teams.', {
        tone: 'success',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member to team')
    } finally {
      setBusy(false)
    }
  }

  async function updateUserTeamRole(teamId: string, role: TeamRole) {
    setBusy(true)
    setError('')
    try {
      await updateAdminMemberRole(teamId, userId, role)
      setUserTeams(current => current.map(team => (team.id === teamId ? { ...team, role } : team)))
      showToast('Member team permissions updated.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update team permissions')
    } finally {
      setBusy(false)
    }
  }

  async function removeUserFromTeam(team: { id: string; name: string }) {
    const shouldRemove = await confirm({
      title: 'Remove member from team?',
      message: `Remove ${userName || emailDraft || 'this member'} from ${team.name}?`,
      confirmLabel: 'Remove member',
      tone: 'danger',
    })
    if (!shouldRemove) return
    setBusy(true)
    setError('')
    try {
      await deleteAdminMember(team.id, userId)
      setUserTeams(current => current.filter(item => item.id !== team.id))
      showToast('Member removed from team.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member from team')
    } finally {
      setBusy(false)
    }
  }

  // D8 composite write: the tab manages AGENTS. Under the hood both legacy
  // mappings stay in sync — the member↔agent mapping AND the member↔scope
  // mapping — so whichever table the runtime enforces, the grant works.
  async function saveAccess(nextGrantedAgents: string[], message: string) {
    setBusy(true)
    setError('')
    try {
      const normalizedAgents = Array.from(
        new Set(nextGrantedAgents.map(v => v.trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b))

      // Scopes: keep legacy ids that map to no known agent; add the scopes of
      // newly granted agents; drop the scopes of revoked agents unless
      // another still-granted agent shares them.
      const nextRefs = new Set<string>()
      for (const agentName of normalizedAgents) {
        const ref = agentContextRef(agentName)
        if (ref) nextRefs.add(ref)
      }
      const nextContextIds = availableContextIds.filter(contextId => {
        const owner = [...hostsByName.values()].some(
          host =>
            String((host.spec as { contextRef?: string } | undefined)?.contextRef || '').trim() ===
            contextId
        )
        // Keep legacy scope-only mappings untouched; managed ones follow the
        // agent grant state.
        return owner ? nextRefs.has(contextId) : true
      })
      for (const ref of nextRefs) {
        if (!nextContextIds.includes(ref)) nextContextIds.push(ref)
      }

      const [updatedAgents, updatedContexts] = await Promise.all([
        updateAdminUserAgents(userId, normalizedAgents, observedAgentNames),
        updateAdminUserContexts(
          userId,
          nextContextIds.sort((a, b) => a.localeCompare(b))
        ),
      ])

      const hostNames = [...hostsByName.keys()]
      const agentPartition = partitionVisibleAccess(
        Array.isArray(updatedAgents.agentNames) ? updatedAgents.agentNames : [],
        hostNames,
        Array.isArray(updatedAgents.deletedAgentNames) ? updatedAgents.deletedAgentNames : []
      )
      const contextPartition = partitionVisibleAccess(
        Array.isArray(updatedContexts.contextIds) ? updatedContexts.contextIds : [],
        availableContextIds,
        Array.isArray(updatedContexts.deletedContextIds) ? updatedContexts.deletedContextIds : []
      )
      setAssignedAgentNames(agentPartition.active)
      setDeletedAgentNames(agentPartition.deleted)
      setDeletedAgentNames(agentPartition.deleted)
      setAssignedContextIds(contextPartition.active)
      setDeletedContextIds(contextPartition.deleted)
      setSelectedAgentNamesToAdd([])
      setSelectedContextIdsToAdd([])
      showToast(message, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update member access')
    } finally {
      setBusy(false)
    }
  }

  async function removeAccess(agentName: string) {
    const target = agentDisplay(agentName)
    const shouldRemove = await confirm({
      title: 'Remove Agent',
      message: `Remove ${userName || emailDraft || 'this member'}'s access to ${target}? This revokes the agent and every connector it carries.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!shouldRemove) return

    await saveAccess(
      grantedAgentNames.filter(name => name !== agentName),
      'Agents updated.'
    )
  }

  async function openDeleteUserConfirm() {
    const checkId = deleteUserTeamCheckIdRef.current + 1
    deleteUserTeamCheckIdRef.current = checkId
    setDeleteUserDialogError('')
    setDeleteUserTeamCheckError('')
    setDeleteUserSoloTeams([])
    setDeleteEmptyTeamsWithUser(false)
    setDeleteUserTeamCheckLoading(false)
    deleteUserRequestRef.current = createDeleteAdminUserRequest()
    setShowDeleteUserConfirm(true)
    if (userTeams.length === 0) return

    setDeleteUserTeamCheckLoading(true)
    try {
      const [userTeamsData, teamsData] = await Promise.all([
        getAdminUserTeams(userId),
        getAdminTeams(),
      ])
      if (deleteUserTeamCheckIdRef.current === checkId) {
        setDeleteUserSoloTeams(
          getSoloMemberTeamsForUser(userTeamsData.items || [], teamsData.items || [])
        )
      }
    } catch (e) {
      if (deleteUserTeamCheckIdRef.current === checkId) {
        setDeleteUserTeamCheckError(
          e instanceof Error ? e.message : 'Failed to check teams before deleting member'
        )
      }
    } finally {
      if (deleteUserTeamCheckIdRef.current === checkId) {
        setDeleteUserTeamCheckLoading(false)
      }
    }
  }

  async function deleteUserPermanently() {
    setDeletingUserAccount(true)
    setDeleteUserDialogError('')
    setDeleteUserTeamCheckError('')
    const teamsToDelete = deleteEmptyTeamsWithUser ? deleteUserSoloTeams : []
    setError('')
    try {
      await deleteAdminUser(
        userId,
        deleteUserRequestRef.current ??
          (deleteUserRequestRef.current = createDeleteAdminUserRequest())
      )
      const teamDeleteResults = await Promise.allSettled(
        teamsToDelete.map(team => deleteAdminTeam(team.id))
      )
      const failedTeams = teamsToDelete.filter((_, index) => {
        const result = teamDeleteResults[index]
        return result?.status === 'rejected'
      })
      setShowDeleteUserConfirm(false)
      deleteUserRequestRef.current = null
      if (failedTeams.length > 0) {
        showToast(
          `Member deleted, but ${failedTeams.length === 1 ? 'team' : 'teams'} could not be deleted: ${formatTeamNames(failedTeams)}.`,
          { tone: 'error' }
        )
      } else {
        showToast(
          teamsToDelete.length > 0
            ? `Member and ${teamsToDelete.length === 1 ? 'empty team' : 'empty teams'} deleted.`
            : 'Member deleted.',
          { tone: 'success' }
        )
      }
      router.push(CONTROL_ROUTES.usersAndTeams.users)
    } catch (e) {
      setDeleteUserDialogError(e instanceof Error ? e.message : 'Failed to delete member')
    } finally {
      setDeletingUserAccount(false)
    }
  }

  return (
    <DetailPageShell<UserTab>
      activeTab={activeTab}
      backLabel="Back to members"
      error={error}
      icon={<IconUsers />}
      onBack={() => router.push(CONTROL_ROUTES.usersAndTeams.users)}
      onTabChange={selectTab}
      subtitle={
        initialLoading
          ? 'Loading member details...'
          : 'Channels, approval DMs, connector access, teams, and agents.'
      }
      tabAriaLabel="Member sections"
      tabs={USER_TABS.map(tab => ({
        value: tab,
        label: USER_TAB_LABELS[tab],
        href: userTabHref(tab),
      }))}
      title={initialLoading && !userName ? 'Member' : userName || userId}
    >
      {activeTab === 'contact' && (
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
              Primary email and channel identifiers used for routing.
            </p>
            {!editingContact && (
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setEditingContact(true)}
                disabled={busy}
              >
                Edit
              </button>
            )}
          </div>

          <div className="cu-form-stack">
            <div className="cu-field">
              <label htmlFor="user-name">Member name</label>
              {editingContact ? (
                <input
                  id="user-name"
                  value={userName}
                  onChange={e => setUserName(e.target.value)}
                  placeholder="Full name"
                  disabled={busy}
                  autoFocus
                />
              ) : (
                <div className="cu-field__readonly">{userName || '-'}</div>
              )}
            </div>

            <div className="cu-field">
              <label htmlFor="user-primary-email">Primary email</label>
              {editingContact ? (
                <input
                  id="user-primary-email"
                  value={emailDraft}
                  onChange={e => setEmailDraft(e.target.value)}
                  placeholder="user@example.com"
                  disabled={busy}
                />
              ) : (
                <div className="cu-field__readonly">{emailDraft || '-'}</div>
              )}
            </div>

            <div className="cu-field">
              <label>Contact emails</label>
              {editingContact ? (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.35rem',
                    alignItems: 'center',
                  }}
                >
                  {contactEmailsDraft.map(email => (
                    <span
                      key={email}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        background: 'var(--cu-bg-elevated)',
                        padding: '0.25rem 0.5rem',
                        borderRadius: 'var(--cu-radius-sm)',
                        fontSize: '0.875rem',
                      }}
                    >
                      {email}
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => setContactEmailsDraft(prev => prev.filter(v => v !== email))}
                        disabled={busy}
                        style={{ padding: 0 }}
                      >
                        <IconX width={12} height={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    value={newContactEmail}
                    onChange={e => setNewContactEmail(e.target.value)}
                    placeholder="Add email"
                    disabled={busy}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newContactEmail.trim()) {
                        setContactEmailsDraft(prev =>
                          uniqueTrimmed([...prev, newContactEmail], true)
                        )
                        setNewContactEmail('')
                      }
                    }}
                    style={{
                      width: 'auto',
                      flex: 1,
                      minWidth: '8rem',
                      fontSize: '0.875rem',
                      padding: '0.25rem 0.5rem',
                    }}
                  />
                </div>
              ) : (
                <div className="cu-field__readonly">
                  {contactEmailsDraft.length > 0 ? contactEmailsDraft.join(', ') : 'None'}
                </div>
              )}
            </div>

            <div className="cu-field">
              <label>Slack handles</label>
              {editingContact ? (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.35rem',
                    alignItems: 'center',
                  }}
                >
                  {slackHandlesDraft.map(handle => (
                    <span
                      key={handle}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        background: 'var(--cu-bg-elevated)',
                        padding: '0.25rem 0.5rem',
                        borderRadius: 'var(--cu-radius-sm)',
                        fontSize: '0.875rem',
                      }}
                    >
                      {handle}
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => setSlackHandlesDraft(prev => prev.filter(v => v !== handle))}
                        disabled={busy}
                        style={{ padding: 0 }}
                      >
                        <IconX width={12} height={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    value={newSlackHandle}
                    onChange={e => setNewSlackHandle(e.target.value)}
                    placeholder="Add handle"
                    disabled={busy}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newSlackHandle.trim()) {
                        setSlackHandlesDraft(prev => uniqueTrimmed([...prev, newSlackHandle]))
                        setNewSlackHandle('')
                      }
                    }}
                    style={{
                      width: 'auto',
                      flex: 1,
                      minWidth: '8rem',
                      fontSize: '0.875rem',
                      padding: '0.25rem 0.5rem',
                    }}
                  />
                </div>
              ) : (
                <div className="cu-field__readonly">
                  {slackHandlesDraft.length > 0 ? slackHandlesDraft.join(', ') : 'None'}
                </div>
              )}
            </div>

            <div className="cu-field" style={{ marginBottom: 0 }}>
              <label>Telegram IDs</label>
              {editingContact ? (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.35rem',
                    alignItems: 'center',
                  }}
                >
                  {telegramIdsDraft.map(id => (
                    <span
                      key={id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        background: 'var(--cu-bg-elevated)',
                        padding: '0.25rem 0.5rem',
                        borderRadius: 'var(--cu-radius-sm)',
                        fontSize: '0.875rem',
                      }}
                    >
                      {id}
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => setTelegramIdsDraft(prev => prev.filter(v => v !== id))}
                        disabled={busy}
                        style={{ padding: 0 }}
                      >
                        <IconX width={12} height={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    value={newTelegramId}
                    onChange={e => setNewTelegramId(e.target.value)}
                    placeholder="Add ID"
                    disabled={busy}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newTelegramId.trim()) {
                        setTelegramIdsDraft(prev => uniqueTrimmed([...prev, newTelegramId]))
                        setNewTelegramId('')
                      }
                    }}
                    style={{
                      width: 'auto',
                      flex: 1,
                      minWidth: '8rem',
                      fontSize: '0.875rem',
                      padding: '0.25rem 0.5rem',
                    }}
                  />
                </div>
              ) : (
                <div className="cu-field__readonly">
                  {telegramIdsDraft.length > 0 ? telegramIdsDraft.join(', ') : 'None'}
                </div>
              )}
            </div>
          </div>

          {editingContact && (
            <div className="cu-save-bar">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setEditingContact(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await saveProfile()
                  setEditingContact(false)
                }}
                disabled={busy || !emailDraft.trim()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
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
                Permanently delete this account and personal access mappings. Team memberships are
                removed before the account is deleted.
              </p>
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                style={{ color: 'var(--cu-danger)' }}
                onClick={() => void openDeleteUserConfirm()}
                disabled={busy}
              >
                Delete account…
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === 'approval-dms' && (
        <UserApprovalMediumsPanel
          userId={userId}
          legacySlackHandles={slackHandlesDraft}
          legacyTelegramIds={telegramIdsDraft}
        />
      )}

      {activeTab === 'communication-channels' && (
        <>
          <p className="cu-muted cu-detail-section-copy">
            Conversations this member connected from Profile UI.
          </p>
          {initialLoading ? (
            <div className="cu-empty">Loading communication channels...</div>
          ) : userCommunicationConversations.length === 0 ? (
            <div className="cu-empty">No connected communication channel conversations.</div>
          ) : (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Communication channel</th>
                    <th>Provider</th>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {userCommunicationConversations.map(({ channelName, conversation }) => (
                    <tr key={`${channelName}:${conversation.channelId || conversation.title}`}>
                      <td>
                        {channelName ? (
                          <Link href={CONTROL_ROUTES.externalChannels.edit(channelName)}>
                            {channelName}
                          </Link>
                        ) : (
                          <span className="cu-muted">Unknown</span>
                        )}
                      </td>
                      <td>Telegram</td>
                      <td>{conversation.chatType || 'Unknown'}</td>
                      <td>
                        {conversation.title ||
                          (conversation.handle
                            ? `@${conversation.handle.replace(/^@/, '')}`
                            : 'Unnamed conversation')}
                      </td>
                      <td>{formatCommunicationChannelConfirmedAt(conversation.confirmedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === 'agents' && (
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
              Agents this member may use — and the connectors each one carries.
            </p>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddContext(true)}
              disabled={busy}
            >
              Add agents
            </button>
          </div>
          {initialLoading ? (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Connectors</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3].map(i => (
                    <tr key={i}>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '10rem' }}
                        ></div>
                      </td>
                      <td></td>
                      <td></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : grantedAgentNames.length === 0 ? (
            <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
              No agents assigned yet.
            </div>
          ) : (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Connectors</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {grantedAgentNames.map(agentName => (
                    <tr key={agentName}>
                      <td>
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() => router.push(CONTROL_ROUTES.agents.detail(agentName))}
                        >
                          {agentDisplay(agentName)}
                        </button>
                      </td>
                      <td>
                        <ConnectorCountCell
                          agentKey={`user-access-${agentName}`}
                          contextRef={agentContextRef(agentName)}
                          contextsByRef={contextsByRef}
                          onOpenConnectors={() =>
                            router.push(CONTROL_ROUTES.agents.tab(agentName, 'connectors'))
                          }
                        />
                      </td>
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            gap: '0.35rem',
                            justifyContent: 'flex-end',
                          }}
                        >
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => void removeAccess(agentName)}
                            disabled={busy}
                            title="Remove"
                            aria-label="Remove agent"
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
              Team memberships and roles.
            </p>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddTeam(true)}
              disabled={busy}
            >
              Add to team
            </button>
          </div>
          {initialLoading ? (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Role</th>
                    <th>Can Invite Members</th>
                    <th>Can Delete Members</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3].map(i => (
                    <tr key={i}>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '10rem' }}
                        ></div>
                      </td>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '6rem' }}
                        ></div>
                      </td>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '4rem' }}
                        ></div>
                      </td>
                      <td>
                        <div
                          className="cu-skeleton cu-skeleton--cell"
                          style={{ width: '4rem' }}
                        ></div>
                      </td>
                      <td></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : userTeams.length === 0 ? (
            <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
              Not a member of any team yet.
            </div>
          ) : (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Role</th>
                    <th>Can Invite Members</th>
                    <th>Can Delete Members</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {userTeams.map(team => {
                    const permissions = permissionsForTeamRole(team.role)
                    return (
                      <tr key={team.id}>
                        <td>
                          <button
                            type="button"
                            className="cu-link"
                            onClick={() => router.push(CONTROL_ROUTES.usersAndTeams.team(team.id))}
                          >
                            {team.name}
                          </button>
                        </td>
                        <td>
                          <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.875rem' }}>
                            {formatTeamRole(team.role)}
                          </span>
                        </td>
                        <td className="cu-permission-cell">
                          <input
                            type="checkbox"
                            checked={permissions.canInviteMembers}
                            readOnly
                            disabled
                            aria-label={`${team.name} can invite members`}
                          />
                        </td>
                        <td className="cu-permission-cell">
                          <input
                            type="checkbox"
                            checked={permissions.canDeleteMembers}
                            readOnly
                            disabled
                            aria-label={`${team.name} can delete members`}
                          />
                        </td>
                        <td>
                          <div
                            style={{
                              display: 'flex',
                              gap: '0.35rem',
                              justifyContent: 'flex-end',
                            }}
                          >
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--ghost"
                              onClick={() => {
                                setRoleEditTeam(team)
                                setRoleEditDraft(team.role)
                              }}
                              disabled={busy}
                              aria-label={`Edit permissions for ${team.name}`}
                            >
                              <IconPencil width={14} height={14} />
                            </button>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                              onClick={() => void removeUserFromTeam(team)}
                              disabled={busy}
                              aria-label={`Remove member from ${team.name}`}
                              title="Remove"
                            >
                              <IconX width={16} height={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {roleEditTeam ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !busy) setRoleEditTeam(null)
          }}
        >
          <section
            className="cu-modal-panel cu-modal-panel--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-team-role-edit-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <h3 id="user-team-role-edit-title" className="cu-modal-panel__title">
                Edit team permissions
              </h3>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setRoleEditTeam(null)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-modal-copy">
              {userName || emailDraft || 'Member'} on {roleEditTeam.name}.
            </p>
            <TeamRolePermissionEditor
              idPrefix="user-team-role-edit"
              role={roleEditDraft}
              onChange={setRoleEditDraft}
              disabled={busy}
            />
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setRoleEditTeam(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await updateUserTeamRole(roleEditTeam.id, roleEditDraft)
                  setRoleEditTeam(null)
                }}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showAddContext && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddContext(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-agents-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-agents-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add agents
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddContext(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="member-agent-picker">Agents</label>
              <SelectionDropdown
                id="member-agent-picker"
                inline
                value={selectedAgentNamesToAdd}
                onChange={setSelectedAgentNamesToAdd}
                options={[...hostsByName.keys()]
                  .filter(agentName => !grantedAgentNames.includes(agentName))
                  .sort((a, b) => agentDisplay(a).localeCompare(agentDisplay(b)))
                  .map(agentName => ({ value: agentName, label: agentDisplay(agentName) }))}
                placeholder="Select agents"
                searchPlaceholder="Search agents..."
                selectionLabel="Selected agents"
                emptyLabel="No additional agents available."
                disabled={busy}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddContext(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => {
                  void saveAccess(
                    [...grantedAgentNames, ...selectedAgentNamesToAdd],
                    'Agents updated.'
                  )
                  setShowAddContext(false)
                }}
                disabled={busy || selectedAgentNamesToAdd.length === 0}
              >
                Add agents
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
            background: 'rgba(0, 0, 0, 0.6)',
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
                Add to team
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
              <label htmlFor="member-team-picker">Teams</label>
              <SelectionDropdown
                id="member-team-picker"
                inline
                value={selectedTeamIdsToAdd}
                onChange={setSelectedTeamIdsToAdd}
                options={availableTeamOptions}
                placeholder="Select teams"
                searchPlaceholder="Search teams..."
                selectionLabel="Selected teams"
                emptyLabel="No available teams."
                disabled={busy}
              />
            </div>

            <div className="cu-field">
              <label>Role</label>
              <select
                value={selectedRoleToAdd}
                onChange={e => setSelectedRoleToAdd(e.target.value as TeamRole)}
                disabled={busy}
              >
                <option value="member">{formatTeamRole('member')}</option>
                <option value="inviter">{formatTeamRole('inviter')}</option>
                <option value="admin">{formatTeamRole('admin')}</option>
              </select>
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
                onClick={() => {
                  void addUserToTeams()
                  setShowAddTeam(false)
                }}
                disabled={busy || selectedTeamIdsToAdd.length === 0}
              >
                {selectedTeamIdsToAdd.length > 1 ? 'Add to teams' : 'Add to team'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteUserConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !deletingUserAccount)
              setShowDeleteUserConfirm(false)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="confirm-delete-user"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="confirm-delete-user" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Delete member account permanently?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowDeleteUserConfirm(false)}
                disabled={deletingUserAccount}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              This removes <strong>{userName || emailDraft || userId}</strong> and cannot be undone.
            </p>
            {deleteUserTeamCheckLoading ? (
              <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
                Checking team memberships...
              </p>
            ) : null}
            {deleteUserTeamCheckError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteUserTeamCheckError}
              </div>
            ) : null}
            {!deleteUserTeamCheckLoading && deleteUserSoloTeams.length > 0 ? (
              <div style={{ marginBottom: '1rem' }}>
                <CheckboxField
                  checked={deleteEmptyTeamsWithUser}
                  disabled={deletingUserAccount}
                  label="Delete empty teams too"
                  description={`Also delete ${deleteUserSoloTeams.length === 1 ? 'this team' : 'these teams'} after the account is removed: ${formatTeamNames(deleteUserSoloTeams)}.`}
                  onChange={event => setDeleteEmptyTeamsWithUser(event.currentTarget.checked)}
                />
              </div>
            ) : null}
            {deleteUserDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteUserDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowDeleteUserConfirm(false)}
                disabled={deletingUserAccount}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                style={{ background: 'var(--cu-danger)', borderColor: 'var(--cu-danger)' }}
                onClick={() => void deleteUserPermanently()}
                disabled={deletingUserAccount || deleteUserTeamCheckLoading}
              >
                {deletingUserAccount ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </DetailPageShell>
  )
}
