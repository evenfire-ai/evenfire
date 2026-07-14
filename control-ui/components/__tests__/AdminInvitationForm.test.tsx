import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AdminInvitationForm } from '../../app/admin-invitations/[token]/AdminInvitationForm'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    completeControlAdminInvitation: vi.fn(),
  }
})

describe('AdminInvitationForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('mounts separate Desktop App password fields and updates the same-password checkbox', () => {
    render(
      <AdminInvitationForm
        csrfToken="csrf-token"
        desktopTeams={[{ id: 'team-1', name: 'Engineering' }]}
        email="member@example.com"
        hasDesktopAccess
        token="invite-token"
      />
    )

    expect(screen.getByLabelText('Use same password for Desktop App')).toBeChecked()
    expect(screen.getByLabelText(/^Desktop App password/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Confirm Desktop App password/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Use same password for Desktop App'))

    expect(screen.getByLabelText('Use same password for Desktop App')).not.toBeChecked()
    expect(screen.getByLabelText(/^Desktop App password/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Confirm Desktop App password/)).toBeInTheDocument()
  })
})
