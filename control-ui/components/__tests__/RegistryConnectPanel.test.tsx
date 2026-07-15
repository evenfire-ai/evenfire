// control-ui/components/__tests__/RegistryConnectPanel.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as ConfirmDialogModule from '../ConfirmDialog'
import RegistryConnectPanel from '../RegistryConnectPanel'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getRegistryConnection: vi.fn(),
  requestRegistryConnection: vi.fn(),
  submitRegistryClaim: vi.fn(),
  disconnectRegistryConnection: vi.fn(),
}))
vi.mock('../ConfirmDialog', () => ({ useConfirmDialog: vi.fn() }))

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
    confirm: vi.fn().mockResolvedValue(true),
    confirmDialog: null,
  })
})

describe('RegistryConnectPanel', () => {
  it('shows the request form when disconnected', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    render(<RegistryConnectPanel />)
    await waitFor(() => expect(screen.getByText('Request registration')).toBeInTheDocument())
  })

  it('shows the not-self-hosted banner on a not_self_hosted code', async () => {
    vi.mocked(api.getRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'not_self_hosted' })
    )
    render(<RegistryConnectPanel />)
    await waitFor(() => expect(screen.getByText(/managed by Evenfire/)).toBeInTheDocument())
  })

  it('requests registration → moves to the pending waiting view (no claim input yet)', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    vi.mocked(api.requestRegistryConnection).mockResolvedValue({
      state: 'pending',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await waitFor(() => screen.getByText('Request registration'))
    fireEvent.change(screen.getByPlaceholderText('acme'), { target: { value: 'acme' } })
    fireEvent.change(screen.getByPlaceholderText('ops@acme.io'), {
      target: { value: 'ops@acme.io' },
    })
    fireEvent.click(screen.getByText('Request registration'))
    await waitFor(() =>
      expect(screen.getByText(/Waiting for an Evenfire operator/)).toBeInTheDocument()
    )
    // Claim entry does NOT appear on pending — only after approval.
    expect(screen.queryByPlaceholderText('paste claim token')).toBeNull()
  })

  it('pending state shows the waiting view only — no claim input', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'pending',
      deploymentId: 'd',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await waitFor(() =>
      expect(screen.getByText(/Waiting for an Evenfire operator/)).toBeInTheDocument()
    )
    expect(screen.queryByPlaceholderText('paste claim token')).toBeNull()
    expect(screen.getByText('Refresh status')).toBeInTheDocument()
  })

  it('approved state shows the claim-token entry form', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'approved',
      deploymentId: 'd',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await waitFor(() =>
      expect(screen.getByPlaceholderText('paste claim token')).toBeInTheDocument()
    )
    expect(screen.getByText('Complete connection')).toBeInTheDocument()
  })

  it('rejected state shows a terminal message with Start over', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'rejected',
      deploymentId: 'd',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await waitFor(() => expect(screen.getByText(/Request rejected/)).toBeInTheDocument())
    expect(screen.getByText('Start over')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('paste claim token')).toBeNull()
  })

  it('submits a claim from the approved state → connected', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'approved',
      deploymentId: 'd',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.submitRegistryClaim).mockResolvedValue({ state: 'connected', org: 'acme' })
    render(<RegistryConnectPanel />)
    await waitFor(() => screen.getByPlaceholderText('paste claim token'))
    fireEvent.change(screen.getByPlaceholderText('paste claim token'), {
      target: { value: 'tok-1' },
    })
    fireEvent.click(screen.getByText('Complete connection'))
    await waitFor(() =>
      expect(screen.getByText(/Connected to the Evenfire Registry/)).toBeInTheDocument()
    )
  })

  it('shows the expired-token message on a claim_expired code', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'approved',
      deploymentId: 'd',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.submitRegistryClaim).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'claim_expired' })
    )
    render(<RegistryConnectPanel />)
    await waitFor(() => screen.getByPlaceholderText('paste claim token'))
    fireEvent.change(screen.getByPlaceholderText('paste claim token'), {
      target: { value: 'old' },
    })
    fireEvent.click(screen.getByText('Complete connection'))
    await waitFor(() => expect(screen.getByText(/has expired/)).toBeInTheDocument())
  })

  it('shows connected + Disconnect when already connected', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      deploymentId: 'd',
      org: 'acme',
    })
    render(<RegistryConnectPanel />)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeInTheDocument())
  })
})
