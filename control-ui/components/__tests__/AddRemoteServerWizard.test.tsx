import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as remoteMcp from '../../lib/remoteMcp'
import type {
  DiscoverRemoteResponse,
  RemoteDetected,
  RemoteTransportProbe,
} from '../../lib/remoteMcp.types'
import { buildContextResource } from '../../test/fixtures/contextResource'
import {
  DCR_PUBLIC_DETECTED,
  NOTION_DETECTED,
  NOTION_TRANSPORT_ALIVE,
  TRANSPORT_INCONCLUSIVE_TIMEOUT,
  VERCEL_TRANSPORT_DEAD,
} from '../../test/fixtures/remoteMcpDiscovery'
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

/** The discover response shape control-api returns: `detected` plus the probe. */
function discovered(
  detected: RemoteDetected,
  transport?: RemoteTransportProbe
): DiscoverRemoteResponse {
  return { detected, transport }
}

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
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED))
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
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED))
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
    discoverMock.mockResolvedValue(discovered(manualDetected))
    renderWizard()
    await fillIdentity()
    clickDetect()

    expect(await screen.findByLabelText(/Client ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Client secret/)).toBeInTheDocument()
    // The secret field is a password input.
    expect(screen.getByLabelText(/Client secret/)).toHaveAttribute('type', 'password')
  })

  it('does not show credential fields for cimd or dcr modes', async () => {
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED)) // cimd
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByLabelText(/Client ID/)).not.toBeInTheDocument()

    cleanup()
    discoverMock.mockResolvedValue(discovered(DCR_PUBLIC_DETECTED)) // dcr
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
    discoverMock.mockResolvedValue(discovered(noRefresh))
    renderWizard()
    await fillIdentity()
    clickDetect()
    expect(await screen.findByText(/does not support token refresh/i)).toBeInTheDocument()

    cleanup()
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED)) // supportsRefresh true
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByText(/does not support token refresh/i)).not.toBeInTheDocument()
  })

  it('installs successfully: sends the request, fires onInstalled, and toasts', async () => {
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED))
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
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED))
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

  // ── C5 transport probe ──────────────────────────────────────────────────────

  it('C5 transport dead: holds on step 0, alerts, offers the suggestion, and never shows Continue', async () => {
    // Repro for issue 26-09-25: OAuth valid but MCP transport dead at the typed
    // path. Against the parent head the wizard advances to step 1 instead.
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED, VERCEL_TRANSPORT_DEAD))
    renderWizard()
    await fillIdentity('https://mcp.vercel.com/mcp', 'vercel-mcp')
    clickDetect()

    // A dead probe surfaces an alert and holds step 0 (no configuration values).
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('https://mcp.vercel.com/')
    expect(screen.queryByText('https://mcp.notion.com/authorize')).not.toBeInTheDocument()

    // Never a "Continue" — the primary action stays "Detect".
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Detect' })).toBeInTheDocument()
    // The Configure rail step is not selectable.
    expect(screen.getByRole('button', { name: /Configure/ })).toBeDisabled()

    // Applying the suggestion loads it into the input and re-enables Detect.
    fireEvent.click(screen.getByRole('button', { name: 'Use https://mcp.vercel.com/' }))
    expect(screen.getByPlaceholderText('https://mcp.example.com/mcp')).toHaveValue(
      'https://mcp.vercel.com/'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Detect' })).toBeEnabled()
  })

  it('C5 transport inconclusive: advances and shows a status banner on the config and confirm steps', async () => {
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED, TRANSPORT_INCONCLUSIVE_TIMEOUT))
    renderWizard()
    await fillIdentity()
    clickDetect()

    // Advances to configuration with a non-blocking status banner.
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.getByText(/Couldn't confirm the MCP endpoint/i)).toBeInTheDocument()
    expect(
      screen.getByText(/Couldn't confirm the MCP endpoint/i).closest('[role="status"]')
    ).not.toBeNull()

    // The banner persists on the confirm step.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('button', { name: 'Install remote server' })
    expect(screen.getByText(/Couldn't confirm the MCP endpoint/i)).toBeInTheDocument()
  })

  it('C5 transport alive: advances with no transport banner and shows the reachable summary row', async () => {
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED, NOTION_TRANSPORT_ALIVE))
    renderWizard()
    await fillIdentity()
    clickDetect()

    await screen.findByText('https://mcp.notion.com/authorize')
    // A challenge probe reports the endpoint reachable (sign-in required).
    expect(screen.getByText('Reachable (sign-in required)')).toBeInTheDocument()
    // No transport warning/error banner (Notion also supports refresh → no status).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('C5 install transport_unreachable: shows the mapped error inline with the suggested URL', async () => {
    discoverMock.mockResolvedValue(discovered(NOTION_DETECTED, NOTION_TRANSPORT_ALIVE))
    installMock.mockRejectedValue(
      Object.assign(new Error('400'), {
        code: 'transport_unreachable',
        body: {
          error: 'transport_unreachable',
          detail: {
            probedUrl: 'https://mcp.vercel.com/mcp',
            httpStatus: 404,
            suggestedBaseUrl: 'https://mcp.vercel.com/',
          },
        },
      })
    )
    const { onInstalled } = renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    expect(await screen.findByText(/isn't reachable at that URL/i)).toBeInTheDocument()
    expect(screen.getByText(/https:\/\/mcp\.vercel\.com\//)).toBeInTheDocument()
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
