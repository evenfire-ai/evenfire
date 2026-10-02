import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ControlAdminBridgeStatus } from '../../lib/api'
import { AdminBridgeAlerts, resetControlAdminBridgeAlerts } from '../AdminBridgeAlerts'

const pushMock = vi.fn()
const bridgeStatusMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getControlAdminBridgeStatus: () => bridgeStatusMock() as Promise<ControlAdminBridgeStatus>,
  }
})

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState: { id: 'admin-1', isLoggedIn: true, isLoading: false, username: 'admin', email: '' },
  }),
}))

const SNOOZE_KEY = 'control-admin-bridge-alert:admin-1:email:snooze'
const DISMISSED_KEY = 'control-admin-bridge-alert:admin-1:email:dismissed'
const REMIND_LATER_MS = 4 * 60 * 60 * 1000

function emailPendingStatus(): ControlAdminBridgeStatus {
  return {
    admin: {
      id: 'admin-1',
      username: 'admin',
      email: null,
      emailConfirmed: false,
      pendingEmailChange: null,
    },
    member: { id: 'member-1', email: 'admin@example.com' },
  }
}

function renderAlerts() {
  return render(<AdminBridgeAlerts />)
}

async function renderAndWaitForBanner() {
  const view = renderAlerts()
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Set up your admin email')
  )
  return view
}

describe('AdminBridgeAlerts dismissal persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    bridgeStatusMock.mockResolvedValue(emailPendingStatus())
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.useRealTimers()
  })

  it('shows the admin email setup banner when no email is set', async () => {
    await renderAndWaitForBanner()
    expect(screen.getByText('Set up your admin email')).toBeVisible()
  })

  it('persists the X-button dismissal across remounts via the snooze key', async () => {
    const view = await renderAndWaitForBanner()

    fireEvent.click(screen.getByRole('button', { name: 'Close account alert' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())

    const snoozeUntil = Number(window.localStorage.getItem(SNOOZE_KEY))
    expect(Number.isFinite(snoozeUntil)).toBe(true)
    expect(snoozeUntil).toBeGreaterThan(Date.now())

    view.unmount()
    renderAlerts()
    await waitFor(() => expect(bridgeStatusMock).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('Set up your admin email')).toBeNull()
  })

  it('snoozes for the remind-later window and resurfaces after it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T08:00:00Z'))
    const view = await renderAndWaitForBanner()

    fireEvent.click(screen.getByRole('button', { name: 'Remind me later', exact: true }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(Number(window.localStorage.getItem(SNOOZE_KEY))).toBe(Date.now() + REMIND_LATER_MS)

    view.unmount()
    renderAlerts()
    await waitFor(() => expect(bridgeStatusMock).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByText('Set up your admin email')).toBeNull()

    vi.setSystemTime(new Date('2026-01-01T13:00:01Z'))
    const second = renderAlerts()
    await waitFor(() => expect(bridgeStatusMock).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Set up your admin email')
    )
    second.unmount()
  })

  it('keeps the banner hidden permanently after confirming do-not-show-again', async () => {
    await renderAndWaitForBanner()

    fireEvent.click(screen.getByRole('button', { name: "Don't show again" }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: "Don't show again" }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe('true')

    cleanup()
    renderAlerts()
    await waitFor(() => expect(bridgeStatusMock).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByText('Set up your admin email')).toBeNull()
  })

  it('clears overrides and shows the banner again after a reset event', async () => {
    const view = await renderAndWaitForBanner()
    fireEvent.click(screen.getByRole('button', { name: 'Close account alert' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    view.unmount()

    const second = renderAlerts()
    await waitFor(() => expect(bridgeStatusMock).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByText('Set up your admin email')).toBeNull()

    resetControlAdminBridgeAlerts()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Set up your admin email')
    )
    second.unmount()
  })
})
