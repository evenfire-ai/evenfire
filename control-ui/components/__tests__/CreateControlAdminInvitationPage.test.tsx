import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import CreateControlAdminInvitationPage from '../../app/control-admins/new/page'
import { inviteControlAdmin } from '../../lib/api'

const mockPush = vi.fn()
const mockShowToast = vi.fn()
let mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => mockSearchParams,
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getAdminTeams: vi.fn(),
    inviteControlAdmin: vi.fn(),
  }
})

describe('CreateControlAdminInvitationPage', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockShowToast.mockClear()
    mockSearchParams = new URLSearchParams()
    vi.mocked(inviteControlAdmin).mockResolvedValue({
      invitation: {
        id: 'invitation-1',
        email: 'member@example.com',
        status: 'pending',
        expiresAt: '2026-05-02T12:00:00.000Z',
        createdAt: '2026-04-30T12:00:00.000Z',
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not offer Desktop App access when inviting an existing member as admin', async () => {
    mockSearchParams = new URLSearchParams(
      'email=member%40example.com&name=Existing+Member&step=review&source=member'
    )

    render(<CreateControlAdminInvitationPage />)

    expect(screen.getByRole('heading', { name: 'Review invitation' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Create access to Desktop App')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() => {
      expect(inviteControlAdmin).toHaveBeenCalledWith('member@example.com', {
        createDesktopAccess: false,
        teams: [],
      })
    })
    expect(mockPush).toHaveBeenCalledWith('/profile-admin/admins')
  })
})
