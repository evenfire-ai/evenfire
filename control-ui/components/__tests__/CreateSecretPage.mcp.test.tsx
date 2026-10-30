import type React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import { createMcpSecret, listMcpSecrets } from '@lib/api'
import CreateSecretPage from '../../app/secrets/new/page'

const mockPush = vi.fn()
let searchParams = new URLSearchParams('scope=mcp')

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => searchParams,
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    createMcpSecret: vi.fn(),
    listMcpSecrets: vi.fn(),
  }
})

const mockCreateMcpSecret = vi.mocked(createMcpSecret)
const mockListMcpSecrets = vi.mocked(listMcpSecrets)

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

const secretNameInput = () => screen.getByLabelText(/Secret name\*?/i)

describe('Create connector secret flow — name availability', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockPush.mockClear()
    mockCreateMcpSecret.mockReset()
    mockListMcpSecrets.mockReset()
    mockListMcpSecrets.mockResolvedValue({ items: [] })
    searchParams = new URLSearchParams('scope=mcp')
  })

  afterEach(() => {
    cleanup()
  })

  it('flags a name that already exists and offers rotation instead of a doomed create', async () => {
    mockListMcpSecrets.mockResolvedValue({ items: [{ name: 'dfg', keys: ['api-key'] }] })
    render(<CreateSecretPage />)

    fireEvent.change(secretNameInput(), { target: { value: 'dfg' } })

    expect(
      await screen.findByText('A connector secret named "dfg" already exists.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Rotate its values instead' }))
    expect(mockPush).toHaveBeenCalledWith('/secrets/connector/dfg/edit')
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('keeps the create flow available for a name nothing holds yet', async () => {
    render(<CreateSecretPage />)

    fireEvent.change(secretNameInput(), { target: { value: 'brand-new-creds' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'api-key' } })
    fireEvent.change(screen.getByPlaceholderText('secret value'), { target: { value: 'tok' } })
    mockCreateMcpSecret.mockResolvedValue({ name: 'brand-new-creds', namespace: 'mcp-server' })
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))

    await waitFor(() => {
      expect(mockCreateMcpSecret).toHaveBeenCalledWith('brand-new-creds', { 'api-key': 'tok' })
    })
  })

  it('refuses at submit when the name was taken after the debounce check', async () => {
    render(<CreateSecretPage />)

    fireEvent.change(secretNameInput(), { target: { value: 'dfg' } })
    // Availability check still says free; the secret appears before submit.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'api-key' } })
    fireEvent.change(screen.getByPlaceholderText('secret value'), { target: { value: 'tok' } })

    mockListMcpSecrets.mockResolvedValue({ items: [{ name: 'dfg', keys: ['api-key'] }] })
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))

    await waitFor(() => {
      expect(screen.getByText(/already exists\. Rotate its values/i)).toBeInTheDocument()
    })
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })
})
