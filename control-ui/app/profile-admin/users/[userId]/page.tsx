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
import { partitionVisibleAccess } from '@lib/accessVisibility'
import { getAgentDisplayName } from '@lib/agentName'
import type { DeleteCandidateTeam } from '@lib/profileAdminDelete'
import { formatTeamNames, getSoloMemberTeamsForUser } from '@lib/profileAdminDelete'
import { IconUsers } from '../../../../components/Sidebar/icons'
import { UserApprovalMediumsPanel } from '../../../../components/UserApprovalMediumsPanel'
import { IconPencil, IconX } from '../../../../components/icons'
import {
  AdminUserChannels,
  HostResource,
  addAdminTeamMember,
  apiGet,
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

type UserTab =
  | 'contact'
  | 'approval-dms'
  | 'communication-channels'
  | 'contexts'
  | 'teams'
  | 'agents'
const USER_TABS: UserTab[] = [
  'contact',
  'approval-dms',
  'communication-channels',
  'contexts',
  'teams',
  'agents',
]

const USER_TAB_LABELS: Record<UserTab, string> = {
  contact: 'Contact',
  'approval-dms': 'Approval DMs',
  'communication-channels': 'Communication Channels',
  contexts: 'Contexts',
  teams: 'Teams',
  agents: 'Agents',
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

  const [activeTab, setActiveTab] = useState<UserTab>(() => parseUserTab(params.tab))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)
  const [editingContact, setEditingContact] = useState(false)
  const [showAddContext, setShowAddContext] = useState(false)
  const [showAddAgent, setShowAddAgent] = useState(false)
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

  const [availableContextIds, setAvailableContextIds] = useState<string[]>([])
  const [assignedContextIds, setAssignedContextIds] = useState<string[]>([])
  const [deletedContextIds, setDeletedContextIds] = useState<string[]>([])
  const [selectedContextIdsToAdd, setSelectedContextIdsToAdd] = useState<string[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [assignedAgentNames, setAssignedAgentNames] = useState<string[]>([])
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
  const hostNameOptions = useMemo(
    () =>
      Array.from(
        new Set((hosts || []).map(host => String(host.metadata?.name || '').trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [hosts]
  )
  const availableContextOptions = useMemo(
    () =>
      availableContextIds
        .filter(contextId => !assignedContextIds.includes(contextId))
        .map(contextId => ({ value: contextId, label: contextId })),
    [assignedContextIds, availableContextIds]
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
          label: getAgentDisplayName(agentName),
          description: agentName,
        })),
    [assignedAgentNames, hostNameOptions]
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
    const base = `/profile-admin/users/${encodeURIComponent(userId)}`
    return tab === 'contact' ? base : `${base}/${tab}`
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
        hostNames
      )
      setAssignedContextIds(contextPartition.active)
      setDeletedContextIds(contextPartition.deleted)
      setAllTeams(Array.isArray(teamsData.items) ? teamsData.items : [])
      setUserTeams(Array.isArray(userTeamsData.items) ? userTeamsData.items : [])
      setHosts(Array.isArray(hostsData.items) ? hostsData.items : [])
      setAssignedAgentNames(agentPartition.active)
      setCommunicationChannels(communicationChannelsData.items || [])
      setAvailableContextIds(ids)
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

  async function saveContexts(next: string[], message: string) {
    setBusy(true)
    setError('')
    try {
      const normalized = Array.from(new Set(next.map(v => v.trim()).filter(Boolean)))
      const updated = await updateAdminUserContexts(userId, normalized)
      const partition = partitionVisibleAccess(
        updated.contextIds || [],
        availableContextIds,
        updated.deletedContextIds || []
      )
      setAssignedContextIds(partition.active)
      setDeletedContextIds(partition.deleted)
      setSelectedContextIdsToAdd([])
      showToast(message, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update member context access')
    } finally {
      setBusy(false)
    }
  }

  async function removeContextAccess(contextId: string) {
    const shouldRemove = await confirm({
      title: 'Remove Context Access',
      message: `Remove ${userName || emailDraft || 'this member'}'s access to ${contextId}?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!shouldRemove) return

    await saveContexts(
      assignedContextIds.filter(id => id !== contextId),
      'Context access updated.'
    )
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

  async function saveAgents(next: string[], message: string) {
    setBusy(true)
    setError('')
    try {
      const normalized = Array.from(new Set(next.map(v => v.trim()).filter(Boolean)))
      const updated = await updateAdminUserAgents(userId, normalized)
      const partition = partitionVisibleAccess(updated.agentNames || [], hostNameOptions)
      setAssignedAgentNames(partition.active)
      setSelectedAgentNamesToAdd([])
      showToast(message, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update member agent access')
    } finally {
      setBusy(false)
    }
  }

  async function revokeAgentAccess(agentName: string) {
    const shouldRevoke = await confirm({
      title: 'Revoke Agent Access',
      message: `Revoke ${userName || emailDraft || 'this member'}'s access to ${agentName}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    await saveAgents(
      assignedAgentNames.filter(name => name !== agentName),
      'Agent access updated.'
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
      await deleteAdminUser(userId)
      const teamDeleteResults = await Promise.allSettled(
        teamsToDelete.map(team => deleteAdminTeam(team.id))
      )
      const failedTeams = teamsToDelete.filter((_, index) => {
        const result = teamDeleteResults[index]
        return result?.status === 'rejected'
      })
      setShowDeleteUserConfirm(false)
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
      router.push('/profile-admin/users')
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
      onBack={() => router.push('/profile-admin/users')}
      onTabChange={selectTab}
      subtitle={
        initialLoading
          ? 'Loading member details...'
          : 'Channels, approval DMs, context access, teams, and agents.'
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
                          <Link href={`/communication-channels/${encodeURIComponent(channelName)}`}>
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

      {activeTab === 'contexts' && (
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
              Contexts this member may access.
            </p>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddContext(true)}
              disabled={busy}
            >
              Add context
            </button>
          </div>
          {initialLoading ? (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Context</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : assignedContextIds.length === 0 ? (
            <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
              No contexts assigned.
            </div>
          ) : (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Context</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {assignedContextIds.map(contextId => (
                    <tr key={contextId}>
                      <td>
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() => router.push(`/contexts/${encodeURIComponent(contextId)}`)}
                        >
                          {contextId}
                        </button>
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
                            onClick={() => void removeContextAccess(contextId)}
                            disabled={busy}
                            title="Remove"
                            aria-label="Remove context"
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
          {!initialLoading && deletedContextIds.length > 0 && (
            <>
              <p className="cu-muted cu-deleted-access-heading">Deleted contexts</p>
              <div className="cu-table-wrap">
                <table className="cu-table">
                  <tbody>
                    {deletedContextIds.map(contextId => (
                      <tr key={contextId}>
                        <td>{contextId}</td>
                        <td className="cu-muted">Deleted</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
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
                            onClick={() =>
                              router.push(`/profile-admin/teams/${encodeURIComponent(team.id)}`)
                            }
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
              Agents this member may use.
            </p>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddAgent(true)}
              disabled={busy}
            >
              Grant agent
            </button>
          </div>
          {initialLoading ? (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Agent</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : assignedAgentNames.length === 0 ? (
            <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
              No agent access yet.
            </div>
          ) : (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {assignedAgentNames.map(agentName => (
                    <tr key={agentName}>
                      <td>
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() => router.push(`/hosts/${encodeURIComponent(agentName)}`)}
                        >
                          {agentName}
                        </button>
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
                            onClick={() => void revokeAgentAccess(agentName)}
                            disabled={busy}
                            title="Revoke"
                            aria-label="Revoke agent"
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
            aria-labelledby="add-context-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-context-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add context
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
              <label htmlFor="member-context-picker">Contexts</label>
              <SelectionDropdown
                id="member-context-picker"
                inline
                value={selectedContextIdsToAdd}
                onChange={setSelectedContextIdsToAdd}
                options={availableContextOptions}
                placeholder="Select contexts"
                searchPlaceholder="Search contexts..."
                selectionLabel="Selected contexts"
                emptyLabel="No available contexts."
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
                  void saveContexts(
                    [...assignedContextIds, ...selectedContextIdsToAdd],
                    selectedContextIdsToAdd.length === 1
                      ? 'Context access updated.'
                      : 'Contexts access updated.'
                  )
                  setShowAddContext(false)
                }}
                disabled={busy || selectedContextIdsToAdd.length === 0}
              >
                {selectedContextIdsToAdd.length > 1 ? 'Add contexts' : 'Add context'}
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

      {showAddAgent && (
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
            if (e.target === e.currentTarget && !busy) setShowAddAgent(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-agent-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-agent-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Grant agent
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddAgent(false)}
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
                options={availableAgentOptions}
                placeholder="Select agents"
                searchPlaceholder="Search agents..."
                selectionLabel="Selected agents"
                emptyLabel="No available agents."
                disabled={busy}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddAgent(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => {
                  void saveAgents(
                    [...assignedAgentNames, ...selectedAgentNamesToAdd],
                    selectedAgentNamesToAdd.length === 1
                      ? 'Agent access updated.'
                      : 'Agents access updated.'
                  )
                  setShowAddAgent(false)
                }}
                disabled={busy || selectedAgentNamesToAdd.length === 0}
              >
                {selectedAgentNamesToAdd.length > 1 ? 'Grant agents' : 'Grant agent'}
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
