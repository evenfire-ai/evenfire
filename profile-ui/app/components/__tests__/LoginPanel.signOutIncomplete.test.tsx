import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoginPanel } from '@components/LoginPanel'

const mocks = vi.hoisted(() => ({
  authState: { signOutIncomplete: false, retrySignOut: vi.fn() },
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
    signOutIncomplete: mocks.authState.signOutIncomplete,
    retrySignOut: mocks.authState.retrySignOut,
  }),
}))

vi.mock('next/image', () => ({
  default: ({ alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img alt={alt} {...props} />
  ),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

beforeEach(() => {
  mocks.authState.signOutIncomplete = false
  mocks.authState.retrySignOut.mockReset()
})

afterEach(cleanup)

describe('LoginPanel incomplete sign-out banner', () => {
  it('explains the incomplete sign-out and retries it', () => {
    mocks.authState.signOutIncomplete = true

    render(<LoginPanel />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/sign-out is not complete/i)
    expect(alert).toHaveTextContent(/reload/i)

    fireEvent.click(screen.getByRole('button', { name: 'Retry sign-out' }))

    expect(mocks.authState.retrySignOut).toHaveBeenCalledOnce()
  })

  it('renders the ordinary login form when the sign-out completed', () => {
    render(<LoginPanel />)

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
