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
const mockPush = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
    mockPush.mockClear()
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
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Actions for initial-admin (admin@example.com)',
      })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke GFS' }))

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

    const actionsButton = await screen.findByRole('button', {
      name: 'Actions for initial-admin (admin@example.com)',
    })
    fireEvent.click(actionsButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke GFS' }))

    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(revokeControlAdminGfsOperatorLink).not.toHaveBeenCalled()
  })

  it('distinguishes a never-linked admin from a revoked operator link', async () => {
    vi.mocked(getControlAdmins).mockResolvedValueOnce({
      admins: [
        {
          id: 'admin-2',
          username: 'never-linked',
          email: 'never-linked@example.com',
          memberId: null,
          status: 'active',
          gfsOperatorLink: null,
          gfsOperatorLinkStatus: 'none',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })

    render(<ControlAdminsPanel />)
    expect(await screen.findByTestId('gfs-operator-link-admin-2')).toHaveTextContent('Not linked')
  })

  it('views the matching member from the admin row menu', async () => {
    render(<ControlAdminsPanel />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for initial-admin (admin@example.com)',
      })
    )
    const viewMemberItem = screen.getByRole('menuitem', {
      name: 'View member',
    })
    fireEvent.click(viewMemberItem)

    expect(mockPush).toHaveBeenCalledWith(
      '/users-and-teams/users/11111111-1111-4111-8111-111111111111'
    )
  })

  it('creates a member from an admin without a matching member', async () => {
    vi.mocked(getControlAdmins).mockResolvedValueOnce({
      admins: [
        {
          id: 'admin-2',
          username: 'create-member',
          email: 'create-member@example.com',
          memberId: null,
          status: 'active',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })
    render(<ControlAdminsPanel />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for create-member (create-member@example.com)',
      })
    )
    const createMemberItem = screen.getByRole('menuitem', {
      name: 'Create member',
    })
    fireEvent.click(createMemberItem)

    expect(mockPush).toHaveBeenCalledWith(
      '/users-and-teams/users/new?adminId=admin-2&email=create-member%40example.com&name=create-member'
    )
  })

  it('disables member creation for an admin without an email', async () => {
    vi.mocked(getControlAdmins).mockResolvedValueOnce({
      admins: [
        {
          id: 'admin-3',
          username: 'email-missing',
          email: null,
          memberId: null,
          status: 'active',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })
    render(<ControlAdminsPanel />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for email-missing',
      })
    )
    const createMemberItem = screen.getByRole('menuitem', {
      name: 'Email required to create member',
    })
    expect(createMemberItem).toBeDisabled()

    fireEvent.click(createMemberItem)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('disables member creation until an admin completes password setup', async () => {
    vi.mocked(getControlAdmins).mockResolvedValueOnce({
      admins: [
        {
          id: 'admin-4',
          username: 'password-pending',
          email: 'password-pending@example.com',
          memberId: null,
          passwordPending: true,
          status: 'pending_password',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })
    render(<ControlAdminsPanel />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for password-pending (password-pending@example.com)',
      })
    )
    const createMemberItem = screen.getByRole('menuitem', {
      name: 'Complete password setup to create member',
    })
    expect(createMemberItem).toBeDisabled()

    fireEvent.click(createMemberItem)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('keeps disabled admin tombstones out of the operational action list after refresh', async () => {
    vi.mocked(getControlAdmins).mockResolvedValueOnce({
      admins: [
        {
          id: 'disabled-admin',
          username: 'retired-admin',
          email: 'retired@example.com',
          memberId: LINK.desktopUserId,
          status: 'disabled',
          gfsOperatorLink: { ...LINK, controlAdminId: 'disabled-admin', status: 'revoked' },
          gfsOperatorLinkStatus: 'revoked',
          lastLoginAt: null,
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      invitations: [],
    })

    render(<ControlAdminsPanel />)
    await waitFor(() => expect(getControlAdmins).toHaveBeenCalled())
    expect(screen.queryByText('retired-admin')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /Reactivate Desktop GFS operator access for retired-admin/,
      })
    ).not.toBeInTheDocument()
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
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for initial-admin (admin@example.com)',
      })
    )
    const reactivateItem = screen.getByRole('menuitem', {
      name: 'Reactivate GFS',
    })
    fireEvent.click(reactivateItem)

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
