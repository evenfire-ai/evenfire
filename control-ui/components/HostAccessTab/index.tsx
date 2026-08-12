'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  getAdminTeamAgents,
  getAdminUserAgents,
  getAgentTeams,
  getAgentUsers,
  getHostDetailBundle,
  updateAdminTeamAgents,
  updateAdminUserAgents,
} from '@lib/api'
import type { AccessSubTab, AccessTeamRow, AccessUserRow, HostAccessTabProps } from './types'

const ACCESS_SUB_TABS: { key: AccessSubTab; label: string }[] = [
  { key: 'members', label: 'Members' },
  { key: 'teams', label: 'Teams' },
]

export function HostAccessTab({ hostName }: HostAccessTabProps) {
  const router = useRouter()
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const mountedRef = useRef(true)
  const loadRequestId = useRef(0)

  const [subTab, setSubTab] = useState<AccessSubTab>('members')
  const [allUsers, setAllUsers] = useState<AccessUserRow[]>([])
  const [allTeams, setAllTeams] = useState<AccessTeamRow[]>([])
  const [usersWithAccess, setUsersWithAccess] = useState<AccessUserRow[]>([])
  const [teamsWithAccess, setTeamsWithAccess] = useState<AccessTeamRow[]>([])
  const [selectedUserIdsToGrant, setSelectedUserIdsToGrant] = useState<string[]>([])
  const [selectedTeamIdsToGrant, setSelectedTeamIdsToGrant] = useState<string[]>([])
  const [showAddUser, setShowAddUser] = useState(false)
  const [showAddTeam, setShowAddTeam] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadAccess = useCallback(async () => {
    const requestId = loadRequestId.current + 1
    loadRequestId.current = requestId
    setInitialLoading(true)
    setError('')
    try {
      const detail = await getHostDetailBundle(hostName)
      if (!mountedRef.current || requestId !== loadRequestId.current) return
      setAllUsers(Array.isArray(detail.users) ? detail.users : [])
      setAllTeams(Array.isArray(detail.teams) ? detail.teams : [])
      setUsersWithAccess(Array.isArray(detail.agentUsers) ? detail.agentUsers : [])
      setTeamsWithAccess(Array.isArray(detail.agentTeams) ? detail.agentTeams : [])
    } catch (e) {
      if (!mountedRef.current || requestId !== loadRequestId.current) return
      const message = e instanceof Error ? e.message : 'Failed to load access data'
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      if (mountedRef.current && requestId === loadRequestId.current) {
        setInitialLoading(false)
      }
    }
  }, [hostName, showToast])

  useEffect(() => {
    void loadAccess()
    return () => {
      loadRequestId.current += 1
    }
  }, [loadAccess])

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

  async function grantUserAccess() {
    if (selectedUserIdsToGrant.length === 0) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedUserIdsToGrant.map(async userId => {
          const current = await getAdminUserAgents(userId)
          const next = Array.from(new Set([...(current.agentNames || []), hostName]))
          await updateAdminUserAgents(userId, next, [
            ...(current.agentNames || []),
            ...(current.deletedAgentNames || []),
          ])
        })
      )
      const grantedUserIds = selectedUserIdsToGrant
      const grantedUser = allUsers.find(u => u.id === grantedUserIds[0])
      setSelectedUserIdsToGrant([])
      const refreshed = await getAgentUsers(hostName)
      if (!mountedRef.current) return
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
      if (mountedRef.current) setBusy(false)
    }
  }

  async function revokeUserAccess(userId: string) {
    const user = usersWithAccess.find(item => item.id === userId)
    const shouldRevoke = await confirm({
      title: 'Revoke Member Access',
      message: `Revoke ${user?.displayName || user?.name || user?.email || 'this member'}'s access to ${hostName}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setBusy(true)
    setError('')
    try {
      const current = await getAdminUserAgents(userId)
      const next = (current.agentNames || []).filter(name => name !== hostName)
      await updateAdminUserAgents(userId, next, [
        ...(current.agentNames || []),
        ...(current.deletedAgentNames || []),
      ])
      if (!mountedRef.current) return
      const removedUser = usersWithAccess.find(u => u.id === userId)
      setUsersWithAccess(prev => prev.filter(u => u.id !== userId))
      showToast(
        `${removedUser?.displayName || removedUser?.name || userId} can no longer use this agent.`,
        { tone: 'success' }
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke member access')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function grantTeamAccess() {
    if (selectedTeamIdsToGrant.length === 0) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedTeamIdsToGrant.map(async teamId => {
          const current = await getAdminTeamAgents(teamId)
          const next = Array.from(new Set([...(current.agentNames || []), hostName]))
          await updateAdminTeamAgents(teamId, next, [
            ...(current.agentNames || []),
            ...(current.deletedAgentNames || []),
          ])
        })
      )
      const grantedTeamIds = selectedTeamIdsToGrant
      const grantedTeam = allTeams.find(t => t.id === grantedTeamIds[0])
      setSelectedTeamIdsToGrant([])
      const refreshed = await getAgentTeams(hostName)
      if (!mountedRef.current) return
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
      if (mountedRef.current) setBusy(false)
    }
  }

  async function revokeTeamAccess(teamId: string) {
    const team = teamsWithAccess.find(item => item.id === teamId)
    const shouldRevoke = await confirm({
      title: 'Revoke Team Access',
      message: `Revoke ${team?.name || 'this team'}'s access to ${hostName}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setBusy(true)
    setError('')
    try {
      const current = await getAdminTeamAgents(teamId)
      const next = (current.agentNames || []).filter(name => name !== hostName)
      await updateAdminTeamAgents(teamId, next, [
        ...(current.agentNames || []),
        ...(current.deletedAgentNames || []),
      ])
      if (!mountedRef.current) return
      const removedTeam = teamsWithAccess.find(t => t.id === teamId)
      setTeamsWithAccess(prev => prev.filter(team => team.id !== teamId))
      showToast(`${removedTeam?.name || teamId} can no longer use this agent.`, {
        tone: 'success',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke team access')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const subTabDescription =
    subTab === 'members'
      ? 'Grant or revoke which members can use this agent.'
      : 'Grant or revoke team-level access to this agent.'

  return (
    <section className="cu-access-tab" aria-label="Access">
      {error ? (
        <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
          {error}
        </div>
      ) : null}

      <TabBar<AccessSubTab>
        activeValue={subTab}
        ariaLabel="Access type"
        className="cu-tabs--compact cu-access-tabs"
        onChange={setSubTab}
        options={ACCESS_SUB_TABS.map(tab => ({ label: tab.label, value: tab.key }))}
      />

      <div className="cu-access-section">
        <div className="cu-access-section__header">
          <p className="cu-muted cu-access-section__description">{subTabDescription}</p>
          {subTab === 'members' ? (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddUser(true)}
              disabled={busy}
            >
              Add member
            </button>
          ) : (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddTeam(true)}
              disabled={busy}
            >
              Add team
            </button>
          )}
        </div>

        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <tr>
                <th>{subTab === 'members' ? 'Member' : 'Team'}</th>
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
              ) : subTab === 'members' ? (
                usersWithAccess.length === 0 ? (
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
                          onClick={() => router.push(CONTROL_ROUTES.usersAndTeams.user(user.id))}
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
                            disabled={busy}
                            title="Revoke"
                            aria-label="Revoke member access"
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )
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
                        onClick={() => router.push(CONTROL_ROUTES.usersAndTeams.team(team.id))}
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
                          disabled={busy}
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
      </div>

      {showAddUser ? (
        <AccessGrantModal
          busy={busy}
          emptyLabel="No available members."
          id="agent-member-picker"
          label="Members"
          onClose={() => setShowAddUser(false)}
          onConfirm={async () => {
            await grantUserAccess()
            setShowAddUser(false)
          }}
          options={memberGrantOptions}
          placeholder="Select members"
          searchPlaceholder="Search members..."
          selectionLabel="Selected members"
          submitLabel={selectedUserIdsToGrant.length > 1 ? 'Add members' : 'Add member'}
          title="Add member"
          titleId="add-user-title"
          value={selectedUserIdsToGrant}
          onChange={setSelectedUserIdsToGrant}
        />
      ) : null}

      {showAddTeam ? (
        <AccessGrantModal
          busy={busy}
          emptyLabel="No available teams."
          id="agent-team-picker"
          label="Teams"
          onClose={() => setShowAddTeam(false)}
          onConfirm={async () => {
            await grantTeamAccess()
            setShowAddTeam(false)
          }}
          options={teamGrantOptions}
          placeholder="Select teams"
          searchPlaceholder="Search teams..."
          selectionLabel="Selected teams"
          submitLabel={selectedTeamIdsToGrant.length > 1 ? 'Add teams' : 'Add team'}
          title="Add team"
          titleId="add-team-title"
          value={selectedTeamIdsToGrant}
          onChange={setSelectedTeamIdsToGrant}
        />
      ) : null}

      {confirmDialog}
    </section>
  )
}

type AccessGrantModalProps = {
  busy: boolean
  emptyLabel: string
  id: string
  label: string
  onChange: (next: string[]) => void
  onClose: () => void
  onConfirm: () => Promise<void>
  options: { value: string; label: string; description?: string; badge?: string }[]
  placeholder: string
  searchPlaceholder: string
  selectionLabel: string
  submitLabel: string
  title: string
  titleId: string
  value: string[]
}

function AccessGrantModal({
  busy,
  emptyLabel,
  id,
  label,
  onChange,
  onClose,
  onConfirm,
  options,
  placeholder,
  searchPlaceholder,
  selectionLabel,
  submitLabel,
  title,
  titleId,
  value,
}: AccessGrantModalProps) {
  return (
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
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="cu-modal-panel cu-modal-panel--selection"
        role="dialog"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <strong id={titleId} style={{ fontSize: '1rem', lineHeight: 1.35 }}>
            {title}
          </strong>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <IconX width={18} height={18} />
          </button>
        </div>

        <div className="cu-field">
          <label htmlFor={id}>{label}</label>
          <SelectionDropdown
            emptyLabel={emptyLabel}
            id={id}
            inline
            disabled={busy}
            onChange={onChange}
            options={options}
            placeholder={placeholder}
            searchPlaceholder={searchPlaceholder}
            selectionLabel={selectionLabel}
            value={value}
          />
        </div>

        <div className="cu-modal-panel__foot">
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--primary"
            onClick={() => void onConfirm()}
            disabled={busy || value.length === 0}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
