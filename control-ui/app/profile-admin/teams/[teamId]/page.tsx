'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DetailPageShell } from '@components/DetailPageShell'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TabBar } from '@components/TabBar'
import { TeamRolePermissionEditor } from '@components/TeamRolePermissionEditor'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { partitionVisibleAccess } from '@lib/accessVisibility'
import { getAgentDisplayName } from '@lib/agentName'
import { InviteMemberDialog } from '../../../../components/InviteMemberDialog'
import { IconUsers } from '../../../../components/Sidebar/icons'
import { IconCheck, IconMoreHorizontal, IconPencil, IconX } from '../../../../components/icons'
import {
  AdminTeamPendingInvitation,
  HostResource,
  TeamMember,
  addAdminTeamMember,
  createAdminTeam,
  deleteAdminMember,
  deleteAdminTeam,
  getAdminTeam,
  getAdminTeamAgents,
  getAdminTeamContexts,
  getAdminTeamMembers,
  getAdminTeamPendingInvitations,
  getAdminUsers,
  getContexts,
  getHosts,
  inviteAdminTeamMember,
  renameAdminTeam,
  resendAdminTeamInvitation,
  revokeAdminTeamInvitation,
  updateAdminMemberRole,
  updateAdminTeamAgents,
  updateAdminTeamContexts,
} from '../../../../lib/api'
import { formatTeamRole, permissionsForTeamRole } from '../../../../lib/teamRoles'

type Role = 'admin' | 'inviter' | 'member'

type TeamTab = 'members' | 'contexts' | 'agents'
const TEAM_TABS: TeamTab[] = ['members', 'contexts', 'agents']

const TEAM_TAB_LABELS: Record<TeamTab, string> = {
  members: 'Members',
  contexts: 'Contexts',
  agents: 'Agents',
}

function parseTeamTab(value: string | undefined): TeamTab {
  return TEAM_TABS.includes(value as TeamTab) ? (value as TeamTab) : 'members'
}

function TeamActionsMenu({
  busy,
  onRename,
  onDelete,
}: {
  busy: boolean
  onRename: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label="Team actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        onClick={() => setOpen(value => !value)}
        disabled={busy}
      >
        <IconMoreHorizontal width={16} height={16} />
      </button>
      {open ? (
        <div role="menu" className="cu-kebab__menu">
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item"
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          >
            Rename team
          </button>
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item cu-kebab__item--danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default function TeamDetailsPage() {
  const params = useParams<{ teamId: string; tab?: string }>()
  const router = useRouter()
  const { showToast } = useToast()
  const teamId = decodeURIComponent(params.teamId || '')
  const isNew = teamId === 'new'
  const { confirm, confirmDialog } = useConfirmDialog()

  const [activeTab, setActiveTab] = useState<TeamTab>(() => parseTeamTab(params.tab))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)

  const [showDeleteTeamConfirm, setShowDeleteTeamConfirm] = useState(false)
  const [deletingTeam, setDeletingTeam] = useState(false)
  const [deleteTeamDialogError, setDeleteTeamDialogError] = useState('')

  const [teamName, setTeamName] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameBuffer, setNameBuffer] = useState('')
  const [members, setMembers] = useState<TeamMember[]>([])
  const [pendingInvitations, setPendingInvitations] = useState<AdminTeamPendingInvitation[]>([])
  const [resendingInvitationId, setResendingInvitationId] = useState<string | null>(null)
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null)
  const [users, setUsers] = useState<
    Array<{
      id: string
      email: string
      name: string | null
      activeTeamCount: number
      displayName: string | null
    }>
  >([])
  const [memberRoleDrafts, setMemberRoleDrafts] = useState<Record<string, Role>>({})
  const [roleEditMember, setRoleEditMember] = useState<TeamMember | null>(null)
  const [roleEditDraft, setRoleEditDraft] = useState<Role>('member')

  const [showAddMember, setShowAddMember] = useState(false)
  const [addMemberMode, setAddMemberMode] = useState<'existing' | 'invite'>('existing')
  const [selectedUserIdsToAdd, setSelectedUserIdsToAdd] = useState<string[]>([])
  const [selectedRoleToAdd, setSelectedRoleToAdd] = useState<Role>('member')
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'inviter' | 'member'>('member')
  const [addingMember, setAddingMember] = useState(false)
  const [addMemberError, setAddMemberError] = useState('')

  const [showAddContext, setShowAddContext] = useState(false)
  const [showAddAgent, setShowAddAgent] = useState(false)

  const [availableContextIds, setAvailableContextIds] = useState<string[]>([])
  const [assignedContextIds, setAssignedContextIds] = useState<string[]>([])
  const [deletedContextIds, setDeletedContextIds] = useState<string[]>([])
  const [selectedContextIdsToAdd, setSelectedContextIdsToAdd] = useState<string[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [assignedAgentNames, setAssignedAgentNames] = useState<string[]>([])
  const [observedAgentNames, setObservedAgentNames] = useState<string[]>([])
  const [selectedAgentNamesToAdd, setSelectedAgentNamesToAdd] = useState<string[]>([])

  const existingMemberIds = useMemo(() => new Set(members.map(m => m.id)), [members])
  const hostNameOptions = useMemo(
    () =>
      Array.from(
        new Set((hosts || []).map(host => String(host.metadata?.name || '').trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [hosts]
  )

  function contextIdFromResource(item: {
    metadata?: { name?: string }
    spec?: { contextId?: string }
  }) {
    return String(item.spec?.contextId || item.metadata?.name || '').trim()
  }

  async function loadTeamData(
    resolvedTeamId: string,
    visibleContextIds = availableContextIds,
    visibleAgentNames = hostNameOptions
  ) {
    const [team, teamMembers, teamContexts, teamAgents, pendingInv] = await Promise.all([
      getAdminTeam(resolvedTeamId),
      getAdminTeamMembers(resolvedTeamId),
      getAdminTeamContexts(resolvedTeamId),
      getAdminTeamAgents(resolvedTeamId),
      getAdminTeamPendingInvitations(resolvedTeamId),
    ])
    setTeamName(team.name || '')
    const nextMembers = Array.isArray(teamMembers.items) ? teamMembers.items : []
    setMembers(nextMembers)
    setPendingInvitations(
      Array.isArray(pendingInv.items) ? (pendingInv.items as AdminTeamPendingInvitation[]) : []
    )
    setMemberRoleDrafts(
      nextMembers.reduce(
        (acc, member) => ({ ...acc, [member.id]: member.role }),
        {} as Record<string, Role>
      )
    )
    const contextPartition = partitionVisibleAccess(
      Array.isArray(teamContexts.contextIds) ? teamContexts.contextIds : [],
      visibleContextIds,
      Array.isArray(teamContexts.deletedContextIds) ? teamContexts.deletedContextIds : []
    )
    const agentPartition = partitionVisibleAccess(
      Array.isArray(teamAgents.agentNames) ? teamAgents.agentNames : [],
      visibleAgentNames,
      Array.isArray(teamAgents.deletedAgentNames) ? teamAgents.deletedAgentNames : []
    )
    setAssignedContextIds(contextPartition.active)
    setDeletedContextIds(contextPartition.deleted)
    setAssignedAgentNames(agentPartition.active)
    setObservedAgentNames([
      ...(teamAgents.agentNames || []),
      ...(teamAgents.deletedAgentNames || []),
    ])
  }

  useEffect(() => {
    async function loadReferenceData() {
      setBusy(true)
      setInitialLoading(true)
      setError('')
      try {
        const [usersData, contextsData, hostsData] = await Promise.all([
          getAdminUsers(''),
          getContexts(),
          getHosts(),
        ])
        setUsers(Array.isArray(usersData.items) ? usersData.items : [])
        setHosts(Array.isArray(hostsData.items) ? hostsData.items : [])
        const ids = (contextsData.items || [])
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
        setAvailableContextIds(ids)
        if (!isNew) {
          await loadTeamData(teamId, ids, hostNames)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load team data')
      } finally {
        setBusy(false)
        setInitialLoading(false)
      }
    }
    void loadReferenceData()
  }, [isNew, teamId])

  async function createTeamFlow() {
    if (!teamName.trim()) {
      setError('Team name is required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = await createAdminTeam(teamName.trim())
      showToast('Team created.', { tone: 'success' })
      router.replace(CONTROL_ROUTES.usersAndTeams.team(created.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create team')
    } finally {
      setBusy(false)
    }
  }

  function startEditingName() {
    setNameBuffer(teamName)
    setEditingName(true)
  }

  async function saveTeamName() {
    const trimmed = nameBuffer.trim()
    if (!trimmed || isNew) return
    setBusy(true)
    setError('')
    try {
      await renameAdminTeam(teamId, trimmed)
      setTeamName(trimmed)
      setEditingName(false)
      showToast('Team renamed.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename team')
    } finally {
      setBusy(false)
    }
  }

  async function addMember() {
    if (isNew || selectedUserIdsToAdd.length === 0) return
    setAddingMember(true)
    setAddMemberError('')
    try {
      await Promise.all(
        selectedUserIdsToAdd.map(userId => addAdminTeamMember(teamId, userId, selectedRoleToAdd))
      )
      await loadTeamData(teamId)
      const addedUserIds = selectedUserIdsToAdd
      const addedUser = users.find(u => u.id === addedUserIds[0])
      setSelectedUserIdsToAdd([])
      setShowAddMember(false)
      showToast(
        addedUserIds.length === 1
          ? `${addedUser?.displayName || addedUser?.name || addedUserIds[0]} added to team as ${formatTeamRole(selectedRoleToAdd)}.`
          : `${addedUserIds.length} members added to team as ${formatTeamRole(selectedRoleToAdd)}.`,
        { tone: 'success' }
      )
    } catch (e) {
      setAddMemberError(e instanceof Error ? e.message : 'Failed to add member to team')
    } finally {
      setAddingMember(false)
    }
  }

  async function inviteMember() {
    if (isNew || !inviteName.trim() || !inviteEmail.trim()) return
    setAddingMember(true)
    setAddMemberError('')
    try {
      await inviteAdminTeamMember(teamId, {
        name: inviteName.trim(),
        email: inviteEmail.trim().toLowerCase(),
        role: inviteRole,
      })
      const email = inviteEmail.trim().toLowerCase()
      setInviteName('')
      setInviteEmail('')
      setInviteRole('member')
      setShowAddMember(false)
      await loadTeamData(teamId)
      showToast(`Invitation sent to ${email} as ${formatTeamRole(inviteRole)}.`, {
        tone: 'success',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to create invitation'
      setAddMemberError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setAddingMember(false)
    }
  }

  async function resendPendingInvitation(inv: AdminTeamPendingInvitation) {
    if (isNew) return
    setResendingInvitationId(inv.id)
    setError('')
    try {
      await resendAdminTeamInvitation(teamId, inv.id)
      showToast(`Invitation email sent to ${inv.email}.`, { tone: 'success' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to resend invitation email'
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setResendingInvitationId(null)
    }
  }

  async function cancelPendingInvitation(inv: AdminTeamPendingInvitation) {
    if (isNew) return
    const shouldCancel = await confirm({
      title: 'Cancel Invitation',
      message: `Cancel invitation to ${inv.email}? The link in their email will stop working.`,
      confirmLabel: 'Cancel invitation',
      tone: 'danger',
    })
    if (!shouldCancel) return

    setRevokingInvitationId(inv.id)
    setError('')
    try {
      await revokeAdminTeamInvitation(teamId, inv.id)
      await loadTeamData(teamId)
      showToast(`Invitation cancelled for ${inv.email}.`, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to cancel invitation')
    } finally {
      setRevokingInvitationId(null)
    }
  }

  async function updateRole(memberId: string, nextRole?: Role) {
    if (isNew) return
    const role = nextRole || memberRoleDrafts[memberId]
    if (!role) return
    setBusy(true)
    setError('')
    try {
      await updateAdminMemberRole(teamId, memberId, role)
      const member = members.find(m => m.id === memberId)
      const previousRole = member?.role
      await loadTeamData(teamId)
      showToast(
        `${member?.name || member?.email || 'Member'} role changed from ${formatTeamRole(previousRole)} to ${formatTeamRole(role)}.`,
        { tone: 'success' }
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update member role')
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(memberId: string) {
    if (isNew) return
    const member = members.find(m => m.id === memberId)
    const shouldRemove = await confirm({
      title: 'Remove member?',
      message: `Remove ${member?.name || member?.email || 'this member'} from ${teamName || 'this team'}?`,
      confirmLabel: 'Remove member',
      tone: 'danger',
    })
    if (!shouldRemove) return
    setBusy(true)
    setError('')
    try {
      await deleteAdminMember(teamId, memberId)
      await loadTeamData(teamId)
      showToast(`${member?.name || member?.email || 'Member'} removed from the team.`, {
        tone: 'success',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member')
    } finally {
      setBusy(false)
    }
  }

  async function saveContexts(next: string[], message: string) {
    if (isNew) return
    setBusy(true)
    setError('')
    try {
      const normalized = Array.from(new Set(next.map(v => v.trim()).filter(Boolean)))
      const updated = await updateAdminTeamContexts(teamId, normalized)
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
      setError(e instanceof Error ? e.message : 'Failed to update team contexts')
    } finally {
      setBusy(false)
    }
  }

  async function removeContextAccess(contextId: string) {
    const shouldRemove = await confirm({
      title: 'Remove Context Access',
      message: `Remove ${teamName || 'this team'}'s access to ${contextId}?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!shouldRemove) return

    await saveContexts(
      assignedContextIds.filter(id => id !== contextId),
      'Team contexts updated.'
    )
  }

  async function saveAgents(next: string[], message: string) {
    if (isNew) return
    setBusy(true)
    setError('')
    try {
      const normalized = Array.from(new Set(next.map(v => v.trim()).filter(Boolean)))
      const updated = await updateAdminTeamAgents(teamId, normalized, observedAgentNames)
      const partition = partitionVisibleAccess(
        updated.agentNames || [],
        hostNameOptions,
        updated.deletedAgentNames || []
      )
      setAssignedAgentNames(partition.active)
      setObservedAgentNames([...(updated.agentNames || []), ...(updated.deletedAgentNames || [])])
      setSelectedAgentNamesToAdd([])
      showToast(message, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update team agents')
    } finally {
      setBusy(false)
    }
  }

  async function revokeAgentAccess(agentName: string) {
    const shouldRevoke = await confirm({
      title: 'Revoke Agent Access',
      message: `Revoke ${teamName || 'this team'}'s access to ${agentName}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    await saveAgents(
      assignedAgentNames.filter(name => name !== agentName),
      'Team agent access updated.'
    )
  }

  async function deleteTeamPermanently() {
    if (isNew) return
    setDeletingTeam(true)
    setDeleteTeamDialogError('')
    setError('')
    try {
      await deleteAdminTeam(teamId)
      setShowDeleteTeamConfirm(false)
      showToast('Team deleted.', { tone: 'success' })
      router.push(CONTROL_ROUTES.usersAndTeams.teams)
    } catch (e) {
      setDeleteTeamDialogError(e instanceof Error ? e.message : 'Failed to delete team')
    } finally {
      setDeletingTeam(false)
    }
  }

  const availableMemberOptions = useMemo(
    () =>
      users
        .filter(user => !existingMemberIds.has(user.id))
        .map(user => ({
          value: user.id,
          label: user.displayName || user.name || user.email || user.id,
          description: user.email || user.id,
          badge: user.activeTeamCount === 1 ? '1 team' : `${user.activeTeamCount} teams`,
        })),
    [existingMemberIds, users]
  )
  const availableContextOptions = useMemo(
    () =>
      availableContextIds
        .filter(contextId => !assignedContextIds.includes(contextId))
        .map(contextId => ({ value: contextId, label: contextId })),
    [assignedContextIds, availableContextIds]
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

  useEffect(() => {
    setActiveTab(parseTeamTab(params.tab))
  }, [params.tab])

  function teamTabHref(tab: TeamTab): string {
    return CONTROL_ROUTES.usersAndTeams.teamTab(teamId, tab)
  }

  function selectTab(tab: TeamTab) {
    setActiveTab(tab)
    router.replace(teamTabHref(tab))
  }

  return (
    <DetailPageShell<TeamTab>
      activeTab={activeTab}
      actions={
        isNew ? null : editingName ? (
          <div className="cu-inline-edit cu-inline-edit--header">
            <input
              className="cu-inline-edit__input"
              value={nameBuffer}
              onChange={e => setNameBuffer(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void saveTeamName()
                if (e.key === 'Escape') setEditingName(false)
              }}
              disabled={busy}
              aria-label="Team name"
              autoFocus
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar cu-inline-edit__save"
              onClick={() => void saveTeamName()}
              disabled={busy || !nameBuffer.trim()}
              aria-label="Save name"
            >
              <IconCheck width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--ghost"
              onClick={() => setEditingName(false)}
              disabled={busy}
              aria-label="Cancel editing"
            >
              <IconX width={16} height={16} />
            </button>
          </div>
        ) : (
          <TeamActionsMenu
            busy={busy}
            onRename={startEditingName}
            onDelete={() => {
              setDeleteTeamDialogError('')
              setShowDeleteTeamConfirm(true)
            }}
          />
        )
      }
      backLabel="Back to teams"
      error={error}
      icon={<IconUsers />}
      onBack={() => router.push(CONTROL_ROUTES.usersAndTeams.teams)}
      onTabChange={selectTab}
      subtitle={
        isNew
          ? 'Name the new team.'
          : initialLoading
            ? 'Loading team details...'
            : 'Members, contexts, and agent access.'
      }
      tabAriaLabel="Team sections"
      tabs={
        isNew
          ? undefined
          : TEAM_TABS.map(tab => ({
              value: tab,
              label: TEAM_TAB_LABELS[tab],
              href: teamTabHref(tab),
            }))
      }
      title={isNew ? 'Create team' : initialLoading && !teamName ? 'Team' : teamName || teamId}
    >
      {isNew ? (
        <div className="cu-card">
          <div className="cu-card__body">
            <div className="cu-form-stack">
              <div className="cu-field">
                <label htmlFor="new-team-name">Team name</label>
                <input
                  id="new-team-name"
                  value={teamName}
                  onChange={e => setTeamName(e.target.value)}
                  placeholder="Team name"
                  disabled={busy}
                />
              </div>
            </div>
            <div className="cu-save-bar">
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => void createTeamFlow()}
                disabled={busy || !teamName.trim()}
              >
                {busy ? 'Creating…' : 'Create team'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="cu-card">
            <div className="cu-card__body">
              {activeTab === 'members' && (
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
                      Team members and their roles.
                    </p>
                    <button
                      type="button"
                      className="cu-btn cu-btn--primary cu-btn--sm"
                      onClick={() => {
                        setShowAddMember(true)
                        setAddMemberError('')
                      }}
                      disabled={busy}
                    >
                      Add member
                    </button>
                  </div>
                  {initialLoading ? (
                    <div className="cu-table-wrap">
                      <table className="cu-table">
                        <thead>
                          <tr>
                            <th>Member</th>
                            <th>Email</th>
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
                                  style={{ width: '8rem' }}
                                ></div>
                              </td>
                              <td>
                                <div
                                  className="cu-skeleton cu-skeleton--cell"
                                  style={{ width: '12rem' }}
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
                  ) : (
                    <>
                      {pendingInvitations.length > 0 && (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <p
                            className="cu-muted"
                            style={{
                              fontSize: '0.8125rem',
                              fontWeight: 600,
                              margin: '0 0 0.5rem',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            Pending invitations
                          </p>
                          <div className="cu-table-wrap">
                            <table className="cu-table">
                              <thead>
                                <tr>
                                  <th>Email</th>
                                  <th>Role</th>
                                  <th>Invited</th>
                                  <th></th>
                                </tr>
                              </thead>
                              <tbody>
                                {pendingInvitations.map(inv => (
                                  <tr key={inv.id}>
                                    <td>{inv.email}</td>
                                    <td>{formatTeamRole(inv.role)}</td>
                                    <td
                                      style={{
                                        color: 'var(--cu-text-muted)',
                                        fontSize: '0.875rem',
                                      }}
                                    >
                                      {new Date(inv.created_at).toLocaleString()}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      <div
                                        style={{
                                          display: 'flex',
                                          gap: '0.35rem',
                                          justifyContent: 'flex-end',
                                          flexWrap: 'wrap',
                                        }}
                                      >
                                        <button
                                          type="button"
                                          className="cu-btn cu-btn--sm"
                                          onClick={() => void resendPendingInvitation(inv)}
                                          disabled={
                                            busy ||
                                            resendingInvitationId === inv.id ||
                                            revokingInvitationId === inv.id
                                          }
                                        >
                                          {resendingInvitationId === inv.id
                                            ? 'Sending…'
                                            : 'Resend email'}
                                        </button>
                                        <button
                                          type="button"
                                          className="cu-btn cu-btn--ghost cu-btn--sm"
                                          style={{ color: 'var(--cu-danger)' }}
                                          onClick={() => void cancelPendingInvitation(inv)}
                                          disabled={
                                            busy ||
                                            resendingInvitationId === inv.id ||
                                            revokingInvitationId === inv.id
                                          }
                                        >
                                          {revokingInvitationId === inv.id
                                            ? 'Cancelling…'
                                            : 'Cancel'}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {members.length === 0 ? (
                        <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
                          {pendingInvitations.length > 0
                            ? 'No active members yet.'
                            : 'No members yet.'}
                        </div>
                      ) : (
                        <div className="cu-table-wrap">
                          <table className="cu-table">
                            <thead>
                              <tr>
                                <th>Member</th>
                                <th>Email</th>
                                <th>Role</th>
                                <th>Can Invite Members</th>
                                <th>Can Delete Members</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {members.map(member => {
                                const permissions = permissionsForTeamRole(member.role)
                                return (
                                  <tr key={member.id}>
                                    <td>
                                      <button
                                        type="button"
                                        className="cu-link"
                                        onClick={() =>
                                          router.push(CONTROL_ROUTES.usersAndTeams.user(member.id))
                                        }
                                      >
                                        {member.name || '-'}
                                      </button>
                                    </td>
                                    <td>{member.email}</td>
                                    <td>
                                      <span style={{ color: 'var(--cu-text-muted)' }}>
                                        {formatTeamRole(member.role)}
                                      </span>
                                    </td>
                                    <td className="cu-permission-cell">
                                      <input
                                        type="checkbox"
                                        checked={permissions.canInviteMembers}
                                        readOnly
                                        disabled
                                        aria-label={`${member.email} can invite members`}
                                      />
                                    </td>
                                    <td className="cu-permission-cell">
                                      <input
                                        type="checkbox"
                                        checked={permissions.canDeleteMembers}
                                        readOnly
                                        disabled
                                        aria-label={`${member.email} can delete members`}
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
                                            setRoleEditMember(member)
                                            setRoleEditDraft(member.role)
                                          }}
                                          disabled={busy}
                                          aria-label="Edit role"
                                        >
                                          <IconPencil width={14} height={14} />
                                        </button>
                                        <button
                                          type="button"
                                          className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                          onClick={() => void removeMember(member.id)}
                                          disabled={busy}
                                          title="Remove"
                                          aria-label="Remove member"
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
                      Contexts this team may access.
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
                    <div role="list">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="cu-skeleton--row">
                          <div
                            className="cu-skeleton cu-skeleton--cell"
                            style={{ width: '12rem' }}
                          ></div>
                          <div
                            className="cu-skeleton cu-skeleton--cell"
                            style={{ width: '4rem' }}
                          ></div>
                        </div>
                      ))}
                    </div>
                  ) : assignedContextIds.length === 0 ? (
                    <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
                      No contexts linked.
                    </div>
                  ) : (
                    <div role="list">
                      {assignedContextIds.map(contextId => (
                        <div key={contextId} className="cu-access-row" role="listitem">
                          <button
                            type="button"
                            className="cu-link"
                            onClick={() => router.push(CONTROL_ROUTES.contexts.detail(contextId))}
                          >
                            {contextId}
                          </button>
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
                      ))}
                    </div>
                  )}
                  {!initialLoading && deletedContextIds.length > 0 && (
                    <>
                      <p className="cu-muted cu-deleted-access-heading">Deleted contexts</p>
                      <div role="list">
                        {deletedContextIds.map(contextId => (
                          <div key={contextId} className="cu-access-row" role="listitem">
                            <span>{contextId}</span>
                            <span className="cu-muted">Deleted</span>
                          </div>
                        ))}
                      </div>
                    </>
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
                      Agents this team may use.
                    </p>
                    <button
                      type="button"
                      className="cu-btn cu-btn--primary cu-btn--sm"
                      onClick={() => setShowAddAgent(true)}
                      disabled={busy}
                    >
                      Add agent
                    </button>
                  </div>
                  {initialLoading ? (
                    <div role="list">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="cu-skeleton--row">
                          <div
                            className="cu-skeleton cu-skeleton--cell"
                            style={{ width: '10rem' }}
                          ></div>
                          <div
                            className="cu-skeleton cu-skeleton--cell"
                            style={{ width: '4rem' }}
                          ></div>
                        </div>
                      ))}
                    </div>
                  ) : assignedAgentNames.length === 0 ? (
                    <div className="cu-empty" style={{ padding: '0.5rem 0' }}>
                      No agent access yet.
                    </div>
                  ) : (
                    <div role="list">
                      {assignedAgentNames.map(agentName => (
                        <div key={agentName} className="cu-access-row" role="listitem">
                          <button
                            type="button"
                            className="cu-link"
                            onClick={() => router.push(CONTROL_ROUTES.agents.detail(agentName))}
                          >
                            {agentName}
                          </button>
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
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {roleEditMember ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !busy) setRoleEditMember(null)
          }}
        >
          <section
            className="cu-modal-panel cu-modal-panel--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-member-role-edit-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <h3 id="team-member-role-edit-title" className="cu-modal-panel__title">
                Edit member permissions
              </h3>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setRoleEditMember(null)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-modal-copy">
              {roleEditMember.name || roleEditMember.email} on {teamName || 'this team'}.
            </p>
            <TeamRolePermissionEditor
              idPrefix="team-member-role-edit"
              role={roleEditDraft}
              onChange={setRoleEditDraft}
              disabled={busy}
            />
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setRoleEditMember(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await updateRole(roleEditMember.id, roleEditDraft)
                  setRoleEditMember(null)
                }}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showAddMember && (
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
            if (e.target === e.currentTarget && !addingMember) setShowAddMember(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-member-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-member-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add member
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddMember(false)}
                disabled={addingMember}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <TabBar<'existing' | 'invite'>
              ariaLabel="Member creation mode"
              activeValue={addMemberMode}
              className="cu-tabs--flush"
              onChange={setAddMemberMode}
              options={[
                {
                  value: 'existing',
                  label: 'Existing member',
                  disabled: addingMember,
                },
                {
                  value: 'invite',
                  label: 'Invite by email',
                  disabled: addingMember,
                },
              ]}
            />

            {addMemberMode === 'existing' ? (
              <>
                <div className="cu-field" style={{ marginBottom: 0 }}>
                  <label htmlFor="team-member-picker">Members</label>
                  <SelectionDropdown
                    id="team-member-picker"
                    inline
                    value={selectedUserIdsToAdd}
                    onChange={setSelectedUserIdsToAdd}
                    options={availableMemberOptions}
                    placeholder="Select members"
                    searchPlaceholder="Search members..."
                    selectionLabel="Selected members"
                    emptyLabel="No available members."
                    disabled={addingMember}
                  />
                </div>
                <div className="cu-field" style={{ marginBottom: 0 }}>
                  <label>Role</label>
                  <select
                    value={selectedRoleToAdd}
                    onChange={e => setSelectedRoleToAdd(e.target.value as Role)}
                    disabled={addingMember}
                  >
                    <option value="member">Participant</option>
                    <option value="inviter">Inviter</option>
                    <option value="admin">Leader</option>
                  </select>
                </div>
              </>
            ) : (
              <InviteMemberDialog
                isOpen
                embedded
                busy={addingMember}
                error={addMemberError}
                name={inviteName}
                email={inviteEmail}
                role={inviteRole}
                teamId={teamId}
                teams={[{ id: teamId, name: teamName || teamId }]}
                lockedTeamId={teamId}
                title="Invite member by email"
                submitLabel="Send invite"
                onClose={() => {
                  setShowAddMember(false)
                  setInviteName('')
                  setInviteEmail('')
                  setInviteRole('member')
                  setAddMemberError('')
                }}
                onNameChange={setInviteName}
                onEmailChange={setInviteEmail}
                onRoleChange={setInviteRole}
                onTeamChange={() => undefined}
                onSubmit={() => void inviteMember()}
              />
            )}

            {addMemberMode === 'existing' && addMemberError ? (
              <div className="cu-banner cu-banner--error">{addMemberError}</div>
            ) : null}

            {addMemberMode === 'existing' ? (
              <div className="cu-modal-panel__foot">
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => setShowAddMember(false)}
                  disabled={addingMember}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary"
                  onClick={() => void (addMemberMode === 'existing' ? addMember() : inviteMember())}
                  disabled={
                    addingMember ||
                    (addMemberMode === 'existing'
                      ? selectedUserIdsToAdd.length === 0
                      : !inviteName.trim() || !inviteEmail.trim())
                  }
                >
                  {addingMember
                    ? 'Adding…'
                    : addMemberMode === 'existing'
                      ? selectedUserIdsToAdd.length > 1
                        ? 'Add members'
                        : 'Add member'
                      : 'Send invite'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

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
              <label htmlFor="team-context-picker">Contexts</label>
              <SelectionDropdown
                id="team-context-picker"
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
                      ? 'Team context updated.'
                      : 'Team contexts updated.'
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
                Add agent
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
              <label htmlFor="team-agent-picker">Agents</label>
              <SelectionDropdown
                id="team-agent-picker"
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
                      ? 'Team agent access updated.'
                      : 'Team agents access updated.'
                  )
                  setShowAddAgent(false)
                }}
                disabled={busy || selectedAgentNamesToAdd.length === 0}
              >
                {selectedAgentNamesToAdd.length > 1 ? 'Add agents' : 'Add agent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteTeamConfirm && (
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
            if (e.target === e.currentTarget && !deletingTeam) setShowDeleteTeamConfirm(false)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="confirm-delete-team"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="confirm-delete-team" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Delete team permanently?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowDeleteTeamConfirm(false)}
                disabled={deletingTeam}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              This removes <strong>{teamName || teamId}</strong> and cannot be undone.
            </p>
            {deleteTeamDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteTeamDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowDeleteTeamConfirm(false)}
                disabled={deletingTeam}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                style={{ background: 'var(--cu-danger)', borderColor: 'var(--cu-danger)' }}
                onClick={() => void deleteTeamPermanently()}
                disabled={deletingTeam}
              >
                {deletingTeam ? 'Deleting…' : 'Delete team'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog}
    </DetailPageShell>
  )
}
