'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { DataTable, RowActionMenu } from '@clerum/frontend-table-system'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { FormField } from '@components/FormField'
import { ProfileBodySkeleton } from '@components/ProfileBodySkeleton'
import { ProfileShell } from '@components/ProfileShell'
import { TextInput } from '@components/TextInput'
import { useToast } from '@components/Toast'
import { IconAlertTriangle, IconRefresh, IconTrash } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  deleteManagedMember,
  deleteManagedUser,
  getManagedMember,
  isSilentApiError,
  updateManagedMemberRole,
} from '@lib/api'
import {
  formatTeamRole,
  permissionsForTeamRole,
  setDeletePermission,
  setInvitePermission,
} from '@lib/teamRoles'
import type { ManagedMember, ManagedMemberTeam, Role } from '@/app/types/profile'
import { canDeleteMemberAccount, displayMemberName, memberDeleteTooltip } from '../memberHelpers'

type LoadState = 'loading' | 'ready' | 'error'

export default function MemberDetailsPage() {
  const params = useParams<{ userId: string }>()
  const router = useRouter()
  const { authState } = useAuth()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const userId = decodeURIComponent(params.userId || '')
  const currentUserId = authState.me?.id || ''
  const [state, setState] = useState<LoadState>('loading')
  const [member, setMember] = useState<ManagedMember | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editTeam, setEditTeam] = useState<ManagedMemberTeam | null>(null)
  const [editRole, setEditRole] = useState<Role>('member')
  const [editError, setEditError] = useState('')

  const memberIsSelf = Boolean(member && member.id === currentUserId)
  const memberHasUncontrolledTeams = Boolean(member?.teams.some(team => !team.canDelete))
  const canDeleteSelectedMember = Boolean(member && canDeleteMemberAccount(member, currentUserId))
  const title = member ? displayMemberName(member) : 'Member'

  const editableTeams = useMemo(
    () => member?.teams.filter(team => team.canEdit || team.canDelete) || [],
    [member]
  )

  async function loadMember() {
    if (!userId) return
    setState('loading')
    setError('')
    try {
      setMember(await getManagedMember(userId))
      setState('ready')
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setState('error')
      setError(nextError instanceof Error ? nextError.message : 'Failed to load member details')
    }
  }

  useEffect(() => {
    void loadMember()
  }, [userId])

  function closeRoleEdit() {
    setEditTeam(null)
    setEditError('')
  }

  async function saveRole() {
    if (!member || !editTeam) return
    setBusy(true)
    setEditError('')
    setError('')
    try {
      await updateManagedMemberRole(member.id, editTeam.id, editRole)
      closeRoleEdit()
      await loadMember()
      showToast('Member permissions updated.', { tone: 'success' })
    } catch (nextError) {
      setEditError(nextError instanceof Error ? nextError.message : 'Failed to update permissions')
    } finally {
      setBusy(false)
    }
  }

  async function removeMemberFromTeam(team: ManagedMemberTeam) {
    if (!member) return
    const confirmed = await confirm({
      title: 'Remove member?',
      message: `Remove ${displayMemberName(member)} from ${team.name}?`,
      confirmLabel: 'Remove member',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      await deleteManagedMember(member.id, team.id)
      await loadMember()
      showToast('Member removed from team.', { tone: 'success' })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to remove member')
    } finally {
      setBusy(false)
    }
  }

  async function deleteMemberAccount() {
    if (!member || !canDeleteMemberAccount(member, currentUserId)) return
    const confirmed = await confirm({
      title: 'Delete member?',
      message: `Delete ${displayMemberName(member)} and remove the account from Evenfire?`,
      confirmLabel: 'Delete member',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      await deleteManagedUser(member.id)
      showToast('Member deleted.', { tone: 'success' })
      router.push(PROFILE_ROUTES.members.root)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to delete member')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthGate>
      <ProfileShell currentRoute="members">
        <div className="profile-page profile-page--members">
          <header className="header-row">
            <div>
              <p className="eyebrow">Member details</p>
              <h1 className="page-title">{title}</h1>
              {member ? (
                <p className="body-copy">
                  <span className="member-email">
                    <span>{member.email}</span>
                    {member.passwordPendingFromAcceptedInvitation ? (
                      <span
                        className="member-email__alert"
                        title="Invitation accepted, but this member still needs to set a password."
                        aria-label="Invitation accepted, password setup pending"
                      >
                        <IconAlertTriangle width={14} height={14} />
                      </span>
                    ) : null}
                  </span>
                </p>
              ) : null}
            </div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="cu-btn--icon cu-btn--toolbar"
                onClick={loadMember}
                disabled={busy || state === 'loading'}
                aria-label={state === 'loading' ? 'Refreshing member' : 'Refresh member'}
              >
                <IconRefresh className={state === 'loading' ? 'cu-spin' : undefined} />
              </Button>
              {member && !memberIsSelf ? (
                <Button
                  variant="danger"
                  onClick={() => void deleteMemberAccount()}
                  disabled={busy || !canDeleteSelectedMember}
                  title={memberDeleteTooltip(member, currentUserId)}
                >
                  Delete member
                </Button>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => router.push(PROFILE_ROUTES.members.root)}
                disabled={busy}
              >
                Back to members
              </Button>
            </div>
          </header>

          {state === 'loading' ? (
            <ProfileBodySkeleton
              label="Loading member details"
              sections={[{ title: 'Teams and permissions', rows: 4 }]}
            />
          ) : null}
          {error ? <div className="message message--error">{error}</div> : null}
          {!memberIsSelf && memberHasUncontrolledTeams ? (
            <div className="message message--warning message--plain">
              You do not control all teams this member belongs to. Use the team rows below to remove
              this member from teams you can manage.
            </div>
          ) : null}

          {state === 'ready' && member ? (
            <section className="section members-section">
              <div className="settings-section-head">
                <div>
                  <h2 className="section-title">Teams and permissions</h2>
                  <p className="body-copy">
                    Review this member's team access within your management scope.
                  </p>
                </div>
              </div>
              <div className="eft-table-viewport members-table-wrap">
                <DataTable className="eft-table members-table">
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
                    {member.teams.map(team => {
                      const permissions = permissionsForTeamRole(team.role)
                      const canViewPermissions =
                        team.managerRole === 'admin' || team.managerRole === 'inviter'
                      if (!canViewPermissions) {
                        return (
                          <tr key={team.id}>
                            <td>{team.name}</td>
                            <td colSpan={4}></td>
                          </tr>
                        )
                      }
                      return (
                        <tr key={team.id}>
                          <td>{team.name}</td>
                          <td>{formatTeamRole(team.role)}</td>
                          <td className="permission-cell">
                            <input
                              type="checkbox"
                              checked={permissions.canInviteMembers}
                              readOnly
                              disabled
                            />
                          </td>
                          <td className="permission-cell">
                            <input
                              type="checkbox"
                              checked={permissions.canDeleteMembers}
                              readOnly
                              disabled
                            />
                          </td>
                          <td className="eft-table__cell--actions">
                            {!memberIsSelf ? (
                              <RowActionMenu
                                ariaLabel={`Actions for team ${team.name}`}
                                actions={[
                                  {
                                    key: 'edit',
                                    label: 'Edit permissions',
                                    disabled: busy || !team.canEdit,
                                    onSelect: () => {
                                      if (!team.canEdit) return
                                      setEditTeam(team)
                                      setEditRole(team.role)
                                      setEditError('')
                                    },
                                  },
                                  {
                                    key: 'remove',
                                    label: 'Remove from team',
                                    danger: true,
                                    disabled: busy || !team.canDelete,
                                    onSelect: () => void removeMemberFromTeam(team),
                                  },
                                ]}
                              />
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                    {member.teams.length === 0 ? (
                      <tr>
                        <td colSpan={5}>No visible active teams.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </DataTable>
              </div>
              {editableTeams.length === 0 && !memberIsSelf ? (
                <p className="body-copy">No editable teams are available for this member.</p>
              ) : null}
            </section>
          ) : null}

          {member && editTeam ? (
            <RoleEditModal
              busy={busy}
              error={editError}
              member={member}
              role={editRole}
              team={editTeam}
              onClose={closeRoleEdit}
              onRoleChange={setEditRole}
              onSubmit={() => void saveRole()}
            />
          ) : null}

          {confirmDialog}
        </div>
      </ProfileShell>
    </AuthGate>
  )
}

function RoleEditModal({
  busy,
  error,
  member,
  role,
  team,
  onClose,
  onRoleChange,
  onSubmit,
}: {
  busy: boolean
  error: string
  member: ManagedMember
  role: Role
  team: ManagedMemberTeam
  onClose: () => void
  onRoleChange: (role: Role) => void
  onSubmit: () => void
}) {
  const permissions = permissionsForTeamRole(role)
  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-member-role-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 id="edit-member-role-title" className="cu-modal-panel__title">
            Edit permissions
          </h3>
          <button type="button" className="cu-btn cu-btn--ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="cu-modal-panel__body">
          <p className="body-copy">
            {displayMemberName(member)} on {team.name}.
          </p>
          <FormField label="Role">
            <TextInput value={formatTeamRole(role)} disabled readOnly />
          </FormField>
          <label className="team-checkbox-list__item">
            <input
              type="checkbox"
              checked={permissions.canInviteMembers}
              onChange={event => onRoleChange(setInvitePermission(role, event.target.checked))}
              disabled={busy}
            />
            <span>Can Invite Members</span>
          </label>
          <label className="team-checkbox-list__item">
            <input
              type="checkbox"
              checked={permissions.canDeleteMembers}
              onChange={event => onRoleChange(setDeletePermission(role, event.target.checked))}
              disabled={busy}
            />
            <span>Can Delete Members</span>
          </label>
          {error ? <div className="message message--error">{error}</div> : null}
        </div>
        <div className="cu-modal-panel__foot">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy}>
            {busy ? 'Saving...' : 'Save permissions'}
          </Button>
        </div>
      </section>
    </div>
  )
}
