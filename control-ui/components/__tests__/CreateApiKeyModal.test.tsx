// control-ui/components/__tests__/CreateApiKeyModal.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import CreateApiKeyModal from '../CreateApiKeyModal'
import { ToastProvider } from '../Toast'

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)

describe('CreateApiKeyModal', () => {
  it('defaults to read+publish+update with delete unchecked', () => {
    render(<CreateApiKeyModal onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect((screen.getByLabelText(/read/i) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/publish/i) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/update/i) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/delete/i) as HTMLInputElement).checked).toBe(false)
  })

  it('sends an explicit scopes array', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<CreateApiKeyModal onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /create key/i }))
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ['registry:read', 'registry:publish', 'registry:update'],
        })
      )
    )
  })

  it('blocks submit when no scope is selected', async () => {
    const onCreate = vi.fn()
    render(<CreateApiKeyModal onCreate={onCreate} onCancel={vi.fn()} />)
    ;['read', 'publish', 'update'].forEach(s =>
      fireEvent.click(screen.getByLabelText(new RegExp(s, 'i')))
    )
    fireEvent.click(screen.getByRole('button', { name: /create key/i }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText(/at least one scope/i)).toBeInTheDocument()
  })

  it('passes expiresInDays from a quick-pick', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<CreateApiKeyModal onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '90 days' }))
    fireEvent.click(screen.getByRole('button', { name: /create key/i }))
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ expiresInDays: 90 }))
    )
  })

  it('shows an inline error when onCreate rejects with code invalid_scope', async () => {
    const scopeError = Object.assign(new Error('bad scope'), { code: 'invalid_scope' })
    const onCreate = vi.fn().mockRejectedValue(scopeError)
    render(<CreateApiKeyModal onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /create key/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid scope/i)
  })
})
