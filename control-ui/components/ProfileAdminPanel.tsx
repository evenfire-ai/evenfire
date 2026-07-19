'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  AdminUser,
  AdminUserChannels,
  AdminUserContext,
  ContextResource,
  TeamMember,
  TeamSummary,
  createAdminTeam,
  deleteAdminMember,
  getAdminTeamMembers,
  getAdminUserContext,
  getAdminUserContexts,
  getAdminUserTeams,
  getAdminUsers,
  getContexts,
  inviteAdminTeamMember,
  renameAdminTeam,
  updateAdminMemberRole,
  updateAdminUserContext,
  updateAdminUserContexts,
} from '../lib/api'
import { useConfirmDialog } from './ConfirmDialog'
import { useToast } from './Toast'

type Role = 'admin' | 'inviter' | 'member'
type InviteRole = Role

type Member = TeamMember

type ProfileAdminPanelProps = {
  initialUserId?: string
  onSelectedUserIdChange?: (userId: string | null) => void
}

export function ProfileAdminPanel({
  initialUserId = '',
  onSelectedUserIdChange,
}: ProfileAdminPanelProps) {
  const router = useRouter()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [selectedUserContext, setSelectedUserContext] = useState<AdminUserContext | null>(null)
  const [availableContextIds, setAvailableContextIds] = useState<string[]>([])
  const [assignedContextIds, setAssignedContextIds] = useState<string[]>([])
  const [selectedContextToAdd, setSelectedContextToAdd] = useState('')
  const [userQuery, setUserQuery] = useState('')
  const [userId, setUserId] = useState('')
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [memberRoleDrafts, setMemberRoleDrafts] = useState<Record<string, Role>>({})

  const [newTeamName, setNewTeamName] = useState('')
  const [teamNameDraft, setTeamNameDraft] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<InviteRole>('member')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [emailDraft, setEmailDraft] = useState('')
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [contactEmailsDraft, setContactEmailsDraft] = useState<string[]>([])
  const [slackHandlesDraft, setSlackHandlesDraft] = useState<string[]>([])
  const [telegramIdsDraft, setTelegramIdsDraft] = useState<string[]>([])
  const [newContactEmail, setNewContactEmail] = useState('')
  const [newSlackHandle, setNewSlackHandle] = useState('')
  const [newTelegramId, setNewTelegramId] = useState('')

  const selectedTeam = useMemo(
    () => teams.find(team => team.id === selectedTeamId) || null,
    [teams, selectedTeamId]
  )

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

  function hydrateContextDraft(context: AdminUserContext) {
    setEmailDraft(context.email || '')
    setContactEmailsDraft(uniqueTrimmed(context.channels.emails || [], true))
    setSlackHandlesDraft(uniqueTrimmed(context.channels.slackUserNames || []))
    setTelegramIdsDraft(uniqueTrimmed(context.channels.telegramIds || []))
    setNewContactEmail('')
    setNewSlackHandle('')
    setNewTelegramId('')
  }

  function contextIdFromResource(resource: ContextResource): string {
    const fromSpec = String(resource.spec?.contextId || '').trim()
    if (fromSpec) return fromSpec
    return String(resource.metadata?.name || '').trim()
  }

  async function loadUsers(searchQuery = userQuery) {
    setError('')
    try {
      const data = await getAdminUsers(searchQuery.trim())
      setUsers(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load users'
      setUsers([])
      if (message.includes('404')) {
        setError(
          'Profile admin users endpoint is unavailable (404). Deploy/restart control-api with admin profile routes.'
        )
      } else {
        setError(message)
      }
    }
  }

  async function selectUserAndLoad(nextUserId: string) {
    setUserId(nextUserId)
    setBusy(true)
    setError('')
    try {
      const [context, contextAccess] = await Promise.all([
        getAdminUserContext(nextUserId),
        getAdminUserContexts(nextUserId),
      ])
      setSelectedUserContext(context)
      hydrateContextDraft(context)
      setAssignedContextIds(uniqueTrimmed(contextAccess.contextIds || []))
      setSelectedContextToAdd('')
      onSelectedUserIdChange?.(nextUserId)
      const teamId = await loadTeams(nextUserId)
      if (teamId) {
        await loadMembers(teamId)
      } else {
        setMembers([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load team context')
    } finally {
      setBusy(false)
    }
  }

  async function loadTeams(nextUserId?: string): Promise<string | null> {
    const resolvedUserId = (nextUserId ?? userId).trim()
    if (!resolvedUserId) {
      setTeams([])
      setSelectedTeamId('')
      setMembers([])
      setMemberRoleDrafts({})
      return null
    }

    const data = await getAdminUserTeams(resolvedUserId)
    const nextTeams = Array.isArray(data.items) ? data.items : []
    setTeams(nextTeams)

    const fallbackTeamId =
      data.currentTeamId && nextTeams.some(team => team.id === data.currentTeamId)
        ? data.currentTeamId
        : ''
    const teamIdToUse = fallbackTeamId || nextTeams[0]?.id || ''
    setSelectedTeamId(teamIdToUse)
    setTeamNameDraft(nextTeams.find(team => team.id === teamIdToUse)?.name || '')
    return teamIdToUse || null
  }

  async function loadMembers(teamId?: string): Promise<void> {
    const resolvedTeamId = (teamId ?? selectedTeamId).trim()
    if (!resolvedTeamId) {
      setMembers([])
      setMemberRoleDrafts({})
      return
    }

    const data = await getAdminTeamMembers(resolvedTeamId)
    const nextMembers = Array.isArray(data.items) ? data.items : []
    setMembers(nextMembers)
    setMemberRoleDrafts(
      nextMembers.reduce(
        (acc, member) => ({
          ...acc,
          [member.id]: member.role,
        }),
        {} as Record<string, Role>
      )
    )
  }

  async function loadForUser() {
    await selectUserAndLoad(userId.trim())
  }

  async function saveUserContext() {
    if (!selectedUserContext) return
    const payload: { email: string; channels: AdminUserChannels } = {
      email: emailDraft.trim().toLowerCase(),
      channels: {
        emails: uniqueTrimmed(contactEmailsDraft, true),
        slackUserNames: uniqueTrimmed(slackHandlesDraft),
        telegramIds: uniqueTrimmed(telegramIdsDraft),
      },
    }
    if (!payload.email) {
      setError('Email is required.')
      return
    }

    setBusy(true)
    setError('')
    try {
      const updated = await updateAdminUserContext(selectedUserContext.id, payload)
      setSelectedUserContext(updated)
      hydrateContextDraft(updated)
      showToast('User context updated.', { tone: 'success' })
      await loadUsers(userQuery)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update user context')
    } finally {
      setBusy(false)
    }
  }

  async function saveUserContexts(nextContextIds: string[], successMessage: string) {
    const resolvedUserId = userId.trim()
    if (!resolvedUserId) return
    setBusy(true)
    setError('')
    try {
      const updated = await updateAdminUserContexts(resolvedUserId, uniqueTrimmed(nextContextIds))
      setAssignedContextIds(uniqueTrimmed(updated.contextIds || []))
      setSelectedContextToAdd('')
      showToast(successMessage, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update user context access')
    } finally {
      setBusy(false)
    }
  }

  async function addContextAccess() {
    const nextContextId = selectedContextToAdd.trim()
    if (!nextContextId || assignedContextIds.includes(nextContextId)) return
    await saveUserContexts([...assignedContextIds, nextContextId], 'Context access granted.')
  }

  async function deleteContextAccess(contextId: string) {
    const shouldDelete = await confirm({
      title: 'Remove Context Access',
      message: `Remove access to ${contextId}?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!shouldDelete) return

    await saveUserContexts(
      assignedContextIds.filter(existing => existing !== contextId),
      'Context access removed.'
    )
  }

  function addContactEmail() {
    setContactEmailsDraft(prev => uniqueTrimmed([...prev, newContactEmail], true))
    setNewContactEmail('')
  }

  function addSlackHandle() {
    setSlackHandlesDraft(prev => uniqueTrimmed([...prev, newSlackHandle]))
    setNewSlackHandle('')
  }

  function addTelegramId() {
    setTelegramIdsDraft(prev => uniqueTrimmed([...prev, newTelegramId]))
    setNewTelegramId('')
  }

  function resetUserSelection() {
    setSelectedUserContext(null)
    setUserId('')
    setTeams([])
    setSelectedTeamId('')
    setMembers([])
    setMemberRoleDrafts({})
    setTeamNameDraft('')
    setEmailDraft('')
    setContactEmailsDraft([])
    setSlackHandlesDraft([])
    setTelegramIdsDraft([])
    setNewContactEmail('')
    setNewSlackHandle('')
    setNewTelegramId('')
    setError('')
    setAssignedContextIds([])
    setSelectedContextToAdd('')
    onSelectedUserIdChange?.(null)
  }

  useEffect(() => {
    async function loadReferenceData() {
      await loadUsers('')
      try {
        const data = await getContexts()
        const ids = (data.items || [])
          .map(item => contextIdFromResource(item))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        setAvailableContextIds(ids)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load contexts')
      }
    }

    void loadReferenceData()
  }, [])

  useEffect(() => {
    const nextUserId = initialUserId.trim()
    if (!nextUserId) {
      if (selectedUserContext) {
        resetUserSelection()
      }
      return
    }
    if (selectedUserContext?.id === nextUserId) return
    void selectUserAndLoad(nextUserId)
  }, [initialUserId])

  async function onTeamChange(nextTeamId: string) {
    setSelectedTeamId(nextTeamId)
    setTeamNameDraft(teams.find(team => team.id === nextTeamId)?.name || '')
    setBusy(true)
    setError('')
    try {
      await loadMembers(nextTeamId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load team members')
    } finally {
      setBusy(false)
    }
  }

  async function createTeam() {
    const resolvedUserId = userId.trim()
    const name = newTeamName.trim()
    if (!name) return

    setBusy(true)
    setError('')
    try {
      const created = await createAdminTeam(name)
      setNewTeamName('')
      await loadTeams(resolvedUserId)
      setSelectedTeamId(created.id)
      setTeamNameDraft(created.name)
      await loadMembers(created.id)
      showToast('Team created.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create team')
    } finally {
      setBusy(false)
    }
  }

  async function renameTeam() {
    const teamId = selectedTeamId.trim()
    const name = teamNameDraft.trim()
    if (!teamId || !name) return

    setBusy(true)
    setError('')
    try {
      await renameAdminTeam(teamId, name)
      await loadTeams()
      showToast('Team renamed.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename team')
    } finally {
      setBusy(false)
    }
  }

  async function inviteMember() {
    const teamId = selectedTeamId.trim()
    const name = inviteName.trim()
    const email = inviteEmail.trim().toLowerCase()
    if (!teamId || !name || !email) return

    setBusy(true)
    setError('')
    try {
      await inviteAdminTeamMember(teamId, {
        name,
        email,
        role: inviteRole,
      })
      setInviteName('')
      setInviteEmail('')
      showToast('Invitation created.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create invitation')
    } finally {
      setBusy(false)
    }
  }

  async function updateMemberRole(memberId: string) {
    const teamId = selectedTeamId.trim()
    const nextRole = memberRoleDrafts[memberId]
    if (!teamId || !nextRole) return

    setBusy(true)
    setError('')
    try {
      await updateAdminMemberRole(teamId, memberId, nextRole)
      await loadMembers(teamId)
      showToast('Member role updated.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update member role')
    } finally {
      setBusy(false)
    }
  }

  async function deleteMember(memberId: string) {
    const teamId = selectedTeamId.trim()
    if (!teamId) return
    const shouldDelete = await confirm({
      title: 'Delete Team Member',
      message: 'Delete this team member?',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setBusy(true)
    setError('')
    try {
      await deleteAdminMember(teamId, memberId)
      await loadMembers(teamId)
      showToast('Member removed.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      style={{
        border: '1px solid var(--cu-border)',
        borderRadius: 10,
        padding: 12,
        display: 'grid',
        gap: 12,
      }}
    >
      <h3 style={{ margin: 0 }}>Profile Admin (Team/Member)</h3>
      <div style={{ fontSize: 13, color: 'var(--cu-text-soft)' }}>
        Use explicit selectors. Load a user row to hydrate team context, then manage team members
        and roles.
      </div>

      {!selectedUserContext ? (
        <div
          style={{
            border: '1px solid var(--cu-border)',
            borderRadius: 8,
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <strong>Users</strong>
          <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
            Showing the first 100 users ordered by email.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={userQuery}
              onChange={e => setUserQuery(e.target.value)}
              placeholder="Search by email, name, or display name"
            />
            <button type="button" onClick={() => void loadUsers()} disabled={busy}>
              Search
            </button>
          </div>
          {users.length === 0 ? (
            <div style={{ color: 'var(--cu-text-soft)' }}>No users found for this query.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--cu-border)' }}>
                    <th style={{ padding: '6px 8px' }}>Name</th>
                    <th style={{ padding: '6px 8px' }}>Email</th>
                    <th style={{ padding: '6px 8px' }}>Display Name</th>
                    <th style={{ padding: '6px 8px' }}>Teams</th>
                    <th style={{ padding: '6px 8px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(user => (
                    <tr key={user.id} style={{ borderBottom: '1px solid var(--cu-border-subtle)' }}>
                      <td style={{ padding: '6px 8px' }}>{user.name || '-'}</td>
                      <td style={{ padding: '6px 8px' }}>{user.email}</td>
                      <td style={{ padding: '6px 8px' }}>{user.displayName || '-'}</td>
                      <td style={{ padding: '6px 8px' }}>{user.activeTeamCount}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <button
                          type="button"
                          onClick={() => void selectUserAndLoad(user.id)}
                          disabled={busy}
                        >
                          Load Context
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--cu-border)',
            borderRadius: 8,
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <strong>User Context</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={saveUserContext} disabled={busy || !emailDraft.trim()}>
                Save User
              </button>
              <button type="button" onClick={resetUserSelection} disabled={busy}>
                Back to Users
              </button>
            </div>
          </div>
          <div style={{ fontSize: 13 }}>
            <strong>
              {selectedUserContext.displayName ||
                selectedUserContext.name ||
                selectedUserContext.email}
            </strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
            userId: {selectedUserContext.id}
          </div>
          <div
            style={{
              display: 'grid',
              gap: 6,
              borderTop: '1px solid var(--cu-border-subtle)',
              paddingTop: 8,
            }}
          >
            <label style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>Primary Email</label>
            <input
              value={emailDraft}
              onChange={e => setEmailDraft(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div
            style={{
              display: 'grid',
              gap: 6,
              borderTop: '1px solid var(--cu-border-subtle)',
              paddingTop: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
              <strong>Contact Emails</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={newContactEmail}
                onChange={e => setNewContactEmail(e.target.value)}
                placeholder="Add contact email"
              />
              <button
                type="button"
                onClick={addContactEmail}
                disabled={busy || !newContactEmail.trim()}
              >
                Add
              </button>
            </div>
            {contactEmailsDraft.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>-</div>
            ) : (
              contactEmailsDraft.map(email => (
                <div
                  key={email}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                >
                  <span style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>{email}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setContactEmailsDraft(prev => prev.filter(value => value !== email))
                    }
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
          <div
            style={{
              display: 'grid',
              gap: 6,
              borderTop: '1px solid var(--cu-border-subtle)',
              paddingTop: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
              <strong>Slack Handles</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={newSlackHandle}
                onChange={e => setNewSlackHandle(e.target.value)}
                placeholder="Add slack handle"
              />
              <button
                type="button"
                onClick={addSlackHandle}
                disabled={busy || !newSlackHandle.trim()}
              >
                Add
              </button>
            </div>
            {slackHandlesDraft.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>-</div>
            ) : (
              slackHandlesDraft.map(handle => (
                <div
                  key={handle}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                >
                  <span style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>{handle}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSlackHandlesDraft(prev => prev.filter(value => value !== handle))
                    }
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
          <div
            style={{
              display: 'grid',
              gap: 6,
              borderTop: '1px solid var(--cu-border-subtle)',
              paddingTop: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
              <strong>Telegram IDs</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={newTelegramId}
                onChange={e => setNewTelegramId(e.target.value)}
                placeholder="Add telegram id"
              />
              <button
                type="button"
                onClick={addTelegramId}
                disabled={busy || !newTelegramId.trim()}
              >
                Add
              </button>
            </div>
            {telegramIdsDraft.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>-</div>
            ) : (
              telegramIdsDraft.map(telegramId => (
                <div
                  key={telegramId}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                >
                  <span style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>{telegramId}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setTelegramIdsDraft(prev => prev.filter(value => value !== telegramId))
                    }
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {selectedUserContext && (
        <div style={{ display: 'grid', gap: 6 }}>
          <label style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>Selected userId</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={userId}
              onChange={e => setUserId(e.target.value)}
              placeholder="user UUID"
            />
            <button
              type="button"
              onClick={() => void loadForUser()}
              disabled={busy || !userId.trim()}
            >
              Reload User Context
            </button>
          </div>
        </div>
      )}

      {selectedUserContext && (
        <div style={{ display: 'grid', gap: 6 }}>
          <label style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>Team</label>
          <select
            value={selectedTeamId}
            onChange={e => onTeamChange(e.target.value)}
            disabled={busy || teams.length === 0}
          >
            {teams.length === 0 && <option value="">No teams loaded</option>}
            {teams.map(team => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.role})
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedUserContext && (
        <div
          style={{
            border: '1px solid var(--cu-border)',
            borderRadius: 8,
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <strong>Context Access</strong>
          <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
            Associate this user with contexts that they can access.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              style={{ flex: 1 }}
              value={selectedContextToAdd}
              onChange={e => setSelectedContextToAdd(e.target.value)}
              disabled={busy || availableContextIds.length === 0}
            >
              <option value="">Select context</option>
              {availableContextIds
                .filter(contextId => !assignedContextIds.includes(contextId))
                .map(contextId => (
                  <option key={contextId} value={contextId}>
                    {contextId}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => void addContextAccess()}
              disabled={busy || !selectedContextToAdd}
            >
              Add Access
            </button>
          </div>

          {assignedContextIds.length === 0 ? (
            <div style={{ color: 'var(--cu-text-soft)', fontSize: 12 }}>
              No context access assigned.
            </div>
          ) : (
            assignedContextIds.map(contextId => (
              <div
                key={contextId}
                style={{
                  borderTop: '1px solid var(--cu-border-subtle)',
                  paddingTop: 8,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 13 }}>{contextId}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => router.push(CONTROL_ROUTES.contexts.detail(contextId))}
                    disabled={busy}
                  >
                    Open Context
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteContextAccess(contextId)}
                    disabled={busy}
                  >
                    Delete Access
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {selectedUserContext && (
        <div
          style={{
            border: '1px solid var(--cu-border)',
            borderRadius: 8,
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <strong>Team Settings</strong>
          <input
            value={teamNameDraft}
            onChange={e => setTeamNameDraft(e.target.value)}
            placeholder="Team name"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={renameTeam}
              disabled={busy || !selectedTeamId || !teamNameDraft.trim()}
            >
              Save Team Name
            </button>
            <input
              style={{ flex: 1 }}
              value={newTeamName}
              onChange={e => setNewTeamName(e.target.value)}
              placeholder="New team name"
            />
            <button type="button" onClick={createTeam} disabled={busy || !newTeamName.trim()}>
              Create Team
            </button>
          </div>
        </div>
      )}

      {selectedUserContext && (
        <div
          style={{
            border: '1px solid var(--cu-border)',
            borderRadius: 8,
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <strong>Invite Member</strong>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              placeholder="Invitee name"
            />
            <input
              style={{ flex: 1 }}
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="Invitee email"
            />
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value as InviteRole)}>
              <option value="member">member</option>
              <option value="inviter">inviter</option>
              <option value="admin">admin</option>
            </select>
            <button
              type="button"
              onClick={inviteMember}
              disabled={busy || !inviteName.trim() || !inviteEmail.trim() || !selectedTeamId}
            >
              Invite
            </button>
          </div>
        </div>
      )}

      {selectedUserContext && (
        <div
          style={{
            border: '1px solid var(--cu-border)',
            borderRadius: 8,
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <strong>Team Members {selectedTeam ? `(${selectedTeam.name})` : ''}</strong>
          {members.length === 0 ? (
            <div style={{ color: 'var(--cu-text-soft)' }}>No members found for selected team.</div>
          ) : (
            members.map(member => (
              <div
                key={member.id}
                style={{
                  borderTop: '1px solid var(--cu-border-subtle)',
                  paddingTop: 8,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div>
                    <div>{member.name || member.email}</div>
                    <div style={{ fontSize: 12, color: 'var(--cu-text-soft)' }}>
                      {member.email} | role: {member.role} | status: {member.status || 'active'}
                    </div>
                  </div>
                  <button type="button" onClick={() => deleteMember(member.id)} disabled={busy}>
                    Delete
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={memberRoleDrafts[member.id] || member.role}
                    onChange={e =>
                      setMemberRoleDrafts(prev => ({
                        ...prev,
                        [member.id]: e.target.value as Role,
                      }))
                    }
                  >
                    <option value="admin">admin</option>
                    <option value="inviter">inviter</option>
                    <option value="member">member</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => updateMemberRole(member.id)}
                    disabled={
                      busy ||
                      !memberRoleDrafts[member.id] ||
                      memberRoleDrafts[member.id] === member.role
                    }
                  >
                    Save Role
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {error && <div style={{ color: '#ff8ea7' }}>{error}</div>}
      {confirmDialog}
    </section>
  )
}
