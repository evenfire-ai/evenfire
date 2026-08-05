// control-ui/components/__tests__/RevealApiKeyModal.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import type { CreatedRegistryApiKey } from '../../lib/api'
import RevealApiKeyModal from '../RevealApiKeyModal'
import { ToastProvider } from '../Toast'

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)

const key = (scopes: string[], over: Partial<CreatedRegistryApiKey> = {}): CreatedRegistryApiKey =>
  ({
    id: 'k1',
    key: 'efrk_secret',
    key_prefix: 'efrk_',
    scopes,
    expires_at: null,
    ...over,
  }) as CreatedRegistryApiKey

const readKey = key(['registry:read'])
const pushKey = key(['registry:read', 'registry:publish'])

describe('RevealApiKeyModal', () => {
  it('warns it is shown once and masks the key by default', () => {
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/only time/i)
    expect(screen.queryByText('efrk_secret')).toBeNull()
  })

  it('reveals on toggle', () => {
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }))
    expect(screen.getByText('efrk_secret')).toBeInTheDocument()
  })

  it('copies the key to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(writeText).toHaveBeenCalledWith('efrk_secret')
  })

  it('shows a fallback message when clipboard fails', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('x')) },
    })
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(await screen.findByText(/select.*copy manually/i)).toBeInTheDocument()
  })

  it('calls onClose only via the explicit button', () => {
    const onClose = vi.fn()
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /saved it|close|done/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('focuses the Copy button on open', () => {
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^copy$/i }))
  })

  it('hides the Docker section for a non-publish key', () => {
    render(<RevealApiKeyModal created={readKey} orgScope="acme" onClose={() => {}} />)
    expect(screen.queryByText(/use with docker/i)).toBeNull()
  })

  it('shows Docker push instructions for a registry:publish key', () => {
    render(<RevealApiKeyModal created={pushKey} orgScope="acme" onClose={() => {}} />)
    expect(screen.getByText(/use with docker/i)).toBeInTheDocument()
    expect(screen.getByText(/docker login/i)).toBeInTheDocument()
    // push coordinate carries the org namespace
    expect(screen.getByText(/registry\.evenfire\.ai\/acme/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy login command/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download dockerconfigjson/i })).toBeInTheDocument()
  })
})
