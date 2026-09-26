import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { listHostEnv, putHostEnv } from '@lib/api'
import { HostEnvTable } from '../HostEnvTable'

vi.mock('@lib/api', () => ({
  deleteHostEnvKey: vi.fn(),
  listHostEnv: vi.fn(),
  putHostEnv: vi.fn(),
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

vi.mock('../Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))

describe('HostEnvTable simple edit dialog', () => {
  afterEach(cleanup)

  it('stages a new variable and saves through the existing host env mutation', async () => {
    vi.mocked(listHostEnv).mockResolvedValue({ items: [] })
    vi.mocked(putHostEnv).mockResolvedValue({ keys: [] })
    render(<HostEnvTable hostRef="agent-a" />)

    await screen.findByText('No env vars set for this Host yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    const dialog = screen.getByRole('dialog', { name: 'Add variable' })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'API_TOKEN' } })
    fireEvent.change(within(dialog).getByLabelText(/^Value/), { target: { value: 'secret' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Secret/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(putHostEnv).toHaveBeenCalledWith('agent-a', [
        { key: 'API_TOKEN', value: 'secret', secret: true },
      ])
    )
  })
})
