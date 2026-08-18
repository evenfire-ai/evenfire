import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '../../../components/Toast'
import * as api from '../../../lib/api'
import CreateContextPage from '../new/page'

/**
 * Regression guard for R1-M5 (class sibling of R1-B1): the context-create wizard
 * gates (canSubmit / canContinue / canSelectStep) must validate the DERIVED slug
 * (toKebabCase), not the raw trimmed text. A name with no ASCII alphanumerics
 * ("!!!", whitespace) trims non-empty but toKebabCase()s to "" — which would
 * POST metadata.name/contextId: "".
 *
 * These tests FAIL against the pre-fix head (c3ac3e40), where the gates read
 * `contextName.trim().length > 0` (so "!!!" enabled Continue and let create run).
 */

const replaceMock = vi.fn()
const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../../components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../../lib/api', () => ({
  createContext: vi.fn().mockResolvedValue({}),
  getMcpServers: vi.fn().mockResolvedValue({ items: [] }),
}))

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(() => {
  cleanup()
})

describe('CreateContextPage — gates on the derived slug (R1-M5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps Continue DISABLED and never calls createContext for a symbols-only name', async () => {
    render(<CreateContextPage />)
    await waitFor(() => expect(api.getMcpServers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('Context 1'), { target: { value: '!!!' } })

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).toBeDisabled()
    expect(screen.getByText(/Context name must contain letters or numbers/i)).toBeInTheDocument()

    // The observable end result: no create request escapes with an empty slug.
    fireEvent.click(continueBtn)
    expect(api.createContext).not.toHaveBeenCalled()
  })

  it('keeps Continue DISABLED for a whitespace-only name', async () => {
    render(<CreateContextPage />)
    await waitFor(() => expect(api.getMcpServers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('Context 1'), { target: { value: '   ' } })

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('enables Continue and creates with a non-empty slug for a valid name', async () => {
    render(<CreateContextPage />)
    await waitFor(() => expect(api.getMcpServers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('Context 1'), { target: { value: 'My Ctx' } })

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).not.toBeDisabled()

    // Advance to step 1 and create.
    fireEvent.click(continueBtn)
    fireEvent.click(screen.getByRole('button', { name: 'Create context' }))

    await waitFor(() => expect(api.createContext).toHaveBeenCalled())
    const [payload] = (api.createContext as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { metadata: { name: string }; spec: { contextId: string } },
    ]
    expect(payload.metadata.name).toBe('my-ctx')
    expect(payload.spec.contextId).toBe('my-ctx')
  })
})
