import type React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import { apiSend } from '@lib/api'
import CreateSecretPage from '../../app/secrets/new/page'

const mockPush = vi.fn()
let searchParams = new URLSearchParams('scope=llm')

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
    apiSend: vi.fn(),
  }
})

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

const secretNameInput = () => screen.getByLabelText(/Secret name\*?/i)

// The "＋ Add provider" picker lives inside LlmCredentialFields; its options
// exist only while the menu is open (single-select closes on pick).
function addProvider(label: string) {
  fireEvent.click(screen.getByLabelText('Add provider'))
  fireEvent.click(screen.getByRole('option', { name: label }))
}

async function walkToValuesStep(name: string) {
  fireEvent.change(secretNameInput(), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Create secret' })).toBeInTheDocument()
  })
}

describe('Create LLM secret flow', () => {
  beforeEach(() => {
    mockPush.mockClear()
    vi.mocked(apiSend).mockReset()
    vi.mocked(apiSend).mockResolvedValue({} as never)
    searchParams = new URLSearchParams('scope=llm')
  })

  afterEach(cleanup)

  it('submits the labeled secret and returns to the LLM list', async () => {
    render(<CreateSecretPage />)
    await walkToValuesStep('chatllm-api-keys')
    addProvider('OpenAI')
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), {
      target: { value: 'sk-live-123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/v1/admin/secrets', {
        name: 'chatllm-api-keys',
        labels: { 'clerum.io/host-secret': 'true' },
        stringData: { 'openai-api-key': 'sk-live-123' },
      })
    })
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/secrets/llm')
    })
  })

  it('blocks Continue on a name outside the Kubernetes DNS format', () => {
    render(<CreateSecretPage />)
    fireEvent.change(secretNameInput(), { target: { value: 'My Secret!' } })
    const field = secretNameInput().closest('.cu-field')
    expect(field).not.toBeNull()
    expect(screen.getByText('Name must match the Kubernetes DNS name format.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('blocks Continue on a name longer than 253 characters', () => {
    render(<CreateSecretPage />)
    fireEvent.change(secretNameInput(), { target: { value: `${'a'.repeat(250)}-extra` } })
    expect(screen.getByText('Name must match the Kubernetes DNS name format.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('re-gates the flow when the name is invalidated after Back from step 2', async () => {
    render(<CreateSecretPage />)
    await walkToValuesStep('chatllm-api-keys')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.change(secretNameInput(), { target: { value: 'Not A Name' } })
    expect(screen.getByText('Name must match the Kubernetes DNS name format.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(apiSend).not.toHaveBeenCalled()
  })

  it('shows the API error inline and recovers on retry', async () => {
    vi.mocked(apiSend).mockRejectedValueOnce(new Error('boom'))
    render(<CreateSecretPage />)
    await walkToValuesStep('chatllm-api-keys')
    addProvider('OpenAI')
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), {
      target: { value: 'sk-live-123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument()
    })
    expect(mockPush).not.toHaveBeenCalled()
    vi.mocked(apiSend).mockResolvedValueOnce({} as never)
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/secrets/llm')
    })
  })

  it('keeps Create disabled until a credential value is typed', async () => {
    render(<CreateSecretPage />)
    await walkToValuesStep('chatllm-api-keys')
    expect(screen.getByRole('button', { name: 'Create secret' })).toBeDisabled()
    addProvider('OpenAI')
    expect(screen.getByRole('button', { name: 'Create secret' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), {
      target: { value: 'sk-live-123' },
    })
    expect(screen.getByRole('button', { name: 'Create secret' })).toBeEnabled()
  })

  it('keeps a typed extra-slot value visible and editable across Back/Continue', async () => {
    render(<CreateSecretPage />)
    await walkToValuesStep('chatllm-api-keys')
    addProvider('Z.AI')
    fireEvent.click(screen.getByRole('button', { name: /Add credential slot/i }))
    fireEvent.change(screen.getByLabelText(/Extra credential slot key name/i), {
      target: { value: 'zai-api-key-fb1' },
    })
    fireEvent.change(screen.getByLabelText(/Extra credential slot value/i), {
      target: { value: 'zai-fallback-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create secret' })).toBeInTheDocument()
    })
    expect(
      (screen.getByLabelText(/Extra credential slot key name/i) as HTMLInputElement).value
    ).toBe('zai-api-key-fb1')
    expect((screen.getByLabelText(/Extra credential slot value/i) as HTMLInputElement).value).toBe(
      'zai-fallback-secret'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith(
        'POST',
        '/api/v1/admin/secrets',
        expect.objectContaining({
          stringData: { 'zai-api-key-fb1': 'zai-fallback-secret' },
        })
      )
    })
  })

  it('keeps a provider added without values after Back/Continue', async () => {
    render(<CreateSecretPage />)
    await walkToValuesStep('chatllm-api-keys')
    addProvider('Z.AI')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create secret' })).toBeInTheDocument()
    })
    expect(screen.getByText('Z.AI', { selector: '.cu-llm-cred-group__title' })).toBeInTheDocument()
  })

  it('hides the credential editor on step 0 and shows it on step 2', async () => {
    render(<CreateSecretPage />)
    // Mounted-but-hidden keeps editor state across the Back/Continue transition;
    // assert visibility, not presence.
    expect(screen.getByLabelText('Add provider')).not.toBeVisible()
    await walkToValuesStep('chatllm-api-keys')
    expect(screen.getByLabelText('Add provider')).toBeVisible()
  })
})
