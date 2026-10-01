import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../lib/api'
import RegistryConnectPanel from '../RegistryConnectPanel'
import { ToastProvider } from '../Toast'

const publishScopeMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}))
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('../../lib/api', () => ({
  getRegistryConnection: vi.fn(),
  requestRegistryConnection: vi.fn(),
  submitRegistryClaim: vi.fn(),
  disconnectRegistryConnection: vi.fn(),
  recoverRegistryConnection: vi.fn(),
}))
vi.mock('../../lib/hooks/usePublishScope', () => ({
  usePublishScope: () => ({
    scope: null,
    loading: false,
    error: false,
    refresh: publishScopeMocks.refresh,
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))

function renderPanel() {
  return render(
    <ToastProvider>
      <RegistryConnectPanel />
    </ToastProvider>
  )
}

function signingMaterialError() {
  return Object.assign(new Error('409 registry_signing_material_unavailable'), {
    status: 409,
    code: 'registry_signing_material_unavailable',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  publishScopeMocks.refresh.mockResolvedValue(null)
})
afterEach(cleanup)

describe('RegistryConnectPanel permanent signing-material failures', () => {
  it('GET registry_signing_material_unavailable renders a permanent repair view without retry', async () => {
    vi.mocked(api.getRegistryConnection).mockRejectedValue(signingMaterialError())

    renderPanel()

    expect(
      await screen.findByText(/stored registry signing material is unavailable/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/retrying cannot repair this connection/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
    expect(api.getRegistryConnection).toHaveBeenCalledTimes(1)
  })

  it('manual claim registry_signing_material_unavailable enters the permanent repair view', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'approved',
      deploymentId: 'deployment-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.submitRegistryClaim).mockRejectedValue(signingMaterialError())

    renderPanel()
    await userEvent.type(await screen.findByLabelText(/claim token/i), 'claim-token')
    await userEvent.click(screen.getByRole('button', { name: /complete connection/i }))

    expect(
      await screen.findByText(/stored registry signing material is unavailable/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/could not complete the claim\. try again shortly\./i)).toBeNull()
    expect(screen.queryByLabelText(/claim token/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
    expect(api.getRegistryConnection).toHaveBeenCalledTimes(1)
    expect(api.submitRegistryClaim).toHaveBeenCalledTimes(1)
  })

  it('recovery registry_signing_material_unavailable enters the permanent repair view', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'deployment-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockRejectedValue(signingMaterialError())

    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))

    expect(
      await screen.findByText(/stored registry signing material is unavailable/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/could not finish connecting\. try again in a moment\./i)).toBeNull()
    expect(screen.queryByRole('button', { name: /finish connecting/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
    expect(api.getRegistryConnection).toHaveBeenCalledTimes(1)
    expect(api.recoverRegistryConnection).toHaveBeenCalledTimes(1)
  })

  it('registration registry_signing_material_unavailable enters the permanent repair view', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    vi.mocked(api.requestRegistryConnection).mockRejectedValue(signingMaterialError())

    renderPanel()
    await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
    await userEvent.type(screen.getByLabelText(/email/i), 'ops@example.com')
    await userEvent.click(screen.getByRole('button', { name: /request registration/i }))

    expect(
      await screen.findByText(/stored registry signing material is unavailable/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/could not request registration\. try again shortly\./i)).toBeNull()
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
    expect(api.getRegistryConnection).toHaveBeenCalledTimes(1)
    expect(api.requestRegistryConnection).toHaveBeenCalledTimes(1)
  })

  it('confirmed Start over from permanent signing-material failure disconnects once and shows request', async () => {
    vi.mocked(api.getRegistryConnection).mockRejectedValue(signingMaterialError())
    vi.mocked(api.disconnectRegistryConnection).mockResolvedValue(undefined)

    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: /start over/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /start over/i })
    expect(dialog).toHaveAccessibleDescription(/stored registry credentials/i)
    await userEvent.click(within(dialog).getByRole('button', { name: /^start over$/i }))

    expect(await screen.findByText('Request registration')).toBeInTheDocument()
    expect(api.disconnectRegistryConnection).toHaveBeenCalledTimes(1)
    expect(publishScopeMocks.refresh).toHaveBeenCalledWith({ force: true })
    expect(screen.queryByText(/stored registry signing material is unavailable/i)).toBeNull()
  })

  it('cancelled Start over from permanent signing-material failure leaves the row intact', async () => {
    vi.mocked(api.getRegistryConnection).mockRejectedValue(signingMaterialError())
    vi.mocked(api.disconnectRegistryConnection).mockResolvedValue(undefined)

    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: /start over/i }))
    await screen.findByRole('alertdialog', { name: /start over/i })
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(
      await screen.findByText(/stored registry signing material is unavailable/i)
    ).toBeInTheDocument()
    expect(api.disconnectRegistryConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
  })

  it('failed Start over from permanent signing-material failure remains repairable', async () => {
    vi.mocked(api.getRegistryConnection).mockRejectedValue(signingMaterialError())
    vi.mocked(api.disconnectRegistryConnection).mockRejectedValue(new Error('delete failed'))

    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: /start over/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /start over/i })
    await userEvent.click(within(dialog).getByRole('button', { name: /^start over$/i }))

    expect(
      await screen.findByText(/could not remove the stored registry credentials/i)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
    expect(screen.queryByText('Request registration')).toBeNull()
    expect(api.disconnectRegistryConnection).toHaveBeenCalledTimes(1)
  })

  it('unrelated registry status failure keeps the generic retry view', async () => {
    vi.mocked(api.getRegistryConnection).mockRejectedValue(
      Object.assign(new Error('500 x'), { status: 500, code: undefined })
    )

    renderPanel()

    expect(await screen.findByText(/could not load the connection status/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start over/i })).not.toBeInTheDocument()
  })
})
