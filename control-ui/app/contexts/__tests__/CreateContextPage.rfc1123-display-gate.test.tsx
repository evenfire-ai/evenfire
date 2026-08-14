import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '../../../components/Toast'
import * as api from '../../../lib/api'
import CreateContextPage from '../new/page'

/**
 * Regression guard for the context-create page's gate — the sibling of R4-H1 /
 * R5-H1 in HostWizard (phase 4 of the display-field mini-spec).
 *
 *  D-A: canSubmit/canContinue/canSelectStep must gate on the FULL RFC1123 rule
 *       (isValidResourceSlug), not just `toKebabCase(name).length > 0`. A name
 *       whose derived slug is >63 chars trims/kebabs non-empty but the server
 *       rejects it (invalid_name).
 *  D-B: the free-text `spec.displayName` (contextName.trim()) must be validated
 *       with the shared @clerum/display-field rule the server applies. A bidi/
 *       control char survives into displayName (toKebabCase strips it from the
 *       slug) or a >120-char display is rejected server-side.
 *
 * These tests FAIL against the pre-fix head, where the gates read only
 * `toKebabCase(contextName).length > 0`: the over-long slug and the bidi/long
 * display names all enabled Continue and let a doomed create escape.
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

async function typeName(value: string) {
  render(<CreateContextPage />)
  await waitFor(() => expect(api.getMcpServers).toHaveBeenCalled())
  fireEvent.change(screen.getByPlaceholderText('Context 1'), { target: { value } })
}

afterEach(() => {
  cleanup()
})

describe('CreateContextPage — RFC1123 slug + displayName gate (D-A / D-B)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // INV-1 (D-A): a name whose derived slug exceeds 63 chars must block.
  it('blocks an over-long (>63) derived slug and never calls createContext', async () => {
    await typeName('a'.repeat(64)) // toKebabCase() → 64 chars, > RFC1123 limit

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).toBeDisabled()
    expect(screen.getByText(/at most 63 characters/i)).toBeInTheDocument()

    fireEvent.click(continueBtn)
    expect(api.createContext).not.toHaveBeenCalled()
  })

  // INV-2 (D-B): the R5-H1 vector — a bidi override char. toKebabCase strips it,
  // so the slug (`ctxname`) is valid, but it survives into spec.displayName.
  it('blocks a name with a bidi formatting char (valid slug, invalid display)', async () => {
    await typeName('ctx‮name') // slug → "ctxname" (valid); display keeps U+202E

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).toBeDisabled()
    expect(screen.getByText(/control or formatting characters/i)).toBeInTheDocument()

    // Observable result (T4): no create request escapes with a rejected display.
    fireEvent.click(continueBtn)
    expect(api.createContext).not.toHaveBeenCalled()
  })

  // INV-3 (D-B): a >120-char display value with a still-valid ≤63 slug.
  it('blocks a display value longer than 120 chars even when the slug is valid', async () => {
    // trim() length 131; toKebabCase() strips the dots → "a" (valid ≤63 slug).
    await typeName('a' + '.'.repeat(130))

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).toBeDisabled()
    expect(screen.getByText(/too long \(max 120 characters\)/i)).toBeInTheDocument()

    fireEvent.click(continueBtn)
    expect(api.createContext).not.toHaveBeenCalled()
  })

  // Positive control: a clean name still enables Continue and creates.
  it('enables Continue for a valid name and shows the derived identifier', async () => {
    await typeName('My Context')

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).not.toBeDisabled()
    expect(screen.getByText('my-context')).toBeInTheDocument()

    fireEvent.click(continueBtn)
    fireEvent.click(screen.getByRole('button', { name: 'Create context' }))

    await waitFor(() => expect(api.createContext).toHaveBeenCalled())
    const [payload] = (api.createContext as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { metadata: { name: string }; spec: { contextId: string; displayName?: string } },
    ]
    expect(payload.metadata.name).toBe('my-context')
    expect(payload.spec.displayName).toBe('My Context')
  })
})
