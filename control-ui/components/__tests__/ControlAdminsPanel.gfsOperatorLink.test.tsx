import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  getControlAdmins,
  reactivateControlAdminGfsOperatorLink,
  revokeControlAdminGfsOperatorLink,
} from '@lib/api'
import { ControlAdminsPanel } from '../ControlAdminsPanel'

const confirmMock = vi.hoisted(() => vi.fn())
const showToastMock = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      id: 'admin-1',
      isLoggedIn: true,
      isLoading: false,
      username: 'initial-admin',
      email: 'admin@example.com',
    },
  }),
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, confirmDialog: null }),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: showToastMock }),
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    getControlAdmins: vi.fn(),
    reactivateControlAdminGfsOperatorLink: vi.fn(),
    revokeControlAdminGfsOperatorLink: vi.fn(),
  }
})

const LINK = {
  desktopUserId: '11111111-1111-4111-8111-111111111111',
  controlAdminId: 'admin-1',
  source: 'initial_setup' as const,
  createdAt: '2026-08-10T12:00:00.000Z',
  status: 'active' as const,
  generation: 1,
  rowVersion: 1,
  revocationReason: null,
}

describe('ControlAdminsPanel GFS operator link lifecycle', () => {
  beforeEach(() => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(getControlAdmins).mockResolvedValue({
      admins: [
        {
          id: 'admin-1',
          username: 'initial-admin',
          email: 'admin@example.com',
          memberId: LINK.desktopUserId,
          status: 'active',
          gfsOperatorLink: LINK,
          gfsOperatorLinkStatus: 'active',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })
    vi.mocked(revokeControlAdminGfsOperatorLink).mockResolvedValue({
      revoked: true,
      gfsOperatorLinkStatus: 'revoked',
      controlAdminId: 'admin-1',
      desktopUserId: LINK.desktopUserId,
      generation: 1,
      rowVersion: 2,
    })
    vi.mocked(reactivateControlAdminGfsOperatorLink).mockResolvedValue({
      reactivated: true,
      gfsOperatorLinkStatus: 'active',
      controlAdminId: 'admin-1',
      desktopUserId: LINK.desktopUserId,
      generation: 2,
      rowVersion: 1,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the exact pair and revokes only GFS operator access after confirmation', async () => {
    render(<ControlAdminsPanel />)

    await screen.findByText(`Desktop user: ${LINK.desktopUserId}`)
    expect(screen.getByText(`Control Admin: ${LINK.controlAdminId}`)).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Revoke Desktop GFS operator access for initial-admin (admin@example.com)',
      })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revoke Desktop GFS operator access for initial-admin (admin@example.com)',
      })
    )

    await waitFor(() =>
      expect(revokeControlAdminGfsOperatorLink).toHaveBeenCalledWith('admin-1', {
        rowVersion: 1,
        reason: 'control_ui_revoke',
      })
    )
    expect(showToastMock).toHaveBeenCalledWith('Desktop GFS operator access revoked.', {
      tone: 'success',
    })
    expect(screen.getByTestId('gfs-operator-link-admin-1')).toHaveTextContent('Revoked')
  })

  it('does not call the revoke API when confirmation is declined', async () => {
    confirmMock.mockResolvedValueOnce(false)
    render(<ControlAdminsPanel />)

    const revokeButton = await screen.findByRole('button', {
      name: 'Revoke Desktop GFS operator access for initial-admin (admin@example.com)',
    })
    fireEvent.click(revokeButton)

    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(revokeControlAdminGfsOperatorLink).not.toHaveBeenCalled()
  })

  it('reactivates a retained revoked generation through the visible Control UI action', async () => {
    vi.mocked(getControlAdmins).mockResolvedValueOnce({
      admins: [
        {
          id: 'admin-1',
          username: 'initial-admin',
          email: 'admin@example.com',
          memberId: LINK.desktopUserId,
          status: 'active',
          gfsOperatorLink: { ...LINK, status: 'revoked', rowVersion: 2 },
          gfsOperatorLinkStatus: 'revoked',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })

    render(<ControlAdminsPanel />)
    const reactivateButton = await screen.findByRole('button', {
      name: 'Reactivate Desktop GFS operator access for initial-admin (admin@example.com)',
    })
    fireEvent.click(reactivateButton)

    await waitFor(() =>
      expect(reactivateControlAdminGfsOperatorLink).toHaveBeenCalledWith('admin-1', {
        rowVersion: 2,
        reason: 'control_ui_reactivate',
      })
    )
    expect(showToastMock).toHaveBeenCalledWith('Desktop GFS operator access reactivated.', {
      tone: 'success',
    })
    expect(screen.getByTestId('gfs-operator-link-admin-1')).toHaveTextContent('Active')
  })
})
