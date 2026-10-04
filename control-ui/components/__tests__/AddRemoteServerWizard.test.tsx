import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as clipboard from '../../lib/clipboard'
import * as remoteMcp from '../../lib/remoteMcp'
import type { DiscoverRemoteResponse, RemoteTransportProbe } from '../../lib/remoteMcp.types'
import { buildContextResource } from '../../test/fixtures/contextResource'
import {
  TRANSPORT_INCONCLUSIVE_TIMEOUT,
  VERCEL_TRANSPORT_DEAD,
} from '../../test/fixtures/remoteMcpDiscovery'
import {
  ATLASSIAN_DISCOVER,
  ATLASSIAN_DISCOVER_UNCONFIGURED,
  CALLBACK_UNCONFIGURED_FAILURE,
  LINEAR_DISCOVER,
  LINEAR_DISCOVER_UNCONFIGURED,
  LINEAR_INSTALLED,
  NOTION_DISCOVER,
  OLDER_CONTROL_API_DCR_DISCOVER,
  PRE_REGISTERED_PER_SERVER_DISCOVER,
  PRE_REGISTERED_PER_SERVER_INSTALLED,
  PRE_REGISTERED_SHARED_INSTALLED,
  apiErrorFrom,
} from '../../test/fixtures/remoteMcpWire'
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

// The wizard copies through this helper; the test asserts what it is handed.
vi.mock('../../lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))

const discoverMock = vi.mocked(remoteMcp.discoverRemoteServer)
const copyMock = vi.mocked(clipboard.copyTextToClipboard)
const installMock = vi.mocked(remoteMcp.installRemoteServer)
const getContextsMock = vi.mocked(api.getContexts)

/**
 * A captured control-api discover body (goldens from the real router), optionally with
 * the transport probe swapped for another probe outcome of the same producer.
 */
function discovered(
  body: DiscoverRemoteResponse,
  transport?: RemoteTransportProbe
): DiscoverRemoteResponse {
  return transport ? { ...body, transport } : body
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
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER))
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
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER))
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

  it('keeps Detect disabled and shows an error for a malformed base URL (no detect round-trip)', async () => {
    renderWizard()
    // Valid name + context, but a non-https URL — the base URL gate must block detect.
    await fillIdentity('http://mcp.notion.com/mcp')

    const detect = screen.getByRole('button', { name: 'Detect' })
    expect(detect).toBeDisabled()
    expect(screen.getByText(/must use https/i)).toBeInTheDocument()

    // Correcting it to https clears the gate.
    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
      target: { value: 'https://mcp.notion.com/mcp' },
    })
    expect(screen.getByRole('button', { name: 'Detect' })).toBeEnabled()
    // The malformed URL never reached control-api.
    expect(discoverMock).not.toHaveBeenCalled()
  })

  it('shows client credential fields only for the manual (pre-registered) mode', async () => {
    discoverMock.mockResolvedValue(discovered(PRE_REGISTERED_PER_SERVER_DISCOVER))
    renderWizard()
    await fillIdentity()
    clickDetect()

    expect(await screen.findByLabelText(/Client ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Client secret/)).toBeInTheDocument()
    // The secret field is a password input.
    expect(screen.getByLabelText(/Client secret/)).toHaveAttribute('type', 'password')
  })

  it('does not show credential fields for cimd or dcr modes', async () => {
    discoverMock.mockResolvedValue(discovered(LINEAR_DISCOVER)) // cimd
    renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    await screen.findByText('https://mcp.linear.app/authorize')
    expect(screen.queryByLabelText(/Client ID/)).not.toBeInTheDocument()

    cleanup()
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER)) // dcr
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByLabelText(/Client ID/)).not.toBeInTheDocument()
  })

  it('D-8: shows the no-refresh warning banner iff supportsRefresh is false', async () => {
    // No recorded pilot lacks refresh; only the quirk the banner reads is changed.
    const noRefresh: DiscoverRemoteResponse = {
      ...NOTION_DISCOVER,
      detected: {
        ...NOTION_DISCOVER.detected,
        quirks: { bearerInBody: false, supportsRefresh: false },
      },
    }
    discoverMock.mockResolvedValue(discovered(noRefresh))
    renderWizard()
    await fillIdentity()
    clickDetect()
    expect(await screen.findByText(/does not support token refresh/i)).toBeInTheDocument()

    cleanup()
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER)) // supportsRefresh true
    renderWizard()
    await fillIdentity()
    clickDetect()
    await screen.findByText('https://mcp.notion.com/authorize')
    expect(screen.queryByText(/does not support token refresh/i)).not.toBeInTheDocument()
  })

  it('installs successfully: sends the request, fires onInstalled, and toasts', async () => {
    discoverMock.mockResolvedValue(discovered(LINEAR_DISCOVER))
    installMock.mockResolvedValue(LINEAR_INSTALLED)
    const { onInstalled } = renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    await screen.findByText('https://mcp.linear.app/authorize')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Confirm
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(installMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'linear',
        contextRef: 'research',
        baseUrl: 'https://mcp.linear.app/mcp',
        mode: 'cimd',
        grantScope: 'user',
      })
    )
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/installed\./i)).toBeInTheDocument()
  })

  it('shows a mapped install error inline', async () => {
    // Shared CIMD on a deployment without a callback base URL: detect does not block,
    // the install answers 503.
    discoverMock.mockResolvedValue(discovered(LINEAR_DISCOVER_UNCONFIGURED))
    installMock.mockRejectedValue(apiErrorFrom(CALLBACK_UNCONFIGURED_FAILURE))
    const { onInstalled } = renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    await screen.findByText('https://mcp.linear.app/authorize')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    const error = await screen.findByText(/callback url is not configured/i)
    expect(error).toHaveTextContent('CONTROL_API_OAUTH_CALLBACK_BASE_URL')
    expect(error).not.toHaveTextContent(/redirect URI of its own/i)
    expect(onInstalled).not.toHaveBeenCalled()
  })

  // ── C5 transport probe ──────────────────────────────────────────────────────

  it('C5 transport dead: holds on step 0, alerts, offers the suggestion, and never shows Continue', async () => {
    // Repro for issue 26-09-25: OAuth valid but MCP transport dead at the typed
    // path. Against the parent head the wizard advances to step 1 instead.
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER, VERCEL_TRANSPORT_DEAD))
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
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER, TRANSPORT_INCONCLUSIVE_TIMEOUT))
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
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER))
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
    discoverMock.mockResolvedValue(discovered(NOTION_DISCOVER))
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

  // ── Per-server callback (AS without RFC 9207) ──────────────────────────────

  async function detectPreRegisteredPerServer(name = 'linear-pre') {
    discoverMock.mockResolvedValue(discovered(PRE_REGISTERED_PER_SERVER_DISCOVER))
    const utils = renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', name)
    clickDetect()
    await screen.findByLabelText(/Client ID/)
    return utils
  }

  function perServerUri(name: string): string {
    const template = PRE_REGISTERED_PER_SERVER_DISCOVER.callback?.redirectUriTemplate ?? ''
    return template.replace('{serverName}', name)
  }

  it('pre-registered per-server: shows the redirect URI for this server name, with copy', async () => {
    await detectPreRegisteredPerServer('hubspot')
    const uri = screen.getByRole('textbox', { name: 'Redirect URI' })
    expect(uri).toHaveValue(perServerUri('hubspot'))
    expect(uri).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Copy redirect URI' })).toBeInTheDocument()
  })

  it('pre-registered per-server: Copy hands the shown URI to the clipboard and confirms', async () => {
    copyMock.mockClear()
    copyMock.mockResolvedValueOnce(true)
    await detectPreRegisteredPerServer('hubspot')
    fireEvent.click(screen.getByRole('button', { name: 'Copy redirect URI' }))

    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(perServerUri('hubspot')))
    expect(copyMock).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Redirect URI copied.')).toBeInTheDocument()
  })

  it('pre-registered per-server: a failed copy tells the operator to copy it by hand', async () => {
    copyMock.mockResolvedValueOnce(false)
    await detectPreRegisteredPerServer('hubspot')
    fireEvent.click(screen.getByRole('button', { name: 'Copy redirect URI' }))

    expect(
      await screen.findByText('Copy failed — select and copy the URI manually.')
    ).toBeInTheDocument()
  })

  it('pre-registered per-server: after the 201 holds on the URI until Done', async () => {
    installMock.mockResolvedValue(PRE_REGISTERED_PER_SERVER_INSTALLED)
    const { onInstalled } = await detectPreRegisteredPerServer()
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: 'cid' } })
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(installMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pre-registered', clientId: 'cid' })
    )
    const uri = await screen.findByRole('textbox', { name: 'Redirect URI' })
    expect(uri).toHaveValue(PRE_REGISTERED_PER_SERVER_INSTALLED.redirectUri)
    expect(screen.queryByText(/differs from the one shown before/i)).not.toBeInTheDocument()
    expect(onInstalled).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()

    // Enter in the read-only URI field must not submit a second install.
    fireEvent.submit(uri.closest('form') as HTMLFormElement)
    expect(installMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onInstalled).toHaveBeenCalledTimes(1)
  })

  it('pre-registered: the 201 URI wins when the AS changed since detection', async () => {
    installMock.mockResolvedValue(PRE_REGISTERED_SHARED_INSTALLED)
    await detectPreRegisteredPerServer()
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: 'cid' } })
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    const uri = await screen.findByRole('textbox', { name: 'Redirect URI' })
    expect(uri).toHaveValue(PRE_REGISTERED_SHARED_INSTALLED.redirectUri)
    expect(PRE_REGISTERED_SHARED_INSTALLED.redirectUri).not.toBe(perServerUri('linear-pre'))
    expect(screen.getByText(/differs from the one shown before/i)).toBeInTheDocument()
  })

  it('an AS without RFC 9207 behind an older control-api (no callback preview) is blocked', async () => {
    discoverMock.mockResolvedValue(OLDER_CONTROL_API_DCR_DISCOVER)
    renderWizard()
    await fillIdentity()
    clickDetect()

    expect(await screen.findByRole('alert')).toHaveTextContent(/update control-api/i)
    expect(
      screen.queryByRole('region', { name: 'Authorization server hosts' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('per-server without a configured callback base URL is blocked before install', async () => {
    discoverMock.mockResolvedValue(discovered(ATLASSIAN_DISCOVER_UNCONFIGURED))
    renderWizard()
    await fillIdentity('https://mcp.atlassian.com/v2/mcp', 'atlassian')
    clickDetect()

    expect(await screen.findByRole('alert')).toHaveTextContent(/callback URL is not configured/i)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled()
  })

  it('without RFC 9207, shows the AS endpoint hosts on the configure and confirm steps', async () => {
    discoverMock.mockResolvedValue(discovered(ATLASSIAN_DISCOVER))
    renderWizard()
    await fillIdentity('https://mcp.atlassian.com/v2/mcp', 'atlassian')
    clickDetect()

    const hosts = await screen.findByRole('region', { name: 'Authorization server hosts' })
    expect(hosts).toHaveTextContent('Token host')
    expect(hosts).toHaveTextContent('auth.atlassian.com')
    expect(screen.getByText(/does not identify itself in its OAuth responses/i)).toBeInTheDocument()
    // DCR registers its own URI: nothing for the operator to copy.
    expect(screen.queryByRole('textbox', { name: 'Redirect URI' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('button', { name: 'Install remote server' })
    expect(screen.getByRole('region', { name: 'Authorization server hosts' })).toHaveTextContent(
      'auth.atlassian.com'
    )
  })

  it('with RFC 9207 (shared callback), shows no endpoint hosts', async () => {
    discoverMock.mockResolvedValue(discovered(LINEAR_DISCOVER))
    renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    await screen.findByText('https://mcp.linear.app/authorize')
    expect(
      screen.queryByRole('region', { name: 'Authorization server hosts' })
    ).not.toBeInTheDocument()
  })
})
