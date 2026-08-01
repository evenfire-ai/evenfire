import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as ConfirmDialogModule from '../ConfirmDialog'
import { GrantAccessModal } from '../PublisherView/GrantAccessModal'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  listOrgGrants: vi.fn(),
  createOrgGrant: vi.fn(),
  revokeOrgGrant: vi.fn(),
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

describe('GrantAccessModal', () => {
  it('lists current grants for the entry', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({
      grants: [{ id: 'g1', pluginName: '@acme/db', granteeOrg: 'beta' }],
    })
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    expect(await screen.findByText('@beta')).toBeInTheDocument()
    // pluginName normalized to @acme/db
    expect(api.listOrgGrants).toHaveBeenCalledWith('@acme/db')
  })

  it('shows the eyebrow with the scoped pluginName', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    render(<GrantAccessModal entryName="@acme/db" orgScope="acme" onClose={() => {}} />)
    expect(await screen.findByText(/sharing/i)).toBeInTheDocument()
    // The scoped plugin name appears in both the eyebrow and the field hint —
    // assert the eyebrow explicitly.
    expect(screen.getByText('Sharing', { exact: false }).closest('p')).toHaveTextContent('@acme/db')
  })

  it('grant success: POSTs { pluginName, granteeOrg } then refetches', async () => {
    vi.mocked(api.listOrgGrants)
      .mockResolvedValueOnce({ grants: [] })
      .mockResolvedValueOnce({ grants: [{ id: 'g1', pluginName: '@acme/db', granteeOrg: 'beta' }] })
    vi.mocked(api.createOrgGrant).mockResolvedValue({
      id: 'g1',
      pluginName: '@acme/db',
      granteeOrg: 'beta',
    })
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    fireEvent.change(await screen.findByLabelText(/grantee org/i), { target: { value: 'beta' } })
    fireEvent.click(screen.getByRole('button', { name: /grant access/i }))
    await waitFor(() =>
      expect(api.createOrgGrant).toHaveBeenCalledWith({
        pluginName: '@acme/db',
        granteeOrg: 'beta',
      })
    )
    expect(await screen.findByText('@beta')).toBeInTheDocument()
  })

  it('renders the typed error inline from the { code } body (grantee_not_found)', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    vi.mocked(api.createOrgGrant).mockRejectedValue(
      Object.assign(new Error('x'), { status: 404, code: 'grantee_not_found' })
    )
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    fireEvent.change(await screen.findByLabelText(/grantee org/i), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: /grant access/i }))
    expect(await screen.findByText(/no org found with that slug/i)).toBeInTheDocument()
  })

  it('renders self_grant inline', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    vi.mocked(api.createOrgGrant).mockRejectedValue(
      Object.assign(new Error('x'), { status: 400, code: 'self_grant' })
    )
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    fireEvent.change(await screen.findByLabelText(/grantee org/i), { target: { value: 'acme' } })
    fireEvent.click(screen.getByRole('button', { name: /grant access/i }))
    expect(await screen.findByText(/your own org/i)).toBeInTheDocument()
  })

  it('renders plugin_public inline', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    vi.mocked(api.createOrgGrant).mockRejectedValue(
      Object.assign(new Error('x'), { status: 400, code: 'plugin_public' })
    )
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    fireEvent.change(await screen.findByLabelText(/grantee org/i), { target: { value: 'beta' } })
    fireEvent.click(screen.getByRole('button', { name: /grant access/i }))
    expect(await screen.findByText(/public/i)).toBeInTheDocument()
  })

  it('revoke: confirm → DELETE → success toast + refetch', async () => {
    vi.mocked(api.listOrgGrants)
      .mockResolvedValueOnce({ grants: [{ id: 'g1', pluginName: '@acme/db', granteeOrg: 'beta' }] })
      .mockResolvedValueOnce({ grants: [] })
    vi.mocked(api.revokeOrgGrant).mockResolvedValue(undefined)
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(api.revokeOrgGrant).toHaveBeenCalledWith('g1')
      expect(api.listOrgGrants).toHaveBeenCalledTimes(2)
    })
  })

  it('closes when the close button is clicked', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    const onClose = vi.fn()
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={onClose} />)
    await screen.findByLabelText(/grantee org/i)
    // The footer "Close" button is distinct from the icon close button (which
    // uses aria-label="Close"); match by visible text to disambiguate.
    fireEvent.click(screen.getByText('Close', { selector: 'button' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when Escape is pressed', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    const onClose = vi.fn()
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={onClose} />)
    await screen.findByLabelText(/grantee org/i)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('restores focus to the Share access trigger when the dialog closes', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    function Harness() {
      const [open, setOpen] = useState(false)
      const opener = useRef<HTMLButtonElement | null>(null)
      return (
        <>
          <button ref={opener} type="button" onClick={() => setOpen(true)}>
            Share access
          </button>
          {open ? (
            <GrantAccessModal
              entryName="db"
              orgScope="acme"
              opener={opener.current}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Share access' })
    fireEvent.click(trigger)
    await screen.findByLabelText(/grantee org/i)
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('does not close the grant dialog when Escape cancels a revoke confirmation', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({
      grants: [{ id: 'g1', pluginName: '@acme/db', granteeOrg: 'beta' }],
    })
    let resolveConfirmation!: (value: boolean) => void
    vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
      confirm: vi.fn().mockReturnValue(
        new Promise(resolve => {
          resolveConfirmation = resolve
        })
      ),
      confirmDialog: <div role="alertdialog">Revoke access</div>,
    })
    const onClose = vi.fn()
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    await screen.findByRole('alertdialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    resolveConfirmation(false)
  })

  it('Enter in the grantee input submits the grant', async () => {
    vi.mocked(api.listOrgGrants).mockResolvedValue({ grants: [] })
    vi.mocked(api.createOrgGrant).mockResolvedValue({
      id: 'g1',
      pluginName: '@acme/db',
      granteeOrg: 'beta',
    })
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    const input = await screen.findByLabelText(/grantee org/i)
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(api.createOrgGrant).toHaveBeenCalledWith({
        pluginName: '@acme/db',
        granteeOrg: 'beta',
      })
    )
  })

  it('shows retry banner when grant list fails to load', async () => {
    vi.mocked(api.listOrgGrants).mockRejectedValue(new Error('boom'))
    render(<GrantAccessModal entryName="db" orgScope="acme" onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
