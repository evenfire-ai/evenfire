'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  AdminPendingInvitationListItem,
  AdminUser,
  DeleteAdminUserRequest,
  TeamListItem,
  createDeleteAdminUserRequest,
  deleteAdminTeam,
  deleteAdminUser,
  getAdminTeams,
  getAdminUserTeams,
  getProfileAdminOverview,
  resendAdminTeamInvitation,
  resendAdminUserPasswordSetupInvitation,
  revokeAdminTeamInvitation,
} from '../lib/api'
import type { DeleteCandidateTeam } from '../lib/profileAdminDelete'
import { formatTeamNames, getSoloMemberTeamsForUser } from '../lib/profileAdminDelete'
import { formatTeamRole } from '../lib/teamRoles'
import { ControlAdminsPanel } from './ControlAdminsPanel'
import type { ProfileAdminHomeProps, ProfileAdminTab } from './ProfileAdminHome.types'
import { SectionSearchInput } from './SectionSearchInput'
import { IconShield, IconUsers } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TabBar } from './TabBar'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { IconAlertTriangle, IconRefresh, IconX } from './icons'
import { CheckboxField } from './ui'

type TeamSortKey = 'members' | 'agents' | 'contexts'

export function ProfileAdminHome({ activeTab, highlightedAdminId = '' }: ProfileAdminHomeProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loaded, setLoaded] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [teamSearchInput, setTeamSearchInput] = useState('')
  const [adminSearchInput, setAdminSearchInput] = useState('')
  const [adminRefreshKey, setAdminRefreshKey] = useState(0)
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminCounts, setAdminCounts] = useState({ admins: 0, invitations: 0 })
  const [filteredTeams, setFilteredTeams] = useState<TeamListItem[]>([])
  const [teamSortKey, setTeamSortKey] = useState<TeamSortKey>('members')
  const [teamSortDir, setTeamSortDir] = useState<'asc' | 'desc'>('desc')
  const [memberTeamsSortDir, setMemberTeamsSortDir] = useState<'asc' | 'desc'>('desc')

  const [teamToDelete, setTeamToDelete] = useState<TeamListItem | null>(null)
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null)
  const [deleteUserSoloTeams, setDeleteUserSoloTeams] = useState<DeleteCandidateTeam[]>([])
  const [deleteUserTeamCheckError, setDeleteUserTeamCheckError] = useState('')
  const [deleteUserTeamCheckLoading, setDeleteUserTeamCheckLoading] = useState(false)
  const [deleteEmptyTeamsWithUser, setDeleteEmptyTeamsWithUser] = useState(false)
  const [invitationToCancel, setInvitationToCancel] =
    useState<AdminPendingInvitationListItem | null>(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [deleteDialogError, setDeleteDialogError] = useState('')

  const [teamAgentCounts, setTeamAgentCounts] = useState<Record<string, number>>({})
  const [teamContextCounts, setTeamContextCounts] = useState<Record<string, number>>({})
  const [pendingInvitations, setPendingInvitations] = useState<AdminPendingInvitationListItem[]>([])
  const [resendingInvitationId, setResendingInvitationId] = useState<string | null>(null)
  const [resendingPasswordSetupUserId, setResendingPasswordSetupUserId] = useState<string | null>(
    null
  )
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null)
  const { showToast } = useToast()
  const isInitialLoad = busy && !loaded
  const isListRefreshing = busy && loaded
  const deleteUserTeamCheckIdRef = useRef(0)
  const deleteUserRequestRef = useRef<DeleteAdminUserRequest | null>(null)

  function openUserTeams(user: AdminUser) {
    router.push(CONTROL_ROUTES.usersAndTeams.userTab(user.id, 'teams'))
  }

  function memberTeamsTooltip(user: AdminUser): string {
    const teamsForUser = Array.isArray(user.teams) ? user.teams : []
    if (teamsForUser.length === 0) return 'No teams'
    return teamsForUser.map(team => `${team.name} - ${formatTeamRole(team.role)}`).join('\n')
  }

  function pendingInvitationTeamLabel(invitation: AdminPendingInvitationListItem): string {
    const invitationTeams = Array.isArray(invitation.teams) ? invitation.teams : []
    if (invitationTeams.length > 0) return invitationTeams.map(team => team.name).join(', ')
    return invitation.team_name || 'Team'
  }

  // Initialize filteredTeams when teams change
  useEffect(() => {
    setFilteredTeams(teams)
  }, [teams])

  const activeTabDescription = useMemo(() => {
    if (activeTab === 'teams') {
      return 'Teams group members who can access the Desktop App and define shared access assignments.'
    }
    if (activeTab === 'admins') {
      return 'Admins are operators who can access Control UI. They do not receive Desktop App access from this tab.'
    }
    return 'Members are users who can access the Desktop App.'
  }, [activeTab])

  const handleAdminLoadingChange = useCallback((loading: boolean) => {
    setAdminLoading(loading)
  }, [])

  async function loadData() {
    setBusy(true)
    setError('')
    try {
      const overview = await getProfileAdminOverview()
      const teamsList = Array.isArray(overview.teams) ? overview.teams : []
      setTeams(teamsList)
      setUsers(Array.isArray(overview.users) ? overview.users : [])
      setPendingInvitations(
        Array.isArray(overview.pendingInvitations) ? overview.pendingInvitations : []
      )
      setTeamAgentCounts(overview.teamAgentCounts || {})
      setTeamContextCounts(overview.teamContextCounts || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setBusy(false)
      setLoaded(true)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  // Filter teams locally as user types
  useEffect(() => {
    if (teamSearchInput.trim()) {
      const filtered = teams.filter(team =>
        team.name.toLowerCase().includes(teamSearchInput.toLowerCase())
      )
      setFilteredTeams(filtered)
    } else {
      setFilteredTeams(teams)
    }
  }, [teamSearchInput, teams])

  const filteredPendingInvitations = useMemo(() => {
    const q = searchInput.trim().toLowerCase()
    if (!q) return pendingInvitations
    return pendingInvitations.filter(
      invitation =>
        invitation.email.toLowerCase().includes(q) ||
        String(invitation.team_name || '')
          .toLowerCase()
          .includes(q)
    )
  }, [pendingInvitations, searchInput])

  const visibleUsers = useMemo(() => {
    const pendingEmails = new Set(
      pendingInvitations.map(invitation => invitation.email.toLowerCase())
    )
    const q = searchInput.trim().toLowerCase()
    return users.filter(user => {
      const isPendingOnlyInvite =
        pendingEmails.has(user.email.toLowerCase()) &&
        (user.activeTeamCount || 0) === 0 &&
        !user.passwordPendingFromAcceptedInvitation
      if (isPendingOnlyInvite) return false
      if (!q) return true
      return [user.name, user.displayName, user.email]
        .filter((value): value is string => typeof value === 'string')
        .some(value => value.toLowerCase().includes(q))
    })
  }, [pendingInvitations, searchInput, users])

  const sortedTeams = useMemo(() => {
    const sorted = [...filteredTeams]
    const direction = teamSortDir === 'asc' ? 1 : -1
    sorted.sort((a, b) => {
      let countDiff = 0
      if (teamSortKey === 'members') {
        countDiff = a.memberCount - b.memberCount
      } else if (teamSortKey === 'agents') {
        countDiff = (teamAgentCounts[a.id] ?? 0) - (teamAgentCounts[b.id] ?? 0)
      } else {
        countDiff = (teamContextCounts[a.id] ?? 0) - (teamContextCounts[b.id] ?? 0)
      }
      countDiff *= direction
      if (countDiff !== 0) return countDiff
      return a.name.localeCompare(b.name)
    })
    return sorted
  }, [filteredTeams, teamAgentCounts, teamContextCounts, teamSortDir, teamSortKey])

  const sortedUsers = useMemo(() => {
    const sorted = [...visibleUsers]
    const direction = memberTeamsSortDir === 'asc' ? 1 : -1
    sorted.sort((a, b) => {
      const countDiff = ((a.activeTeamCount || 0) - (b.activeTeamCount || 0)) * direction
      if (countDiff !== 0) return countDiff
      const aLabel = a.displayName || a.name || a.email
      const bLabel = b.displayName || b.name || b.email
      return aLabel.localeCompare(bLabel)
    })
    return sorted
  }, [visibleUsers, memberTeamsSortDir])

  const membersTabLabel =
    activeTab === 'users'
      ? `Members (${visibleUsers.length}${pendingInvitations.length ? `, ${pendingInvitations.length} pending` : ''})`
      : 'Members'
  const teamsTabLabel = activeTab === 'teams' ? `Teams (${teams.length})` : 'Teams'
  const adminsTabLabel =
    activeTab === 'admins'
      ? `Admins (${adminCounts.admins}${
          adminCounts.invitations ? `, ${adminCounts.invitations} pending` : ''
        })`
      : 'Admins'

  function openTeam(team: TeamListItem) {
    router.push(CONTROL_ROUTES.usersAndTeams.teamTab(team.id, 'members'))
  }

  function openUser(user: AdminUser) {
    router.push(CONTROL_ROUTES.usersAndTeams.userTab(user.id, 'contact'))
  }

  function openAdminAccessForUser(user: AdminUser) {
    if (user.controlAdminId) {
      const searchParams = new URLSearchParams({ highlightAdminId: user.controlAdminId })
      router.push(CONTROL_ROUTES.usersAndTeams.admins(Object.fromEntries(searchParams)))
      return
    }
    const searchParams = new URLSearchParams({
      email: user.email,
      name: user.displayName || user.name || '',
      step: 'review',
      source: 'member',
    })
    router.push(CONTROL_ROUTES.usersAndTeams.newAdmin(Object.fromEntries(searchParams)))
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>, open: () => void) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  }

  function toggleTeamSort(nextKey: TeamSortKey) {
    if (teamSortKey === nextKey) {
      setTeamSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setTeamSortKey(nextKey)
    setTeamSortDir('desc')
  }

  function renderTeamSortButton(key: TeamSortKey, label: string) {
    const isActive = teamSortKey === key
    const indicator = isActive ? (teamSortDir === 'asc' ? '↑' : '↓') : ''
    const sortDirectionLabel =
      isActive && teamSortDir === 'asc' ? 'descending' : isActive ? 'ascending' : 'descending'
    return (
      <button
        type="button"
        className="cu-link cu-link--sm"
        style={{ color: 'var(--cu-text-muted)', whiteSpace: 'nowrap' }}
        onClick={() => toggleTeamSort(key)}
        aria-label={`Sort by ${label.toLowerCase()} ${sortDirectionLabel}`}
      >
        {label}
        {indicator ? ` ${indicator}` : ''}
      </button>
    )
  }

  async function resendPendingInvitation(invitation: AdminPendingInvitationListItem) {
    setResendingInvitationId(invitation.id)
    setError('')
    try {
      await resendAdminTeamInvitation(invitation.team_id, invitation.id)
      showToast(`Invitation email resent to ${invitation.email}.`, { tone: 'success' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to resend invitation email'
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setResendingInvitationId(null)
    }
  }

  async function cancelPendingInvitation() {
    if (!invitationToCancel) return
    const invitation = invitationToCancel
    setRevokingInvitationId(invitation.id)
    setDeleteSubmitting(true)
    setDeleteDialogError('')
    setError('')
    try {
      await revokeAdminTeamInvitation(invitation.team_id, invitation.id)
      setPendingInvitations(prev => prev.filter(item => item.id !== invitation.id))
      setInvitationToCancel(null)
      showToast(`Invitation cancelled for ${invitation.email}.`, { tone: 'info' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to cancel invitation'
      setError(message)
      setDeleteDialogError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setRevokingInvitationId(null)
      setDeleteSubmitting(false)
    }
  }

  async function resendPasswordSetupInvitation(user: AdminUser) {
    setResendingPasswordSetupUserId(user.id)
    setError('')
    try {
      await resendAdminUserPasswordSetupInvitation(user.id)
      showToast(`New invitation sent to ${user.email}.`, { tone: 'success' })
      await loadData()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to resend invitation'
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setResendingPasswordSetupUserId(null)
    }
  }

  async function runDeleteTeam() {
    if (!teamToDelete) return
    setDeleteSubmitting(true)
    setDeleteDialogError('')
    try {
      await deleteAdminTeam(teamToDelete.id)
      setTeamToDelete(null)
      await loadData()
    } catch (e) {
      setDeleteDialogError(e instanceof Error ? e.message : 'Failed to delete team')
    } finally {
      setDeleteSubmitting(false)
    }
  }

  async function openDeleteUserDialog(user: AdminUser) {
    const checkId = deleteUserTeamCheckIdRef.current + 1
    deleteUserTeamCheckIdRef.current = checkId
    setDeleteDialogError('')
    setDeleteUserTeamCheckError('')
    setDeleteUserSoloTeams([])
    setDeleteEmptyTeamsWithUser(false)
    setDeleteUserTeamCheckLoading(false)
    deleteUserRequestRef.current = createDeleteAdminUserRequest()
    setUserToDelete(user)
    if ((user.activeTeamCount || 0) === 0) return

    setDeleteUserTeamCheckLoading(true)
    try {
      const [userTeamsData, teamsData] = await Promise.all([
        getAdminUserTeams(user.id),
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

  async function runDeleteUser() {
    if (!userToDelete) return
    setDeleteSubmitting(true)
    setDeleteDialogError('')
    setDeleteUserTeamCheckError('')
    const teamsToDelete = deleteEmptyTeamsWithUser ? deleteUserSoloTeams : []
    try {
      await deleteAdminUser(
        userToDelete.id,
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
      setUserToDelete(null)
      deleteUserRequestRef.current = null
      setDeleteUserSoloTeams([])
      setDeleteEmptyTeamsWithUser(false)
      await loadData()
      if (failedTeams.length > 0) {
        const message = `Member deleted, but ${failedTeams.length === 1 ? 'team' : 'teams'} could not be deleted: ${formatTeamNames(failedTeams)}.`
        setError(message)
        showToast(message, { tone: 'error' })
        return
      }
      showToast(
        teamsToDelete.length > 0
          ? `Member and ${teamsToDelete.length === 1 ? 'empty team' : 'empty teams'} deleted.`
          : 'Member deleted.',
        { tone: 'success' }
      )
    } catch (e) {
      setDeleteDialogError(e instanceof Error ? e.message : 'Failed to delete member')
    } finally {
      setDeleteSubmitting(false)
    }
  }

  return (
    <>
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconUsers />
              Users & Teams
            </>
          }
          subtitle="Members and teams grant Desktop App access. Admins grant Control UI access."
          actions={
            <>
              <SectionSearchInput
                value={
                  activeTab === 'admins'
                    ? adminSearchInput
                    : activeTab === 'teams'
                      ? teamSearchInput
                      : searchInput
                }
                onChange={value => {
                  if (activeTab === 'admins') {
                    setAdminSearchInput(value)
                    return
                  }
                  if (activeTab === 'teams') {
                    setTeamSearchInput(value)
                    return
                  }
                  setSearchInput(value)
                }}
                placeholder={
                  activeTab === 'admins'
                    ? 'Search admins'
                    : activeTab === 'teams'
                      ? 'Search teams'
                      : 'Search members'
                }
                ariaLabel={
                  activeTab === 'admins'
                    ? 'Search admins'
                    : activeTab === 'teams'
                      ? 'Search teams'
                      : 'Search members'
                }
                disabled={activeTab === 'admins' ? adminLoading : isInitialLoad}
              />
              {activeTab === 'admins' ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--toolbar"
                  onClick={() => setAdminRefreshKey(key => key + 1)}
                  disabled={adminLoading}
                  aria-label={adminLoading ? 'Refreshing admins...' : 'Reload admins'}
                >
                  <IconRefresh
                    className={adminLoading ? 'cu-spin' : undefined}
                    width={18}
                    height={18}
                  />
                </button>
              ) : (
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--toolbar"
                  onClick={() => void loadData()}
                  disabled={busy}
                  aria-label={
                    isListRefreshing ? 'Refreshing users and teams...' : 'Reload users and teams'
                  }
                >
                  <IconRefresh
                    className={isListRefreshing ? 'cu-spin' : undefined}
                    width={18}
                    height={18}
                  />
                </button>
              )}
              {activeTab === 'admins' ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => router.push(CONTROL_ROUTES.usersAndTeams.newAdmin())}
                  disabled={adminLoading}
                >
                  Invite admin
                </button>
              ) : activeTab === 'teams' ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => router.push(CONTROL_ROUTES.usersAndTeams.newTeam)}
                  disabled={busy && !loaded}
                >
                  Create team
                </button>
              ) : (
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => router.push(CONTROL_ROUTES.usersAndTeams.newUser())}
                  disabled={busy && !loaded}
                >
                  Create member
                </button>
              )}
            </>
          }
        />
        <div className="cu-card__body">
          <TabBar<ProfileAdminTab>
            ariaLabel="Users and teams sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={[
              {
                value: 'users',
                href: CONTROL_ROUTES.usersAndTeams.users,
                label: membersTabLabel,
                disabled: busy && !loaded,
              },
              {
                value: 'teams',
                href: CONTROL_ROUTES.usersAndTeams.teams,
                label: teamsTabLabel,
                disabled: busy && !loaded,
              },
              {
                value: 'admins',
                href: CONTROL_ROUTES.usersAndTeams.admins(),
                label: adminsTabLabel,
                disabled: false,
              },
            ]}
          />
          <p className="cu-muted-note--compact cu-profile-admin-tab-description">
            {activeTabDescription}
          </p>

          {activeTab === 'admins' ? (
            <ControlAdminsPanel
              highlightedAdminId={highlightedAdminId}
              searchInput={adminSearchInput}
              refreshKey={adminRefreshKey}
              onCountsChange={setAdminCounts}
              onLoadingChange={handleAdminLoadingChange}
            />
          ) : activeTab === 'teams' ? (
            <>
              {busy && !loaded ? (
                <div className="cu-table-wrap">
                  <table className="cu-table cu-table--profile cu-table--header-band">
                    <thead>
                      <tr>
                        <th>Team name</th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          {renderTeamSortButton('members', 'Members')}
                        </th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          {renderTeamSortButton('agents', 'Agents')}
                        </th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          {renderTeamSortButton('contexts', 'Contexts')}
                        </th>
                        <th style={{ width: '4.5rem', textAlign: 'right' }} aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      <SkeletonTableRows columns={5} rows={5} />
                    </tbody>
                  </table>
                </div>
              ) : filteredTeams.length === 0 ? (
                <div className="cu-empty">
                  {teamSearchInput.trim() ? 'No teams match this search.' : 'No teams yet.'}
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table cu-table--profile cu-table--header-band">
                    <thead>
                      <tr>
                        <th>Team name</th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          {renderTeamSortButton('members', 'Members')}
                        </th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          {renderTeamSortButton('agents', 'Agents')}
                        </th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          {renderTeamSortButton('contexts', 'Contexts')}
                        </th>
                        <th style={{ width: '4.5rem', textAlign: 'right' }} aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedTeams.map(team => (
                        <tr
                          key={team.id}
                          className="cu-table__row cu-table__row--clickable"
                          onClick={() => openTeam(team)}
                          onKeyDown={event => handleRowKeyDown(event, () => openTeam(team))}
                          tabIndex={0}
                          aria-label={`Open team ${team.name}`}
                        >
                          <td>
                            <button
                              type="button"
                              className="cu-link"
                              onClick={event => {
                                event.stopPropagation()
                                openTeam(team)
                              }}
                              onKeyDown={event => event.stopPropagation()}
                            >
                              {team.name}
                            </button>
                          </td>
                          <td
                            style={{
                              fontVariantNumeric: 'tabular-nums',
                              color: 'var(--cu-text-muted)',
                              textAlign: 'right',
                            }}
                          >
                            {team.memberCount}
                          </td>
                          <td
                            style={{
                              fontVariantNumeric: 'tabular-nums',
                              color: 'var(--cu-text-muted)',
                              textAlign: 'right',
                            }}
                          >
                            {teamAgentCounts[team.id] ?? 0}
                          </td>
                          <td
                            style={{
                              fontVariantNumeric: 'tabular-nums',
                              color: 'var(--cu-text-muted)',
                              textAlign: 'right',
                            }}
                          >
                            {teamContextCounts[team.id] ?? 0}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                              onClick={event => {
                                event.stopPropagation()
                                setDeleteDialogError('')
                                setTeamToDelete(team)
                              }}
                              onKeyDown={event => event.stopPropagation()}
                              disabled={busy && !loaded}
                              aria-label={`Delete team ${team.name}`}
                            >
                              <IconX width={16} height={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
              {busy && !loaded ? (
                <div className="cu-table-wrap">
                  <table className="cu-table cu-table--profile cu-table--header-band">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th style={{ width: '5rem', textAlign: 'right' }}>
                          <button
                            type="button"
                            className="cu-link cu-link--sm"
                            style={{ color: 'var(--cu-text-muted)', whiteSpace: 'nowrap' }}
                            onClick={() =>
                              setMemberTeamsSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
                            }
                            aria-label={`Sort by team count ${memberTeamsSortDir === 'asc' ? 'descending' : 'ascending'}`}
                          >
                            Teams {memberTeamsSortDir === 'asc' ? '↑' : '↓'}
                          </button>
                        </th>
                        <th style={{ width: '4.5rem', textAlign: 'right' }} aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      <SkeletonTableRows columns={4} rows={5} />
                    </tbody>
                  </table>
                </div>
              ) : (
                <>
                  {filteredPendingInvitations.length > 0 && (
                    <div className="cu-profile-section">
                      <p className="cu-profile-section__label">Pending invitations</p>
                      <div className="cu-table-wrap">
                        <table className="cu-table cu-table--profile cu-table--header-band">
                          <thead>
                            <tr>
                              <th>Team</th>
                              <th>Email</th>
                              <th className="cu-table__col-role">Role</th>
                              <th className="cu-table__col-date">Invited</th>
                              <th className="cu-table__col-actions" aria-label="Actions" />
                            </tr>
                          </thead>
                          <tbody>
                            {filteredPendingInvitations.map(invitation => (
                              <tr key={invitation.id}>
                                <td>
                                  {invitation.team_id ? (
                                    <button
                                      type="button"
                                      className="cu-link"
                                      onClick={() =>
                                        router.push(
                                          CONTROL_ROUTES.usersAndTeams.team(invitation.team_id)
                                        )
                                      }
                                    >
                                      {pendingInvitationTeamLabel(invitation)}
                                    </button>
                                  ) : (
                                    <span className="cu-muted">No team</span>
                                  )}
                                </td>
                                <td className="cu-table__cell-soft">{invitation.email}</td>
                                <td>{formatTeamRole(invitation.role)}</td>
                                <td className="cu-table__cell-muted">
                                  {new Date(invitation.created_at).toLocaleString()}
                                </td>
                                <td className="cu-table__cell-actions">
                                  <div className="cu-row-actions cu-row-actions--wrap">
                                    <button
                                      type="button"
                                      className="cu-btn cu-btn--sm"
                                      onClick={() => void resendPendingInvitation(invitation)}
                                      disabled={
                                        (busy && !loaded) || resendingInvitationId === invitation.id
                                      }
                                    >
                                      {resendingInvitationId === invitation.id
                                        ? 'Sending…'
                                        : 'Resend'}
                                    </button>
                                    <button
                                      type="button"
                                      className="cu-btn cu-btn--ghost cu-btn--ghost-danger cu-btn--sm"
                                      onClick={() => {
                                        setDeleteDialogError('')
                                        setInvitationToCancel(invitation)
                                      }}
                                      disabled={
                                        (busy && !loaded) || revokingInvitationId === invitation.id
                                      }
                                    >
                                      {revokingInvitationId === invitation.id
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
                  {searchInput.trim() &&
                    pendingInvitations.length > 0 &&
                    filteredPendingInvitations.length === 0 && (
                      <div className="cu-empty cu-empty--spaced-bottom">
                        No pending invitations match this search.
                      </div>
                    )}
                  {visibleUsers.length === 0 && filteredPendingInvitations.length === 0 ? (
                    <div className="cu-empty">
                      {searchInput.trim()
                        ? 'No members or pending invitations match this search.'
                        : 'No members yet.'}
                    </div>
                  ) : visibleUsers.length === 0 ? (
                    <div
                      className={`cu-empty${filteredPendingInvitations.length ? ' cu-empty--spaced-top' : ''}`}
                    >
                      {searchInput.trim()
                        ? 'No registered members match this search.'
                        : 'No registered members yet.'}
                    </div>
                  ) : (
                    <div className="cu-table-wrap">
                      <table className="cu-table cu-table--profile cu-table--header-band">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th className="cu-table__col-count">
                              <button
                                type="button"
                                className="cu-link cu-link--sm cu-table__sort-link"
                                onClick={() =>
                                  setMemberTeamsSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
                                }
                                aria-label={`Sort by team count ${memberTeamsSortDir === 'asc' ? 'descending' : 'ascending'}`}
                              >
                                Teams {memberTeamsSortDir === 'asc' ? '↑' : '↓'}
                              </button>
                            </th>
                            <th className="cu-table__col-actions-wide" aria-label="Actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {sortedUsers.map(user => (
                            <tr
                              key={user.id}
                              className="cu-table__row cu-table__row--clickable"
                              onClick={() => openUser(user)}
                              onKeyDown={event => handleRowKeyDown(event, () => openUser(user))}
                              tabIndex={0}
                              aria-label={`Open member ${user.name || user.email}`}
                            >
                              <td>
                                <button
                                  type="button"
                                  className="cu-link"
                                  onClick={event => {
                                    event.stopPropagation()
                                    openUser(user)
                                  }}
                                  onKeyDown={event => event.stopPropagation()}
                                >
                                  {user.name || '—'}
                                </button>
                              </td>
                              <td className="cu-table__cell-soft">
                                <span className="cu-member-email">
                                  <span>{user.email}</span>
                                  {user.passwordPendingFromAcceptedInvitation ? (
                                    <span
                                      className="cu-member-email__alert"
                                      title="Invitation accepted, but this user still needs to set a password."
                                      aria-label="Invitation accepted, password setup pending"
                                    >
                                      <IconAlertTriangle width={14} height={14} />
                                    </span>
                                  ) : null}
                                </span>
                              </td>
                              <td className="cu-table__cell-numeric">
                                <button
                                  type="button"
                                  className="cu-link cu-link--sm"
                                  title={memberTeamsTooltip(user)}
                                  onClick={() => openUserTeams(user)}
                                  aria-label={`Open teams for ${user.name || user.email}`}
                                >
                                  {user.activeTeamCount}
                                </button>
                              </td>
                              <td className="cu-table__cell-actions">
                                <div className="cu-row-actions cu-row-actions--nowrap">
                                  {user.passwordPendingFromAcceptedInvitation ? (
                                    <button
                                      type="button"
                                      className="cu-btn cu-btn--sm cu-nowrap"
                                      onClick={event => {
                                        event.stopPropagation()
                                        void resendPasswordSetupInvitation(user)
                                      }}
                                      onKeyDown={event => event.stopPropagation()}
                                      disabled={
                                        (busy && !loaded) ||
                                        resendingPasswordSetupUserId === user.id
                                      }
                                    >
                                      {resendingPasswordSetupUserId === user.id
                                        ? 'Sending…'
                                        : 'Resend invite'}
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="cu-btn cu-btn--icon cu-btn--toolbar"
                                    onClick={event => {
                                      event.stopPropagation()
                                      openAdminAccessForUser(user)
                                    }}
                                    onKeyDown={event => event.stopPropagation()}
                                    disabled={busy && !loaded}
                                    aria-label={`${
                                      user.controlAdminId ? 'View admin' : 'Create admin'
                                    } for member ${user.name || user.email}`}
                                    title={user.controlAdminId ? 'View admin' : 'Create admin'}
                                  >
                                    <IconShield
                                      createBadge={!user.controlAdminId}
                                      relationshipRole="admin"
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                    onClick={event => {
                                      event.stopPropagation()
                                      void openDeleteUserDialog(user)
                                    }}
                                    onKeyDown={event => event.stopPropagation()}
                                    disabled={busy && !loaded}
                                    aria-label={`Delete member ${user.name || user.email}`}
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
            </>
          )}
          {error ? (
            <div className="cu-banner cu-banner--error" style={{ marginTop: '1rem' }}>
              {error}
            </div>
          ) : null}
        </div>
      </div>

      {invitationToCancel && (
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
            if (e.target === e.currentTarget && !deleteSubmitting) setInvitationToCancel(null)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="cancel-invitation-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="cancel-invitation-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Cancel invitation?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setInvitationToCancel(null)}
                disabled={deleteSubmitting}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              Cancel the invitation to <strong>{invitationToCancel.email}</strong>
              {invitationToCancel.team_name ? (
                <>
                  {' '}
                  for team <strong>{invitationToCancel.team_name}</strong>
                </>
              ) : null}
              . The link in their email will stop working.
            </p>
            {deleteDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setInvitationToCancel(null)}
                disabled={deleteSubmitting}
              >
                Keep invitation
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--danger cu-btn--sm"
                onClick={() => void cancelPendingInvitation()}
                disabled={deleteSubmitting}
              >
                {deleteSubmitting ? 'Cancelling…' : 'Cancel invitation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {teamToDelete && (
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
            if (e.target === e.currentTarget && !deleteSubmitting) setTeamToDelete(null)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="delete-team-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="delete-team-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Delete team?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setTeamToDelete(null)}
                disabled={deleteSubmitting}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              Permanently delete <strong>{teamToDelete.name}</strong> and all memberships, pending
              invitations, and team context/agent mappings. This cannot be undone.
            </p>
            {deleteDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setTeamToDelete(null)}
                disabled={deleteSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                style={{ background: 'var(--cu-danger)', borderColor: 'var(--cu-danger)' }}
                onClick={() => void runDeleteTeam()}
                disabled={deleteSubmitting}
              >
                {deleteSubmitting ? 'Deleting…' : 'Delete team'}
              </button>
            </div>
          </div>
        </div>
      )}

      {userToDelete && (
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
            if (e.target === e.currentTarget && !deleteSubmitting) setUserToDelete(null)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="delete-user-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="delete-user-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Delete member account?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setUserToDelete(null)}
                disabled={deleteSubmitting}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              Permanently delete{' '}
              <strong>{userToDelete.displayName || userToDelete.name || userToDelete.email}</strong>{' '}
              ({userToDelete.email}
              ). Team memberships are removed before the account is deleted.
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
                  disabled={deleteSubmitting}
                  label="Delete empty teams too"
                  description={`Also delete ${deleteUserSoloTeams.length === 1 ? 'this team' : 'these teams'} after the account is removed: ${formatTeamNames(deleteUserSoloTeams)}.`}
                  onChange={event => setDeleteEmptyTeamsWithUser(event.currentTarget.checked)}
                />
              </div>
            ) : null}
            {deleteDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setUserToDelete(null)}
                disabled={deleteSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                style={{ background: 'var(--cu-danger)', borderColor: 'var(--cu-danger)' }}
                onClick={() => void runDeleteUser()}
                disabled={deleteSubmitting || deleteUserTeamCheckLoading}
              >
                {deleteSubmitting ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
