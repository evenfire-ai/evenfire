'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { IconX } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import { getControlAdminBridgeStatus } from '@lib/api'
import type { ControlAdminBridgeStatus } from '@lib/api'
import type { AdminBridgeAlertKind, AdminBridgeAlertState } from './types'

const ALERT_STORAGE_PREFIX = 'control-admin-bridge-alert'
const REMIND_LATER_MS = 4 * 60 * 60 * 1000

function storageKey(kind: AdminBridgeAlertKind, adminId: string, suffix: 'dismissed' | 'snooze') {
  return `${ALERT_STORAGE_PREFIX}:${adminId}:${kind}:${suffix}`
}

export function resetControlAdminBridgeAlerts() {
  if (typeof window === 'undefined') return
  Object.keys(window.localStorage)
    .filter(key => key.startsWith(`${ALERT_STORAGE_PREFIX}:`))
    .forEach(key => window.localStorage.removeItem(key))
  window.dispatchEvent(new Event('control-admin-bridge-alerts-reset'))
}

export function hasControlAdminBridgeAlertOverrides() {
  if (typeof window === 'undefined') return false
  return Object.keys(window.localStorage).some(key => key.startsWith(`${ALERT_STORAGE_PREFIX}:`))
}

function isSuppressed(kind: AdminBridgeAlertKind, adminId: string): boolean {
  if (typeof window === 'undefined') return true
  if (window.localStorage.getItem(storageKey(kind, adminId, 'dismissed')) === 'true') return true
  const snoozeUntil = Number(window.localStorage.getItem(storageKey(kind, adminId, 'snooze')) || 0)
  return Number.isFinite(snoozeUntil) && snoozeUntil > Date.now()
}

function chooseAlert(status: ControlAdminBridgeStatus): AdminBridgeAlertState | null {
  if (!status.admin.email || status.admin.pendingEmailChange) {
    return { kind: 'email', status }
  }
  if (!status.member) return { kind: 'member', status }
  return null
}

export function AdminBridgeAlerts() {
  const router = useRouter()
  const { authState } = useAuth()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [alert, setAlert] = useState<AdminBridgeAlertState | null>(null)

  const load = useCallback(async () => {
    if (!authState.isLoggedIn || authState.isLoading || !authState.id) {
      setAlert(null)
      return
    }
    try {
      const status = await getControlAdminBridgeStatus()
      const nextAlert = chooseAlert(status)
      if (!nextAlert || isSuppressed(nextAlert.kind, status.admin.id)) {
        setAlert(null)
        return
      }
      setAlert(nextAlert)
    } catch {
      setAlert(null)
    }
  }, [authState.id, authState.isLoading, authState.isLoggedIn])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    function handleReset() {
      void load()
    }
    window.addEventListener('control-admin-bridge-alerts-reset', handleReset)
    return () => window.removeEventListener('control-admin-bridge-alerts-reset', handleReset)
  }, [load])

  const copy = useMemo(() => {
    if (!alert) return null
    if (alert.kind === 'email') {
      const pendingEmail = alert.status.admin.pendingEmailChange?.email
      return {
        title: pendingEmail ? 'Confirm your admin email' : 'Set up your admin email',
        message: pendingEmail
          ? `Confirm ${pendingEmail} so you can recover access to this admin account.`
          : 'Add an email to this admin account so you can recover access if you lose your password.',
        primaryLabel: pendingEmail ? 'Review email' : 'Setup Email',
      }
    }
    return {
      title: 'Create Desktop App access',
      message:
        'This admin does not have a matching member account yet. Create one to access the Desktop App with the same email.',
      primaryLabel: 'Create Member',
    }
  }, [alert])

  if (!alert || !copy) return confirmDialog

  function closeAlert() {
    setAlert(null)
  }

  function remindLater() {
    window.localStorage.setItem(
      storageKey(alert.kind, alert.status.admin.id, 'snooze'),
      String(Date.now() + REMIND_LATER_MS)
    )
    window.dispatchEvent(new Event('control-admin-bridge-alerts-changed'))
    closeAlert()
  }

  async function dontShowAgain() {
    const confirmed = await confirm({
      title: 'Hide this alert?',
      message:
        alert.kind === 'email'
          ? 'Without a confirmed email, you may lose access to this admin account if you forget the password. Hide this alert anyway?'
          : 'Without a matching member account, this admin will not have Desktop App access. Hide this alert anyway?',
      confirmLabel: "Don't show again",
      tone: 'danger',
    })
    if (!confirmed) return
    window.localStorage.setItem(storageKey(alert.kind, alert.status.admin.id, 'dismissed'), 'true')
    window.dispatchEvent(new Event('control-admin-bridge-alerts-changed'))
    closeAlert()
  }

  function primaryAction() {
    if (alert.kind === 'email') {
      router.push(
        alert.status.admin.pendingEmailChange
          ? CONTROL_ROUTES.settings.account
          : CONTROL_ROUTES.settings.accountWith({ focus: 'email' })
      )
      closeAlert()
      return
    }
    const email = alert.status.admin.email
    if (!email) return
    window.sessionStorage.setItem(
      `control-admin-member-reuse-password:${alert.status.admin.id}`,
      'true'
    )
    const searchParams = new URLSearchParams({
      adminId: alert.status.admin.id,
      email,
      name: alert.status.admin.username,
    })
    router.push(CONTROL_ROUTES.usersAndTeams.newUser(Object.fromEntries(searchParams)))
    closeAlert()
  }

  return (
    <>
      <aside className="cu-account-alert" role="status" aria-live="polite">
        <button
          type="button"
          className="cu-account-alert__close"
          onClick={closeAlert}
          aria-label="Close account alert"
        >
          <IconX width={16} height={16} />
        </button>
        <strong className="cu-account-alert__title">{copy.title}</strong>
        <p className="cu-account-alert__message">{copy.message}</p>
        <div className="cu-account-alert__actions">
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={primaryAction}
          >
            {copy.primaryLabel}
          </button>
          <button type="button" className="cu-btn cu-btn--ghost cu-btn--sm" onClick={remindLater}>
            Remind me later
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            onClick={() => void dontShowAgain()}
          >
            Don't show again
          </button>
        </div>
      </aside>
      {confirmDialog}
    </>
  )
}
