import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as remoteMcp from '../../lib/remoteMcp'
import type { RemoteDetected } from '../../lib/remoteMcp.types'
import { buildContextResource } from '../../test/fixtures/contextResource'
import { DCR_PUBLIC_DETECTED, NOTION_DETECTED } from '../../test/fixtures/remoteMcpDiscovery'
import { AddRemoteServerWizard } from '../AddRemoteServerWizard'
import { ToastProvider } from '../Toast'

// Keep the real pure decision logic; only the two network calls are stubbed, so
// the mocked responses must carry the real contract shapes (fixtures above).
vi.mock('../../lib/remoteMcp', async importOriginal => ({
  ...(await importOriginal<typeof import('../../lib/remoteMcp')>()),
  discoverRemoteServer: vi.fn(),
  installRemoteServer: vi.fn(),
}))

// Keep isSilentApiError etc.; only getContexts is stubbed. The fixture import is
// done inside the factory because vi.mock is hoisted above top-level imports.
vi.mock('../../lib/api', async importOriginal => {
  const { buildContextResource } = await import('../../test/fixtures/contextResource')
  return {
    ...(await importOriginal<typeof import('../../lib/api')>()),
    getContexts: vi.fn().mockResolvedValue({
      items: [buildContextResource({ metadata: { name: 'research', resourceVersion: 'rv1' } })],
    }),
  }
})

const discoverMock = vi.mocked(remoteMcp.discoverRemoteServer)
const installMock = vi.mocked(remoteMcp.installRemoteServer)
const getContextsMock = vi.mocked(api.getContexts)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // vi.clearAllMocks resets the default resolved value, so restore it.
  getContextsMock.mockResolvedValue({
    items: [buildContextResource({ metadata: { name: 'research', resourceVersion: 'rv1' } })],
  })
})

function renderWizard(props?: Partial<Parameters<typeof AddRemoteServerWizard>[0]>) {
  const onInstalled = props?.onInstalled ?? vi.fn()
  const onCancel = props?.onCancel ?? vi.fn()
  const utils = rtlRender(
    <ToastProvider>
      <AddRemoteServerWizard
        pageHeader={<div>header</div>}
        onInstalled={onInstalled}
        onCancel={onCancel}
      />
    </ToastProvider>
  )
  return { ...utils, onInstalled, onCancel }
}

async function fillIdentity(baseUrl = 'https://mcp.notion.com/mcp', name = 'notion-remote') {
  // Wait until the context select is populated from getContexts (option present).
  await screen.findByRole('option', { name: 'research' })
  fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
    target: { value: baseUrl },
  })
  fireEvent.change(screen.getByPlaceholderText('example-remote'), { target: { value: name } })
  fireEvent.change(screen.getByRole('combobox', { name: /context/i }), {
    target: { value: 'research' },
  })
}

function clickDetect() {
  fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
}

describe('AddRemoteServerWizard', () => {
  it('detects a server and advances to the configuration step showing the detected values', async () => {
    discoverMock.mockResolvedValue(NOTION_DETECTED)
    renderWizard()
    await fillIdentity()
    clickDetect()

    await waitFor(() => expect(discoverMock).toHaveBeenCalledWith('https://mcp.notion.com/mcp'))
    // Detected OAuth config is rendered on the configuration step.
    expect(await screen.findByText('https://mcp.notion.com/authorize')).toBeInTheDocument()
    expect(screen.getByText('https://mcp.notion.com/token')).toBeInTheDocument()
    // Notion's issuer and resource share this value, so it appears more than once.
    expect(screen.getAllByText('https://mcp.notion.com').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('default')).toBeInTheDocument()
  })

  it('D-4: editing the URL after a detect invalidates it and blocks proceeding until re-detect', async () => {
    discoverMock.mockResolvedValue(NOTION_DETECTED)
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')

    // Back to the identity step and change the URL.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
      target: { value: 'https://mcp.linear.app/mcp' },
    })

    // The detection is cleared: the primary action is "Detect" again (not "Continue")…
    expect(screen.getByRole('button', { name: 'Detect' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    // …and the Configure rail step can no longer be selected.
    expect(screen.getByRole('button', { name: /Configure/ })).toBeDisabled()
  })

  it('shows client credential fields only for the manual (pre-registered) mode', async () => {
    // manual has no real probed pilot; this is UI state, not a producer fixture.
    const manualDetected: RemoteDetected = { ...NOTION_DETECTED, registrationMode: 'manual' }
    discoverMock.mockResolvedValue(manualDetected)
    renderWizard()
    await fillIdentity()
    clickDetect()

    expect(await screen.findByLabelText(/Client ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Client secret/)).toBeInTheDocument()
    // The secret field is a password input.
    expect(screen.getByLabelText(/Client secret/)).toHaveAttribute('type', 'password')
  })

  it('does not show credential fields for cimd or dcr modes', async () => {
    discoverMock.mockResolvedValue(NOTION_DETECTED) // cimd
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByLabelText(/Client ID/)).not.toBeInTheDocument()

    cleanup()
    discoverMock.mockResolvedValue(DCR_PUBLIC_DETECTED) // dcr
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByLabelText(/Client ID/)).not.toBeInTheDocument()
  })

  it('D-8: shows the no-refresh warning banner iff supportsRefresh is false', async () => {
    const noRefresh: RemoteDetected = {
      ...NOTION_DETECTED,
      quirks: { bearerInBody: false, supportsRefresh: false },
    }
    discoverMock.mockResolvedValue(noRefresh)
    renderWizard()
    await fillIdentity()
    clickDetect()
    expect(await screen.findByText(/does not support token refresh/i)).toBeInTheDocument()

    cleanup()
    discoverMock.mockResolvedValue(NOTION_DETECTED) // supportsRefresh true
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByText(/does not support token refresh/i)).not.toBeInTheDocument()
  })

  it('installs successfully: sends the request, fires onInstalled, and toasts', async () => {
    discoverMock.mockResolvedValue(NOTION_DETECTED)
    installMock.mockResolvedValue({
      serverName: 'notion-remote',
      namespace: 'mcp-server',
      contextRef: 'research',
      contextUpdated: true,
      clientMode: 'public',
      registrationMode: 'cimd',
    })
    const { onInstalled } = renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Confirm
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(installMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'notion-remote',
        contextRef: 'research',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'cimd',
        grantScope: 'user',
      })
    )
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/installed\./i)).toBeInTheDocument()
  })

  it('shows a mapped install error inline', async () => {
    discoverMock.mockResolvedValue(NOTION_DETECTED)
    installMock.mockRejectedValue(
      Object.assign(new Error('503'), { code: 'callback_base_url_unconfigured', body: {} })
    )
    const { onInstalled } = renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    expect(await screen.findByText(/callback url is not configured/i)).toBeInTheDocument()
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
