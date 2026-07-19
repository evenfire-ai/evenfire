'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { ProfileShell } from '@components/ProfileShell'
import { useToast } from '@components/Toast'
import { IconAlertTriangle, IconRefresh, IconTrash } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  cancelManagedInvitation,
  deleteManagedUser,
  getManageableTeams,
  getManagedInvitations,
  getManagedMembers,
  isSilentApiError,
  resendManagedInvitation,
} from '@lib/api'
import type { ManageableTeam, ManagedMember, ManagedPendingInvitation } from '@/app/types/profile'
import { canDeleteMemberAccount, displayMemberName, memberDeleteTooltip } from './memberHelpers'

type LoadState = 'loading' | 'ready' | 'error'

export default function MembersPage() {
  const router = useRouter()
  const { authState } = useAuth()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [members, setMembers] = useState<ManagedMember[]>([])
  const [invitations, setInvitations] = useState<ManagedPendingInvitation[]>([])
  const [manageableTeams, setManageableTeams] = useState<ManageableTeam[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const currentUserId = authState.me?.id || ''

  async function loadMembers() {
    setState('loading')
    setError('')
    try {
      const [teamsResponse, membersResponse, invitationsResponse] = await Promise.all([
        getManageableTeams(),
        getManagedMembers(),
        getManagedInvitations(),
      ])
      setManageableTeams(Array.isArray(teamsResponse.items) ? teamsResponse.items : [])
      setMembers(Array.isArray(membersResponse.items) ? membersResponse.items : [])
      setInvitations(Array.isArray(invitationsResponse.items) ? invitationsResponse.items : [])
      setState('ready')
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setState('error')
      setError(nextError instanceof Error ? nextError.message : 'Failed to load members')
    }
  }

  useEffect(() => {
    void loadMembers()
  }, [])

  async function deleteMemberAccount(member: ManagedMember) {
    if (!canDeleteMemberAccount(member, currentUserId)) return
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
      await loadMembers()
      showToast('Member deleted.', { tone: 'success' })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to delete member')
    } finally {
      setBusy(false)
    }
  }

  async function resendInvitation(invitation: ManagedPendingInvitation) {
    setBusy(true)
    setError('')
    try {
      await resendManagedInvitation(invitation.id)
      await loadMembers()
      showToast(`Invitation email resent to ${invitation.email}.`, { tone: 'success' })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to resend invitation')
    } finally {
      setBusy(false)
    }
  }

  async function cancelInvitation(invitation: ManagedPendingInvitation) {
    const confirmed = await confirm({
      title: 'Cancel invitation?',
      message: `Cancel the pending invitation for ${invitation.email}?`,
      confirmLabel: 'Cancel invitation',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      await cancelManagedInvitation(invitation.id)
      await loadMembers()
      showToast('Invitation cancelled.', { tone: 'success' })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to cancel invitation')
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
              <h1 className="page-title">Members</h1>
            </div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="cu-btn--icon cu-btn--toolbar"
                onClick={loadMembers}
                disabled={busy || state === 'loading'}
                aria-label={state === 'loading' ? 'Refreshing members' : 'Refresh members'}
              >
                <IconRefresh className={state === 'loading' ? 'cu-spin' : undefined} />
              </Button>
              <Button
                onClick={() => router.push(PROFILE_ROUTES.members.invite)}
                disabled={busy || manageableTeams.length === 0}
              >
                Invite member
              </Button>
            </div>
          </header>

          {state === 'loading' ? <div className="message message--plain">Loading...</div> : null}
          {error ? <div className="message message--error">{error}</div> : null}

          {state !== 'loading' && manageableTeams.length === 0 ? (
            <div className="message message--plain">
              No member-management permissions available.
            </div>
          ) : null}

          {state === 'ready' && invitations.length > 0 ? (
            <section className="section members-section">
              <div className="settings-section-head">
                <div>
                  <h2 className="section-title">Pending invitations</h2>
                </div>
              </div>
              <div className="members-table-wrap">
                <table className="members-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Teams</th>
                      <th>Expires</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map(invitation => (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td>
                        <td>{invitation.teams.map(team => team.name).join(', ')}</td>
                        <td>{new Date(invitation.expiresAt).toLocaleString()}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => void resendInvitation(invitation)}
                              disabled={busy || !invitation.canResend}
                              title={
                                invitation.canResend
                                  ? 'Resend invitation'
                                  : 'You can only resend invitations for teams you can invite to.'
                              }
                            >
                              Resend
                            </button>
                            <button
                              type="button"
                              className="icon-button icon-button--danger"
                              onClick={() => void cancelInvitation(invitation)}
                              disabled={busy || !invitation.canCancel}
                              title={
                                invitation.canCancel
                                  ? 'Cancel invitation'
                                  : 'You can only cancel invitations for teams you can invite to.'
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="section members-section">
            <div className="members-table-wrap">
              <table className="members-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Email</th>
                    <th>Teams</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map(member => {
                    const deleteAllowed = canDeleteMemberAccount(member, currentUserId)
                    return (
                      <tr key={member.id}>
                        <td>
                          <button
                            type="button"
                            className="table-link"
                            onClick={() => router.push(PROFILE_ROUTES.members.detail(member.id))}
                          >
                            {displayMemberName(member)}
                          </button>
                        </td>
                        <td>
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
                        </td>
                        <td>{member.teams.length}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="icon-button icon-button--danger"
                              onClick={() => void deleteMemberAccount(member)}
                              disabled={busy || !deleteAllowed}
                              title={memberDeleteTooltip(member, currentUserId)}
                              aria-label={`Delete ${displayMemberName(member)}`}
                            >
                              <IconTrash />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {state === 'ready' && members.length === 0 ? (
                    <tr>
                      <td colSpan={4}>No members are visible for your teams.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {confirmDialog}
        </div>
      </ProfileShell>
    </AuthGate>
  )
}
