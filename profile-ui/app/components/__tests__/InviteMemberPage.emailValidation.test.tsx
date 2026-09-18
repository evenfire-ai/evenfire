import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import InviteMemberPage from '../../members/invite/page'

const routerMock = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ProfileAccessContext', () => ({
  useProfileAccess: () => ({
    manageableTeams: [],
    manageableTeamsError: null,
    manageableTeamsLoading: false,
  }),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('@lib/api', () => ({
  inviteManagedMember: vi.fn(),
}))

describe('InviteMemberPage email validation', () => {
  beforeEach(() => {
    routerMock.push.mockReset()
  })

  afterEach(cleanup)

  it('keeps a valid bounded invitation email usable', () => {
    render(<InviteMemberPage />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invitee' } })
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'invitee@example.com' },
    })

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('rejects a plausible invitation email longer than 320 characters', () => {
    render(<InviteMemberPage />)

    const emailInput = screen.getByLabelText('Email')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invitee' } })
    fireEvent.change(emailInput, {
      target: { value: `${'a'.repeat(315)}@a.com` },
    })

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(emailInput).toHaveAttribute('maxlength', '320')
  })

  it('rejects bounded invalid invitation email input without enabling submission', () => {
    render(<InviteMemberPage />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invitee' } })
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: `!@!${'!.'.repeat(100)}@` },
    })

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })
})
