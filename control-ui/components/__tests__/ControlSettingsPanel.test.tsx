import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  getControlUISettingsMe,
  requestControlUISettingsEmailChange,
  updateControlUISettingsUsername,
} from '@lib/api'
import { ControlSettingsPanel } from '../ControlSettingsPanel'

const checkAuth = vi.fn()
const showToast = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ checkAuth, logout: vi.fn() }),
}))

vi.mock('../AdminBridgeAlerts', () => ({
  hasControlAdminBridgeAlertOverrides: () => false,
  resetControlAdminBridgeAlerts: vi.fn(),
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

vi.mock('../ThemeContext', () => ({
  useTheme: () => ({ setThemeMode: vi.fn(), themeMode: 'dark' }),
}))

vi.mock('../Toast', () => ({
  useToast: () => ({ showToast }),
}))

vi.mock('@lib/api', () => ({
  getControlUISettingsMe: vi.fn(),
  requestControlUISettingsEmailChange: vi.fn(),
  updateControlUISettingsPassword: vi.fn(),
  updateControlUISettingsUsername: vi.fn(),
}))

const mockGetSettings = vi.mocked(getControlUISettingsMe)
const mockRequestEmailChange = vi.mocked(requestControlUISettingsEmailChange)
const mockUpdateUsername = vi.mocked(updateControlUISettingsUsername)

function accountRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest('.cu-settings-row')
  if (!(row instanceof HTMLElement)) throw new Error(`Could not find ${label} settings row`)
  return row
}

describe('ControlSettingsPanel scalar dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockResolvedValue({
      me: {
        email: 'admin@example.com',
        username: 'admin',
        pendingEmailChange: null,
      },
    } as Awaited<ReturnType<typeof getControlUISettingsMe>>)
  })

  afterEach(cleanup)

  it('keeps username read-only until Edit and discards dismissed drafts', async () => {
    render(<ControlSettingsPanel />)

    await screen.findByText('admin')
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()

    fireEvent.click(within(accountRow('Username')).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit username' })
    const input = within(dialog).getByLabelText('Username')
    expect(input).toHaveValue('admin')
    fireEvent.change(input, { target: { value: 'discarded-name' } })
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'))

    expect(screen.queryByRole('dialog', { name: 'Edit username' })).not.toBeInTheDocument()
    fireEvent.click(within(accountRow('Username')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Username')).toHaveValue('admin')
  })

  it('preserves the username draft on failure and adopts the authoritative success response', async () => {
    mockUpdateUsername
      .mockRejectedValueOnce(new Error('Username is already in use.'))
      .mockResolvedValueOnce({
        me: {
          email: 'authoritative@example.com',
          username: 'server-normalized',
          pendingEmailChange: null,
        },
      } as Awaited<ReturnType<typeof updateControlUISettingsUsername>>)
    render(<ControlSettingsPanel />)

    await screen.findByText('admin')
    fireEvent.click(within(accountRow('Username')).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new-admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Username is already in use.')
    expect(screen.getByLabelText('Username')).toHaveValue('new-admin')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockUpdateUsername).toHaveBeenNthCalledWith(1, 'new-admin')
    expect(mockUpdateUsername).toHaveBeenNthCalledWith(2, 'new-admin')
    expect(screen.getByText('server-normalized')).toBeInTheDocument()
    expect(screen.getByText('authoritative@example.com')).toBeInTheDocument()
    expect(checkAuth).toHaveBeenCalledTimes(1)
  })

  it('stages email selection and preserves the verification workflow on save', async () => {
    mockRequestEmailChange.mockResolvedValue({
      confirmation: {
        email: 'next@example.com',
        createdAt: '2026-09-22T10:00:00.000Z',
        expiresAt: '2026-09-22T11:00:00.000Z',
      },
    } as Awaited<ReturnType<typeof requestControlUISettingsEmailChange>>)
    render(<ControlSettingsPanel />)

    await screen.findByText('admin@example.com')
    fireEvent.click(within(accountRow('Email')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Email')).toHaveValue('admin@example.com')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'NEXT@EXAMPLE.COM' } })
    expect(mockRequestEmailChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockRequestEmailChange).toHaveBeenCalledWith('next@example.com')
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    expect(screen.getByText('Confirmation pending for next@example.com.')).toBeInTheDocument()
    expect(showToast).toHaveBeenCalledWith('Confirmation email sent.', { tone: 'success' })
  })
})
