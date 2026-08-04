// control-ui/components/__tests__/RegistryConnectPanel.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../lib/api'
import * as ConfirmDialogModule from '../ConfirmDialog'
import RegistryConnectPanel from '../RegistryConnectPanel'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getRegistryConnection: vi.fn(),
  requestRegistryConnection: vi.fn(),
  submitRegistryClaim: vi.fn(),
  disconnectRegistryConnection: vi.fn(),
  recoverRegistryConnection: vi.fn(),
}))
vi.mock('../ConfirmDialog', () => ({ useConfirmDialog: vi.fn() }))
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))

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

  // The server can 409 connection_superseded when markConnected matches no
  // row (the claim token was already redeemed and burned, but the credentials
  // could not be saved to this connection). Falling through to the generic
  // "Could not complete the claim. Try again shortly." would tell the user to
  // retry a claim that can never succeed again.
  it('shows terminal copy on a connection_superseded code, not a retry prompt', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'approved',
      deploymentId: 'd',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.submitRegistryClaim).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'connection_superseded' })
    )
    render(<RegistryConnectPanel />)
    await waitFor(() => screen.getByPlaceholderText('paste claim token'))
    fireEvent.change(screen.getByPlaceholderText('paste claim token'), {
      target: { value: 'tok-1' },
    })
    fireEvent.click(screen.getByText('Complete connection'))
    await waitFor(() =>
      expect(
        screen.getByText(/one-time credentials were issued but never stored/i)
      ).toBeInTheDocument()
    )
    expect(screen.queryByText(/Try again shortly/i)).toBeNull()
  })

  it('connected view has no Disconnect control and states the connection is permanent', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      deploymentId: 'd',
      org: 'acme',
    })
    render(<RegistryConnectPanel />)
    await waitFor(() =>
      expect(screen.getByText(/Connected to the Evenfire Registry/)).toBeInTheDocument()
    )
    // Disconnect was removed (design spec §5.6): a claim is permanent, so no
    // self-service teardown control is offered — the copy states this instead.
    expect(screen.queryByRole('button', { name: /^disconnect$/i })).toBeNull()
    expect(screen.getByText(/connection is permanent/i)).toBeInTheDocument()
  })

  it('connected view offers a "Go to your organization" CTA → org entries', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      deploymentId: 'd',
      org: 'acme',
    })
    render(<RegistryConnectPanel />)
    const cta = await screen.findByRole('button', { name: /go to your organization/i })
    fireEvent.click(cta)
    expect(mockPush).toHaveBeenCalledWith('/marketplace/org/entries')
  })

  // Regression guard: the panel used to render an env-var banner
  // (CLERUM_REGISTRY_AUTH_ENABLED guidance) when connected without registry
  // auth active. That banner is gone entirely, so pin its absence for BOTH
  // authEnabled values, not just false. (Self-hosted derives auth from
  // credential presence, so a real `connected` response always has
  // authEnabled: true — connected + authEnabled:false is unreachable in
  // practice — but the assertion must hold under either value so a future
  // change cannot resurrect the old guidance behind just one of them.)
  it.each([false, true])(
    'connected + authEnabled:%s → shows no auth guidance',
    async authEnabled => {
      vi.mocked(api.getRegistryConnection).mockResolvedValue({
        state: 'connected',
        deploymentId: 'd',
        org: 'acme',
        authEnabled,
      })
      render(<RegistryConnectPanel />)
      await waitFor(() =>
        expect(screen.getByText(/Connected to the Evenfire Registry/)).toBeInTheDocument()
      )
      expect(screen.queryByText(/CLERUM_REGISTRY_AUTH_ENABLED/)).toBeNull()
      expect(screen.queryByText(/enable registry authentication/i)).toBeNull()
    }
  )

  it('lands on the connected view when registration auto-claims', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    vi.mocked(api.requestRegistryConnection).mockResolvedValue({
      state: 'connected',
      org: 'acme',
      authEnabled: true,
    })
    render(<RegistryConnectPanel />)
    await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@x.io')
    await userEvent.click(screen.getByRole('button', { name: /request registration/i }))
    // Scoped to the banner text (not just "@acme") because the success toast also
    // renders "Connected to @acme." — a bare /@acme/ match would be ambiguous.
    expect(await screen.findByText(/Connected to the Evenfire Registry.*@acme/)).toBeInTheDocument()
    // The toast is a SEPARATE mutation from the view: branching the view but
    // leaving the toast unconditional tells a connected user to wait for an
    // operator who does not exist.
    expect(screen.queryByText(/must approve it/i)).toBeNull()
  })

  it('renders the connecting view with a finish button and no paste box', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    expect(await screen.findByRole('button', { name: /finish connecting/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/claim token/i)).toBeNull()
  })

  // load()'s default arm renders the registration form. Shipping a new state
  // without a branch would show "Register this deployment" to an already-approved
  // deployment, and re-registering destroys its keypair.
  it('never renders the registration form for the connecting state', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await screen.findByRole('button', { name: /finish connecting/i })
    expect(screen.queryByRole('button', { name: /request registration/i })).toBeNull()
  })

  it('shows the terminal message when recovery is already claimed', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
      recoveryError: 'already_claimed',
    })
    render(<RegistryConnectPanel />)
    expect(await screen.findByText(/can no longer authenticate/i)).toBeInTheDocument()
  })

  it('rejects a malformed contact email before calling the server', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    render(<RegistryConnectPanel />)
    await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
    await userEvent.type(screen.getByLabelText(/email/i), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: /request registration/i }))
    expect(await screen.findByText(/full contact email/i)).toBeInTheDocument()
    expect(api.requestRegistryConnection).not.toHaveBeenCalled()
  })

  // `recovery_in_progress` is deliberately NOT in this table: it re-syncs via
  // load() rather than setting form copy, so it needs its own mock and gets its
  // own test below.
  it.each([
    ['org_name_taken', /already taken/i],
    ['registration_capacity', /not accepting new registrations/i],
    ['rate_limited', /too many registration attempts/i],
    ['invalid_contact_email', /not a valid/i],
    // The registry maps some register conflicts to jti_replayed. Copy must read
    // as "could not complete", never surface "replay attack" to an operator.
    ['jti_replayed', /could not be completed/i],
  ])('renders distinct copy for %s', async (code, matcher) => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    vi.mocked(api.requestRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code })
    )
    render(<RegistryConnectPanel />)
    await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@x.io')
    await userEvent.click(screen.getByRole('button', { name: /request registration/i }))
    expect(await screen.findByText(matcher)).toBeInTheDocument()
  })

  // control-api now sends a non-empty deployment_info, so these become reachable.
  // They share the generic fallback copy — the bar here is just "doesn't crash or
  // render blank".
  it.each(['invalid_deployment_info', 'deployment_info_too_large'])(
    'falls back to the generic registration error for %s without crashing',
    async code => {
      vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
      vi.mocked(api.requestRegistryConnection).mockRejectedValue(
        Object.assign(new Error('x'), { code })
      )
      render(<RegistryConnectPanel />)
      await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
      await userEvent.type(screen.getByLabelText(/email/i), 'a@x.io')
      await userEvent.click(screen.getByRole('button', { name: /request registration/i }))
      expect(
        await screen.findByText(/Could not request registration\. Try again shortly\./i)
      ).toBeInTheDocument()
    }
  )

  it('re-syncs to the connecting view when a re-request is refused', async () => {
    vi.mocked(api.getRegistryConnection)
      .mockResolvedValueOnce({ state: 'disconnected' })
      .mockResolvedValue({ state: 'connecting', deploymentId: 'dep-1', requestedOrgName: 'acme' })
    vi.mocked(api.requestRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'recovery_in_progress' })
    )
    render(<RegistryConnectPanel />)
    await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@x.io')
    await userEvent.click(screen.getByRole('button', { name: /request registration/i }))
    expect(await screen.findByRole('button', { name: /finish connecting/i })).toBeInTheDocument()
  })

  it('completes the connection via the recover button', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockResolvedValue({
      state: 'connected',
      org: 'acme',
      authEnabled: true,
    })
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    expect(await screen.findByText(/Connected to the Evenfire Registry.*@acme/)).toBeInTheDocument()
  })

  // Renamed from the original "shows a retry message when recovery is not yet
  // finished" — that name was misleading. This drives a REJECTION (the
  // client_unavailable catch arm), not a resolved-but-not-connected response.
  // The resolved-but-not-connected case is covered separately below.
  it('shows contact-support copy when recovery reports client_unavailable', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'client_unavailable' })
    )
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    expect(
      await screen.findByText(/can no longer authenticate. Contact support/i)
    ).toBeInTheDocument()
  })

  // handleRecover's terminal arm (already_claimed / connection_superseded)
  // drives the "Disconnect, then register again" copy. This is distinct from
  // the "shows the terminal message when recovery is already claimed" test
  // above, which exercises GET's recoveryError JSX, not this REJECTION path.
  // Deleting this catch branch would keep the suite green while the user
  // retries forever, spending an unthrottled registry rotate each time.
  it('shows terminal disconnect-and-restart copy when recovery reports already_claimed', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'already_claimed' })
    )
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    expect(
      await screen.findByText(/one-time credentials were issued but never stored/i)
    ).toBeInTheDocument()
  })

  // IMPORTANT-1 fix: handleRequest's direct `connecting` branch (:129-136) had
  // zero coverage — every other connecting-view test reached that state via
  // GET/load(), never via requestRegistryConnection() itself resolving
  // 'connecting'. Without this test, collapsing that branch into the final
  // `else` (rendering `pending` + the "must approve it" toast) would leave the
  // suite green while telling an auto-approved-but-unclaimed user to wait for
  // an operator who will never act.
  it('lands on the connecting view directly when the request resolves connecting', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    vi.mocked(api.requestRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await userEvent.type(await screen.findByLabelText(/organization/i), 'acme')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@x.io')
    await userEvent.click(screen.getByRole('button', { name: /request registration/i }))
    expect(await screen.findByRole('button', { name: /finish connecting/i })).toBeInTheDocument()
    expect(screen.getByText(/Registered — finishing the connection\./i)).toBeInTheDocument()
    // Toast is a separate mutation from the view — same hazard as the
    // connected-view test above, now for the connecting case.
    expect(screen.queryByText(/must approve it/i)).toBeNull()
  })

  // IMPORTANT-2 fix: the remaining four of handleRecover's six outcome
  // branches (:211-213 resolved-non-connected, :221 deployment_suspended,
  // :225 not_recoverable, :226 the generic catch-all) had no coverage.

  it('re-syncs and shows a still-finishing message when recover resolves without connecting', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    expect(
      await screen.findByText(/Still finishing the connection\. Try again in a moment\./i)
    ).toBeInTheDocument()
    // Proves the `await load()` re-sync actually ran, not just that some
    // message appeared — the GET mock is hit once on mount and once here.
    expect(api.getRegistryConnection).toHaveBeenCalledTimes(2)
  })

  it('shows suspended copy when recovery reports deployment_suspended', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'deployment_suspended' })
    )
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    expect(
      await screen.findByText(/This deployment has been suspended by Evenfire\. Contact support\./i)
    ).toBeInTheDocument()
  })

  it('re-syncs without an error message when recovery reports not_recoverable', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'not_recoverable' })
    )
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    await waitFor(() => expect(api.getRegistryConnection).toHaveBeenCalledTimes(2))
    // Distinguishes the silent re-sync from the generic catch-all, which DOES
    // set a formError.
    expect(screen.queryByText(/Could not finish connecting/i)).toBeNull()
    expect(screen.getByRole('button', { name: /finish connecting/i })).toBeInTheDocument()
  })

  it('falls back to the generic finish-connecting error for an unmapped recover code', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(api.recoverRegistryConnection).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'something_unmapped' })
    )
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /finish connecting/i }))
    expect(
      await screen.findByText(/Could not finish connecting\. Try again shortly\./i)
    ).toBeInTheDocument()
  })

  // --- Addition: Disconnect/Start over on the `connecting` view must be gated by
  // confirm(), because it is now the only remaining path that can delete a
  // recoverable deployment's keypair and permanently squat its org name.
  it('start over on the connecting view requires confirmation before disconnecting', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    const confirmMock = vi.fn().mockResolvedValue(true)
    vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
      confirm: confirmMock,
      confirmDialog: null,
    })
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /start over/i }))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const message = confirmMock.mock.calls[0]?.[0]?.message as string
    expect(message).toMatch(/lost permanently/i)
    expect(message).toMatch(/cannot be recovered/i)
    await waitFor(() => expect(api.disconnectRegistryConnection).toHaveBeenCalledTimes(1))
  })

  it('does not disconnect the connecting view when Start over is cancelled', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
      confirm: vi.fn().mockResolvedValue(false),
      confirmDialog: null,
    })
    render(<RegistryConnectPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /start over/i }))
    expect(api.disconnectRegistryConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /finish connecting/i })).toBeInTheDocument()
  })

  it('does not render a bare Disconnect button on the connecting view', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connecting',
      deploymentId: 'dep-1',
      requestedOrgName: 'acme',
    })
    render(<RegistryConnectPanel />)
    await screen.findByRole('button', { name: /finish connecting/i })
    expect(screen.queryByRole('button', { name: /^disconnect$/i })).toBeNull()
  })
})
