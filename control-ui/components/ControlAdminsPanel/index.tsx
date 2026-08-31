'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataTable } from '@clerum/frontend-table-system'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { IconUsers } from '@components/Sidebar/icons'
import { SkeletonTableRows } from '@components/SkeletonTableRows'
import { useToast } from '@components/Toast'
import { IconAlertTriangle, IconTrash } from '@components/icons'
import { Button } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type ControlAdminInvitationItem,
  type ControlAdminListItem,
  cancelControlAdminInvitation,
  deleteControlAdmin,
  getControlAdmins,
  reactivateControlAdminGfsOperatorLink,
  revokeControlAdminGfsOperatorLink,
} from '@lib/api'
import type { ControlAdminsPanelProps } from './types'

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Never'
  return new Date(value).toLocaleString()
}

function formatAdminStatus(status: ControlAdminListItem['status']): string {
  if (status === 'pending_password') return 'Password pending'
  return status
}

function memberAccessActionLabel(admin: ControlAdminListItem): string {
  if (admin.memberId) return 'View member'
  if (!admin.email) return 'Email required to create member'
  if (admin.passwordPending) return 'Complete password setup to create member'
  return 'Create member'
}

export function ControlAdminsPanel({
  highlightedAdminId = '',
  onCountsChange,
  searchInput = '',
  refreshKey = 0,
  onLoadingChange,
}: ControlAdminsPanelProps) {
  const router = useRouter()
  const { authState } = useAuth()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [admins, setAdmins] = useState<ControlAdminListItem[]>([])
  const [invitations, setInvitations] = useState<ControlAdminInvitationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [cancellingInvitationId, setCancellingInvitationId] = useState<string | null>(null)
  const [deletingAdminId, setDeletingAdminId] = useState<string | null>(null)
  const [revokingGfsLinkAdminId, setRevokingGfsLinkAdminId] = useState<string | null>(null)
  const [reactivatingGfsLinkAdminId, setReactivatingGfsLinkAdminId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const normalizedSearch = searchInput.trim().toLowerCase()

  function isCurrentAdmin(admin: ControlAdminListItem): boolean {
    if (authState.id) return admin.id === authState.id
    if (authState.email && admin.email) {
      return admin.email.toLowerCase() === authState.email.toLowerCase()
    }
    return Boolean(authState.username && admin.username === authState.username)
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      onLoadingChange?.(true)
      setError('')
      try {
        const response = await getControlAdmins()
        if (!cancelled) {
          setAdmins(response.admins)
          setInvitations(response.invitations)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load admins')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          onLoadingChange?.(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [onLoadingChange, refreshKey])

  useEffect(() => {
    if (loading) return
    onCountsChange?.({ admins: admins.length, invitations: invitations.length })
  }, [admins.length, invitations.length, loading, onCountsChange])

  const filteredInvitations = useMemo(() => {
    if (!normalizedSearch) return invitations
    return invitations.filter(invitation =>
      [invitation.email, invitation.status]
        .filter((value): value is string => typeof value === 'string')
        .some(value => value.toLowerCase().includes(normalizedSearch))
    )
  }, [invitations, normalizedSearch])

  const filteredAdmins = useMemo(() => {
    // Disabled admins are retained for audit/lifecycle history, but they are
    // not part of the operational admin list. Keeping them here would make a
    // refresh re-expose Delete, member-access, and GFS-reactivation actions
    // that the server correctly refuses after retirement.
    const operationalAdmins = admins.filter(admin => admin.status !== 'disabled')
    if (!normalizedSearch) return operationalAdmins
    return operationalAdmins.filter(admin =>
      [admin.username, admin.email, admin.status]
        .filter((value): value is string => typeof value === 'string')
        .some(value => value.toLowerCase().includes(normalizedSearch))
    )
  }, [admins, normalizedSearch])

  async function handleCancelInvitation(invitation: ControlAdminInvitationItem) {
    const shouldCancel = await confirm({
      title: 'Cancel admin invitation',
      message: `Cancel the pending admin invitation for ${invitation.email}? The emailed link will stop working.`,
      confirmLabel: 'Cancel invitation',
      tone: 'danger',
    })
    if (!shouldCancel) return

    setCancellingInvitationId(invitation.id)
    setError('')
    try {
      await cancelControlAdminInvitation(invitation.id)
      setInvitations(current => current.filter(item => item.id !== invitation.id))
      showToast('Admin invitation canceled.', { tone: 'success' })
    } catch (cancelError) {
      setError(
        cancelError instanceof Error ? cancelError.message : 'Failed to cancel admin invitation'
      )
    } finally {
      setCancellingInvitationId(null)
    }
  }

  async function handleDeleteAdmin(admin: ControlAdminListItem) {
    if (admin.passwordPending && admin.invitationId) {
      const shouldCancel = await confirm({
        title: 'Cancel admin setup',
        message: `Cancel the accepted admin invitation for ${admin.email}? The invite link will stop working.`,
        confirmLabel: 'Cancel setup',
        tone: 'danger',
      })
      if (!shouldCancel) return

      setDeletingAdminId(admin.id)
      setError('')
      try {
        await cancelControlAdminInvitation(admin.invitationId)
        setAdmins(current => current.filter(item => item.id !== admin.id))
        showToast('Admin setup canceled.', { tone: 'success' })
      } catch (cancelError) {
        setError(
          cancelError instanceof Error ? cancelError.message : 'Failed to cancel admin setup'
        )
      } finally {
        setDeletingAdminId(null)
      }
      return
    }

    const label = admin.email ? `${admin.username} (${admin.email})` : admin.username
    const shouldDelete = await confirm({
      title: 'Delete Control UI admin',
      message: `Delete ${label}? This action is irreversible and removes their Control UI access immediately.`,
      confirmLabel: 'Delete admin',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeletingAdminId(admin.id)
    setError('')
    try {
      await deleteControlAdmin(admin.id)
      setAdmins(current => current.filter(item => item.id !== admin.id))
      showToast('Admin deleted.', { tone: 'success' })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete admin')
    } finally {
      setDeletingAdminId(null)
    }
  }

  async function handleRevokeGfsOperatorLink(admin: ControlAdminListItem) {
    const label = admin.email ? `${admin.username} (${admin.email})` : admin.username
    const shouldRevoke = await confirm({
      title: 'Revoke Desktop GFS operator access',
      message: `Revoke Desktop GFS operator access for ${label}? The Control Admin, both passwords, and unrelated Control Plane access will remain unchanged.`,
      confirmLabel: 'Revoke access',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setRevokingGfsLinkAdminId(admin.id)
    setError('')
    try {
      const link = admin.gfsOperatorLink
      if (!link || link.status !== 'active' || !Number.isInteger(link.rowVersion)) {
        throw new Error('The current GFS operator-link version is unavailable; refresh and retry.')
      }
      const result = await revokeControlAdminGfsOperatorLink(admin.id, {
        rowVersion: link.rowVersion,
        reason: 'control_ui_revoke',
      })
      setAdmins(current =>
        current.map(item =>
          item.id === admin.id
            ? {
                ...item,
                gfsOperatorLink: item.gfsOperatorLink
                  ? {
                      ...item.gfsOperatorLink,
                      status: 'revoked',
                      rowVersion:
                        result.rowVersion ?? Number(item.gfsOperatorLink.rowVersion ?? 0) + 1,
                    }
                  : null,
                gfsOperatorLinkStatus: 'revoked',
              }
            : item
        )
      )
      showToast(
        result.revoked
          ? 'Desktop GFS operator access revoked.'
          : 'Desktop GFS operator access was already revoked.',
        { tone: 'success' }
      )
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : 'Failed to revoke Desktop GFS operator access'
      )
    } finally {
      setRevokingGfsLinkAdminId(null)
    }
  }

  async function handleReactivateGfsOperatorLink(admin: ControlAdminListItem) {
    const label = admin.email ? `${admin.username} (${admin.email})` : admin.username
    const shouldReactivate = await confirm({
      title: 'Reactivate Desktop GFS operator access',
      message: `Reactivate Desktop GFS operator access for ${label}? This creates a new audited link generation without changing passwords or unrelated access.`,
      confirmLabel: 'Reactivate access',
      tone: 'default',
    })
    if (!shouldReactivate) return

    const link = admin.gfsOperatorLink
    if (!link || link.status !== 'revoked' || !Number.isInteger(link.rowVersion)) {
      setError('The revoked GFS operator-link version is unavailable; refresh and retry.')
      return
    }
    setReactivatingGfsLinkAdminId(admin.id)
    setError('')
    try {
      const result = await reactivateControlAdminGfsOperatorLink(admin.id, {
        rowVersion: link.rowVersion,
        reason: 'control_ui_reactivate',
      })
      setAdmins(current =>
        current.map(item =>
          item.id === admin.id
            ? {
                ...item,
                gfsOperatorLink: item.gfsOperatorLink
                  ? {
                      ...item.gfsOperatorLink,
                      status: result.gfsOperatorLinkStatus === 'active' ? 'active' : 'revoked',
                      generation: result.generation ?? item.gfsOperatorLink.generation,
                      rowVersion: result.rowVersion ?? item.gfsOperatorLink.rowVersion,
                    }
                  : null,
                gfsOperatorLinkStatus: result.gfsOperatorLinkStatus,
              }
            : item
        )
      )
      showToast(
        result.reactivated
          ? 'Desktop GFS operator access reactivated.'
          : 'Desktop GFS operator access remains revoked.',
        { tone: 'success' }
      )
    } catch (reactivateError) {
      setError(
        reactivateError instanceof Error
          ? reactivateError.message
          : 'Failed to reactivate Desktop GFS operator access'
      )
    } finally {
      setReactivatingGfsLinkAdminId(null)
    }
  }

  function openMemberAccess(admin: ControlAdminListItem) {
    if (admin.memberId) {
      router.push(CONTROL_ROUTES.usersAndTeams.user(admin.memberId))
      return
    }
    if (!admin.email || admin.passwordPending) return
    const searchParams = new URLSearchParams({
      adminId: admin.id,
      email: admin.email,
      name: admin.username,
    })
    router.push(CONTROL_ROUTES.usersAndTeams.newUser(Object.fromEntries(searchParams)))
  }

  return (
    <div className="cu-profile-section">
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      {loading || filteredInvitations.length > 0 ? (
        <div className="eft-table-viewport cu-table-wrap cu-table-wrap--border-top">
          <DataTable className="eft-table cu-table cu-table--header-band">
            <thead>
              <tr>
                <th>Pending invitation</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows columns={5} rows={2} />
              ) : (
                filteredInvitations.map(invitation => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{invitation.status}</td>
                    <td>{formatDate(invitation.expiresAt)}</td>
                    <td>{formatDate(invitation.createdAt)}</td>
                    <td className="cu-table__cell-actions">
                      <div className="cu-row-actions">
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={cancellingInvitationId === invitation.id}
                          onClick={() => void handleCancelInvitation(invitation)}
                        >
                          {cancellingInvitationId === invitation.id ? 'Canceling...' : 'Cancel'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      ) : null}
      <div className="eft-table-viewport cu-table-wrap cu-table-wrap--border-top">
        <DataTable className="eft-table cu-table cu-table--header-band">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Status</th>
              <th>Desktop GFS access</th>
              <th>Last sign-in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={6} rows={5} />
            ) : filteredAdmins.length > 0 ? (
              filteredAdmins.map(admin => {
                const currentAdmin = isCurrentAdmin(admin)
                const label = admin.email ? `${admin.username} (${admin.email})` : admin.username
                const memberCreationUnavailable = !admin.email || admin.passwordPending
                const memberAccessDisabled = !admin.memberId && memberCreationUnavailable
                const canCreateMember = !admin.memberId && !memberCreationUnavailable
                const memberAccessAction = memberAccessActionLabel(admin)
                const memberAccessLabel = `${memberAccessAction} for admin ${label}`
                return (
                  <tr
                    key={admin.id}
                    data-highlighted={admin.id === highlightedAdminId ? 'true' : undefined}
                  >
                    <td>
                      <span className="cu-member-email">
                        <span>{admin.username}</span>
                        {admin.passwordPending ? (
                          <span
                            className="cu-member-email__alert"
                            title="Invitation accepted, but this admin still needs to set a password."
                            aria-label="Invitation accepted, password setup pending"
                          >
                            <IconAlertTriangle width={14} height={14} />
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>{admin.email || 'No email set'}</td>
                    <td>{formatAdminStatus(admin.status)}</td>
                    <td>
                      {admin.gfsOperatorLink ? (
                        <div data-testid={`gfs-operator-link-${admin.id}`}>
                          <div>
                            {admin.gfsOperatorLink.status === 'active'
                              ? 'Active'
                              : admin.gfsOperatorLink.status === 'inactive_admin'
                                ? 'Inactive admin'
                                : admin.gfsOperatorLink.status === 'revoked'
                                  ? 'Revoked'
                                  : 'Error'}
                          </div>
                          <div className="cu-table__cell-muted">
                            Desktop user: {admin.gfsOperatorLink.desktopUserId}
                          </div>
                          <div className="cu-table__cell-muted">
                            Control Admin: {admin.gfsOperatorLink.controlAdminId}
                          </div>
                          <div className="cu-table__cell-muted">
                            Source: {admin.gfsOperatorLink.source}
                          </div>
                          <div className="cu-table__cell-muted">
                            Generation: {admin.gfsOperatorLink.generation ?? 'Unknown'}
                          </div>
                        </div>
                      ) : (
                        <span data-testid={`gfs-operator-link-${admin.id}`}>Not linked</span>
                      )}
                    </td>
                    <td>{formatDate(admin.lastLoginAt)}</td>
                    <td className="cu-table__cell-actions">
                      <div className="cu-row-actions cu-row-actions--nowrap">
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--toolbar"
                          disabled={memberAccessDisabled}
                          onClick={() => openMemberAccess(admin)}
                          aria-label={memberAccessLabel}
                          title={memberAccessAction}
                        >
                          <IconUsers createBadge={canCreateMember} relationshipRole="member" />
                        </button>
                        {admin.gfsOperatorLink?.status === 'active' ? (
                          <button
                            type="button"
                            className="cu-btn cu-btn--danger"
                            disabled={revokingGfsLinkAdminId === admin.id}
                            onClick={() => void handleRevokeGfsOperatorLink(admin)}
                            aria-label={
                              revokingGfsLinkAdminId === admin.id
                                ? `Revoking Desktop GFS operator access for ${label}`
                                : `Revoke Desktop GFS operator access for ${label}`
                            }
                            title="Remove only GFS operator authority; keep the admin and passwords"
                          >
                            {revokingGfsLinkAdminId === admin.id ? 'Revoking...' : 'Revoke GFS'}
                          </button>
                        ) : null}
                        {admin.gfsOperatorLink?.status === 'revoked' ? (
                          <button
                            type="button"
                            className="cu-btn"
                            disabled={reactivatingGfsLinkAdminId === admin.id}
                            onClick={() => void handleReactivateGfsOperatorLink(admin)}
                            aria-label={
                              reactivatingGfsLinkAdminId === admin.id
                                ? `Reactivating Desktop GFS operator access for ${label}`
                                : `Reactivate Desktop GFS operator access for ${label}`
                            }
                            title="Create a new audited GFS operator-link generation"
                          >
                            {reactivatingGfsLinkAdminId === admin.id
                              ? 'Reactivating...'
                              : 'Reactivate GFS'}
                          </button>
                        ) : null}
                        {currentAdmin ? (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            disabled
                            aria-label="Current admin cannot be deleted"
                            title="Current admin"
                          >
                            <IconTrash width={16} height={16} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            disabled={deletingAdminId === admin.id}
                            onClick={() => void handleDeleteAdmin(admin)}
                            aria-label={
                              deletingAdminId === admin.id
                                ? `Deleting admin ${label}`
                                : `Delete admin ${label}`
                            }
                            title={
                              admin.passwordPending
                                ? deletingAdminId === admin.id
                                  ? 'Canceling setup...'
                                  : 'Cancel admin setup'
                                : deletingAdminId === admin.id
                                  ? 'Deleting...'
                                  : 'Delete admin'
                            }
                          >
                            <IconTrash width={16} height={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={6}>
                  {normalizedSearch ? 'No admins match this search.' : 'No admins found.'}
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      </div>
      {confirmDialog}
    </div>
  )
}
