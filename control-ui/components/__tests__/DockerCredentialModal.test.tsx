import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { DockerCredentialModal } from '../PublisherView/DockerCredentialModal'
import { ToastProvider } from '../Toast'

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  // jsdom lacks clipboard + URL.createObjectURL; stub them.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
})

const created = {
  id: 'k1',
  key: 'efrk_secret',
  key_prefix: 'efrk_abc',
  scopes: ['registry:publish'],
  expires_at: null,
}

describe('DockerCredentialModal', () => {
  it('shows the once-only warning, docker login snippet, and push coordinate', () => {
    render(<DockerCredentialModal created={created} orgScope="acme" onClose={() => {}} />)
    expect(screen.getByText(/only time/i)).toBeInTheDocument()
    expect(
      screen.getByText(/docker login registry\.evenfire\.ai -u _ -p efrk_secret/)
    ).toBeInTheDocument()
    expect(screen.getByText(/registry\.evenfire\.ai\/acme\/<name>:<tag>/)).toBeInTheDocument()
  })

  it('copies the login command to the clipboard', () => {
    render(<DockerCredentialModal created={created} orgScope="acme" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /copy login command/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'docker login example.com -u _ -p efrk_secret'
    )
  })

  it('Download triggers a dockerconfigjson blob', () => {
    render(<DockerCredentialModal created={created} orgScope="acme" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /download/i }))
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('calls onClose from "I’ve saved it"', () => {
    const onClose = vi.fn()
    render(<DockerCredentialModal created={created} orgScope="acme" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /saved it/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
