// control-ui/components/__tests__/RevealApiKeyModal.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import RevealApiKeyModal from '../RevealApiKeyModal'
import { ToastProvider } from '../Toast'

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)

describe('RevealApiKeyModal', () => {
  it('warns it is shown once and masks the key by default', () => {
    render(<RevealApiKeyModal apiKey="efrk_secret" onClose={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/only time/i)
    expect(screen.queryByText('efrk_secret')).toBeNull()
  })

  it('reveals on toggle', () => {
    render(<RevealApiKeyModal apiKey="efrk_secret" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }))
    expect(screen.getByText('efrk_secret')).toBeInTheDocument()
  })

  it('copies to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<RevealApiKeyModal apiKey="efrk_secret" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(writeText).toHaveBeenCalledWith('efrk_secret')
  })

  it('shows a fallback message when clipboard fails', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('x')) } })
    render(<RevealApiKeyModal apiKey="efrk_secret" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(await screen.findByText(/select.*copy manually/i)).toBeInTheDocument()
  })

  it('calls onClose only via the explicit button', () => {
    const onClose = vi.fn()
    render(<RevealApiKeyModal apiKey="efrk_secret" onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /saved it|close|done/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('focuses the Copy button on open', () => {
    render(<RevealApiKeyModal apiKey="efrk_secret" onClose={() => {}} />)
    const copyButton = screen.getByRole('button', { name: /copy/i })
    expect(document.activeElement).toBe(copyButton)
  })
})
