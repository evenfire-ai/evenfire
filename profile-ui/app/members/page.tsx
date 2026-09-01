'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  DataTable,
  RowActionMenu,
  TableHeaderCell,
  TableStateRow,
  useTableSort,
} from '@clerum/frontend-components'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useProfileAccess } from '@components/ProfileAccessContext'
import { ProfileShell } from '@components/ProfileShell'
import { useToast } from '@components/Toast'
import { IconAlertTriangle, IconRefresh, IconTrash } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  cancelManagedInvitation,
  deleteManagedUser,
  getManagedInvitations,
  getManagedMembers,
  isSilentApiError,
  resendManagedInvitation,
} from '@lib/api'
import type { ManagedMember, ManagedPendingInvitation } from '@/app/types/profile'
import { canDeleteMemberAccount, displayMemberName, memberDeleteTooltip } from './memberHelpers'

type LoadState = 'loading' | 'ready' | 'error'

export default function MembersPage() {
  const router = useRouter()
  const { authState } = useAuth()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { manageableTeams, refreshManageableTeams } = useProfileAccess()
  const { showToast } = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [members, setMembers] = useState<ManagedMember[]>([])
  const [invitations, setInvitations] = useState<ManagedPendingInvitation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const currentUserId = authState.me?.id || ''
  const invitationSort = useTableSort<ManagedPendingInvitation, 'email' | 'teams' | 'expires'>({
    rows: invitations,
    defaultKey: 'email' as const,
    identity: invitation => invitation.id,
    accessors: {
      email: (invitation: ManagedPendingInvitation) => invitation.email,
      teams: (invitation: ManagedPendingInvitation) => invitation.teams.length,
      expires: (invitation: ManagedPendingInvitation) => new Date(invitation.expiresAt),
    },
  })
  const memberSort = useTableSort<ManagedMember, 'name' | 'email' | 'teams'>({
    rows: members,
    defaultKey: 'name' as const,
    identity: member => member.id,
    accessors: {
      name: (member: ManagedMember) => displayMemberName(member),
      email: (member: ManagedMember) => member.email,
      teams: (member: ManagedMember) => member.teams.length,
    },
  })

  async function loadMembers(forceAccess = false) {
    setState('loading')
    setError('')
    try {
      const [, membersResponse, invitationsResponse] = await Promise.all([
        refreshManageableTeams({ force: forceAccess }),
        getManagedMembers(),
        getManagedInvitations(),
      ])
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
                onClick={() => void loadMembers(true)}
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

          {error ? <div className="message message--error">{error}</div> : null}

          {state !== 'loading' && manageableTeams.length === 0 ? (
            <div className="message message--plain">
              No member-management permissions available.
            </div>
          ) : null}

          <section className="section members-section">
            <div className="settings-section-head">
              <div>
                <h2 className="section-title">Pending invitations</h2>
              </div>
            </div>
            <div className="eft-table-viewport">
              <DataTable className="eft-table eft-table--wide">
                <thead>
                  <tr>
                    <TableHeaderCell
                      activeDirection={
                        invitationSort.key === 'email' ? invitationSort.direction : null
                      }
                      label="Email"
                      onSort={() => invitationSort.sortBy('email')}
                    />
                    <TableHeaderCell
                      activeDirection={
                        invitationSort.key === 'teams' ? invitationSort.direction : null
                      }
                      label="Teams"
                      onSort={() => invitationSort.sortBy('teams')}
                    />
                    <TableHeaderCell
                      activeDirection={
                        invitationSort.key === 'expires' ? invitationSort.direction : null
                      }
                      label="Expires"
                      onSort={() => invitationSort.sortBy('expires')}
                    />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {state === 'loading' ? (
                    <TableStateRow colSpan={4} kind="loading" message="Loading invitations…" />
                  ) : state === 'error' ? (
                    <TableStateRow colSpan={4} kind="error" message="Invitations unavailable." />
                  ) : invitationSort.sortedRows.length === 0 ? (
                    <TableStateRow colSpan={4} message="No pending invitations." />
                  ) : (
                    invitationSort.sortedRows.map(invitation => (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td>
                        <td>{invitation.teams.map(team => team.name).join(', ')}</td>
                        <td>{new Date(invitation.expiresAt).toLocaleString()}</td>
                        <td className="eft-table__cell--actions">
                          <RowActionMenu
                            ariaLabel={`Actions for invitation ${invitation.email}`}
                            actions={[
                              {
                                key: 'resend',
                                label: 'Resend invitation',
                                disabled: busy || !invitation.canResend,
                                onSelect: () => void resendInvitation(invitation),
                              },
                              {
                                key: 'cancel',
                                label: 'Cancel invitation',
                                danger: true,
                                disabled: busy || !invitation.canCancel,
                                onSelect: () => void cancelInvitation(invitation),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </DataTable>
            </div>
          </section>

          <section className="section members-section">
            <div className="eft-table-viewport">
              <DataTable className="eft-table eft-table--wide">
                <thead>
                  <tr>
                    <TableHeaderCell
                      activeDirection={memberSort.key === 'name' ? memberSort.direction : null}
                      label="Member"
                      onSort={() => memberSort.sortBy('name')}
                    />
                    <TableHeaderCell
                      activeDirection={memberSort.key === 'email' ? memberSort.direction : null}
                      label="Email"
                      onSort={() => memberSort.sortBy('email')}
                    />
                    <TableHeaderCell
                      activeDirection={memberSort.key === 'teams' ? memberSort.direction : null}
                      label="Teams"
                      onSort={() => memberSort.sortBy('teams')}
                    />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {state === 'loading' ? (
                    <TableStateRow colSpan={4} kind="loading" message="Loading members…" />
                  ) : state === 'error' ? (
                    <TableStateRow colSpan={4} kind="error" message="Members unavailable." />
                  ) : memberSort.sortedRows.length === 0 ? (
                    <TableStateRow colSpan={4} message="No members are visible for your teams." />
                  ) : (
                    memberSort.sortedRows.map(member => {
                      const deleteAllowed = canDeleteMemberAccount(member, currentUserId)
                      return (
                        <tr
                          className="eft-table__row--navigable"
                          key={member.id}
                          onClick={() => router.push(PROFILE_ROUTES.members.detail(member.id))}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              router.push(PROFILE_ROUTES.members.detail(member.id))
                            }
                          }}
                          tabIndex={0}
                        >
                          <td>{displayMemberName(member)}</td>
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
                          <td
                            className="eft-table__cell--actions"
                            onClick={event => event.stopPropagation()}
                            onKeyDown={event => event.stopPropagation()}
                          >
                            <RowActionMenu
                              ariaLabel={`Actions for ${displayMemberName(member)}`}
                              actions={[
                                {
                                  key: 'view',
                                  label: 'View details',
                                  onSelect: () =>
                                    router.push(PROFILE_ROUTES.members.detail(member.id)),
                                },
                                {
                                  key: 'delete',
                                  label: 'Delete member',
                                  danger: true,
                                  disabled: busy || !deleteAllowed,
                                  onSelect: () => void deleteMemberAccount(member),
                                },
                              ]}
                            />
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </DataTable>
            </div>
          </section>

          {confirmDialog}
        </div>
      </ProfileShell>
    </AuthGate>
  )
}
