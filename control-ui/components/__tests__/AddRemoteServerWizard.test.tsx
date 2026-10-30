import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as clipboard from '../../lib/clipboard'
import * as remoteMcp from '../../lib/remoteMcp'
import type { DiscoverRemoteResponse, RemoteTransportProbe } from '../../lib/remoteMcp.types'
import {
  TRANSPORT_INCONCLUSIVE_TIMEOUT,
  VERCEL_TRANSPORT_DEAD,
} from '../../test/fixtures/remoteMcpDiscovery'
import {
  ATLASSIAN_DISCOVER,
  ATLASSIAN_DISCOVER_UNCONFIGURED,
  CALLBACK_UNCONFIGURED_FAILURE,
  ENTRA_EMPTY_SCOPE_DISCOVER,
  ENTRA_NO_SCOPES_DISCOVER,
  ENTRA_UNKNOWN_GUID_DISCOVER,
  ENTRA_UNKNOWN_TENANT_DISCOVER_FAILURE,
  LINEAR_DISCOVER,
  LINEAR_DISCOVER_UNCONFIGURED,
  LINEAR_INSTALLED,
  NOTION_DISCOVER,
  OLDER_CONTROL_API_DCR_DISCOVER,
  PRE_REGISTERED_PER_SERVER_DISCOVER,
  PRE_REGISTERED_PER_SERVER_INSTALLED,
  PRE_REGISTERED_SHARED_INSTALLED,
  SCOPE_AUDIENCE_MISSING_FAILURE,
  SCOPE_AUDIENCE_UNVERIFIED_FAILURE,
  SCOPE_LIMIT_EXCEEDED_FAILURE,
  WORKIQ_DISCOVER,
  WORKIQ_DISCOVER_TENANT_REQUIRED,
  WORKIQ_INSTALLED,
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

// Spied, not stubbed: the wizard must not read Contexts at all.
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, getContexts: vi.fn(actual.getContexts) }
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
  // mockClear keeps queued *Once values; reset so an unused one cannot leak into the
  // next test, then restore the default successful copy.
  copyMock.mockReset()
  copyMock.mockResolvedValue(true)
  // Same for the network stubs: a test that fails before consuming its queued answers
  // must not hand them to the next one.
  discoverMock.mockReset()
  installMock.mockReset()
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
  await screen.findByPlaceholderText('https://mcp.example.com/mcp')
  fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
    target: { value: baseUrl },
  })
  fireEvent.change(screen.getByPlaceholderText('example-remote'), { target: { value: name } })
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
    expect(screen.getByDisplayValue('default')).toBeInTheDocument()
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
    // Valid name, but a non-https URL — the base URL gate must block detect.
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
        baseUrl: 'https://mcp.linear.app/mcp',
        mode: 'cimd',
        grantScope: 'user',
      })
    )
    // Without a profile, the untouched advertised scopes are left to control-api.
    expect(lastInstallBody()).not.toHaveProperty('scopes')
    expect(lastInstallBody()).not.toHaveProperty('contextRef')
    expect(getContextsMock).not.toHaveBeenCalled()
    expect(screen.queryByText('Context')).not.toBeInTheDocument()
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1))
    // The server is enabled in no Context yet, so the success copy points at agent access.
    expect(
      await screen.findByText(
        'Remote server linear installed. Give agents access from the Installed Connectors list whenever you’re ready.'
      )
    ).toBeInTheDocument()
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
    expect(
      screen.getByText(
        /is installed\. Register this redirect URI in the provider’s OAuth client, then give agents access from the Installed Connectors list\./
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Users can connect once/)).not.toBeInTheDocument()
    expect(screen.queryByText(/differs from the one shown before/i)).not.toBeInTheDocument()
    // The URI the operator copies after install is the one control-api reported.
    fireEvent.click(screen.getByRole('button', { name: 'Copy redirect URI' }))
    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith(PRE_REGISTERED_PER_SERVER_INSTALLED.redirectUri)
    )
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

  // ── Microsoft Entra ID (tenant prompt, editable scopes, profile) ───────────

  const WORKIQ_URL = 'https://workiq.svc.cloud.microsoft/mcp'
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'
  const TENANT_AUTHORITY = `https://login.microsoftonline.com/${TENANT}/v2.0`

  function tenantInput() {
    return screen.getByLabelText(/Microsoft Entra tenant ID/)
  }

  function scopesInput() {
    return screen.getByLabelText('Scopes')
  }

  function lastInstallBody() {
    const calls = installMock.mock.calls
    return calls[calls.length - 1]?.[0]
  }

  /** Detect → tenant_required → type the tenant → Detect against `body`. */
  async function detectEntra(body: DiscoverRemoteResponse, tenant = TENANT) {
    discoverMock
      .mockRejectedValueOnce(apiErrorFrom(WORKIQ_DISCOVER_TENANT_REQUIRED))
      .mockResolvedValueOnce(body)
    const utils = renderWizard()
    await fillIdentity(WORKIQ_URL, 'workiq')
    clickDetect()
    await screen.findByLabelText(/Microsoft Entra tenant ID/)
    fireEvent.change(tenantInput(), { target: { value: tenant } })
    clickDetect()
    await screen.findByLabelText('Scopes')
    return utils
  }

  function fillCredentials() {
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: 'cid' } })
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 'secret' } })
  }

  async function toConfirm() {
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    return screen.findByRole('button', { name: 'Install remote server' })
  }

  it('entra 1: tenant_required asks for the tenant instead of showing an error', async () => {
    discoverMock.mockRejectedValueOnce(apiErrorFrom(WORKIQ_DISCOVER_TENANT_REQUIRED))
    renderWizard()
    await fillIdentity(WORKIQ_URL, 'workiq')
    clickDetect()

    expect(await screen.findByLabelText(/Microsoft Entra tenant ID/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Still on step 0, waiting for the tenant.
    expect(screen.getByRole('button', { name: 'Detect' })).toBeDisabled()
  })

  it('entra 2: a tenant that is not a GUID keeps Detect disabled and says why', async () => {
    discoverMock.mockRejectedValueOnce(apiErrorFrom(WORKIQ_DISCOVER_TENANT_REQUIRED))
    renderWizard()
    await fillIdentity(WORKIQ_URL, 'workiq')
    clickDetect()
    await screen.findByLabelText(/Microsoft Entra tenant ID/)

    fireEvent.change(tenantInput(), { target: { value: 'contoso.onmicrosoft.com' } })
    expect(screen.getByRole('button', { name: 'Detect' })).toBeDisabled()
    expect(screen.getByText(/Enter the tenant ID as a GUID/)).toBeInTheDocument()
    expect(discoverMock).toHaveBeenCalledTimes(1)
  })

  it('entra 3: an upper-case GUID is sent as the lower-case tenant authority', async () => {
    await detectEntra(WORKIQ_DISCOVER, TENANT.toUpperCase())
    expect(discoverMock).toHaveBeenCalledTimes(2)
    expect(discoverMock).toHaveBeenNthCalledWith(1, WORKIQ_URL)
    expect(discoverMock).toHaveBeenNthCalledWith(2, WORKIQ_URL, TENANT_AUTHORITY)
  })

  it('entra 4: shows the Entra profile, the unsent resource and the advertised scopes', async () => {
    await detectEntra(WORKIQ_DISCOVER)
    const summary = screen.getByRole('region', { name: 'Detected OAuth configuration' })
    expect(summary).toHaveTextContent('Authorization serverMicrosoft Entra ID')
    expect(summary).toHaveTextContent(
      `${WORKIQ_DISCOVER.detected.resource} (not sent to Microsoft Entra ID)`
    )
    expect(scopesInput()).toHaveValue(WORKIQ_DISCOVER.detected.scopes.join(' '))
    expect(screen.queryByText(/does not support token refresh/i)).not.toBeInTheDocument()

    fillCredentials()
    await toConfirm()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('entra 5: the install sends the shown scopes and the tenant authority', async () => {
    installMock.mockResolvedValue(WORKIQ_INSTALLED)
    await detectEntra(WORKIQ_DISCOVER)
    fillCredentials()
    await toConfirm()
    // The confirm step lists the scopes that will be requested.
    expect(screen.getByRole('region', { name: 'Install summary' })).toHaveTextContent(
      `Scopes${WORKIQ_DISCOVER.detected.scopes.join(' ')}`
    )
    fireEvent.click(screen.getByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()).toMatchObject({
      serverName: 'workiq',
      mode: 'pre-registered',
      authorizationServer: TENANT_AUTHORITY,
      scopes: WORKIQ_DISCOVER.detected.scopes,
    })
    expect(lastInstallBody()).not.toHaveProperty('confirmedUnverifiedScopes')
    expect(await screen.findByRole('textbox', { name: 'Redirect URI' })).toHaveValue(
      WORKIQ_INSTALLED.redirectUri
    )
  })

  it('entra 5b: edited scopes are what the install sends', async () => {
    installMock.mockResolvedValue(WORKIQ_INSTALLED)
    await detectEntra(WORKIQ_DISCOVER)
    fireEvent.change(scopesInput(), {
      target: { value: 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask' },
    })
    fillCredentials()
    await toConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()?.scopes).toEqual(['api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'])
  })

  it('entra 5c: an emptied field with the profile still sends the advertised list', async () => {
    installMock.mockResolvedValue(WORKIQ_INSTALLED)
    await detectEntra(WORKIQ_DISCOVER)
    fireEvent.change(scopesInput(), { target: { value: '   ' } })
    fillCredentials()
    await toConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()?.scopes).toEqual(WORKIQ_DISCOVER.detected.scopes)
  })

  it('entra 6: editing the URL drops the tenant prompt', async () => {
    discoverMock.mockRejectedValueOnce(apiErrorFrom(WORKIQ_DISCOVER_TENANT_REQUIRED))
    renderWizard()
    await fillIdentity(WORKIQ_URL, 'workiq')
    clickDetect()
    await screen.findByLabelText(/Microsoft Entra tenant ID/)
    fireEvent.change(tenantInput(), { target: { value: TENANT } })

    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
      target: { value: 'https://mcp.linear.app/mcp' },
    })
    expect(screen.queryByLabelText(/Microsoft Entra tenant ID/)).not.toBeInTheDocument()

    // A later tenant_required for the new URL starts from an empty tenant.
    discoverMock.mockRejectedValueOnce(apiErrorFrom(WORKIQ_DISCOVER_TENANT_REQUIRED))
    clickDetect()
    expect(await screen.findByLabelText(/Microsoft Entra tenant ID/)).toHaveValue('')
    expect(discoverMock).toHaveBeenLastCalledWith('https://mcp.linear.app/mcp')
  })

  it('entra 7: a server advertising no scopes installs with an empty field and no scopes', async () => {
    // No golden advertises an empty list; Linear's body with only `scopes` emptied stands
    // for a PRM and AS that both omit scopes_supported (the backend then derives []).
    const noScopes: DiscoverRemoteResponse = {
      ...LINEAR_DISCOVER,
      detected: { ...LINEAR_DISCOVER.detected, scopes: [] },
    }
    discoverMock.mockResolvedValue(noScopes)
    installMock.mockResolvedValue(LINEAR_INSTALLED)
    renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    expect(await screen.findByLabelText('Scopes')).toHaveValue('')

    const install = await toConfirm()
    expect(install).toBeEnabled()
    fireEvent.click(install)
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()).not.toHaveProperty('scopes')
    expect(lastInstallBody()).not.toHaveProperty('authorizationServer')
  })

  it('entra 7b: without a profile, untouched scopes are not sent and edited ones are', async () => {
    discoverMock.mockResolvedValue(LINEAR_DISCOVER)
    installMock.mockResolvedValue(LINEAR_INSTALLED)
    renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    await screen.findByLabelText('Scopes')
    fireEvent.change(scopesInput(), { target: { value: 'read' } })
    fireEvent.click(await toConfirm())
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()?.scopes).toEqual(['read'])
  })

  it('entra 9: an unverifiable advertised scope must be confirmed, and the confirmation is sent', async () => {
    installMock.mockResolvedValue(WORKIQ_INSTALLED)
    const unverified = ENTRA_UNKNOWN_GUID_DISCOVER.detected.unverifiedScopes ?? []
    expect(unverified.length).toBeGreaterThan(0)
    await detectEntra(ENTRA_UNKNOWN_GUID_DISCOVER)
    fillCredentials()
    const install = await toConfirm()

    const notice = screen.getByText(/cannot tie to this server/).closest('[role="status"]')
    expect(notice).not.toBeNull()
    for (const scope of unverified) expect(notice).toHaveTextContent(scope)
    const confirm = screen.getByRole('checkbox', {
      name: 'I confirm these scopes belong to this server’s own API.',
    })
    expect(install).toBeDisabled()

    fireEvent.click(confirm)
    expect(install).toBeEnabled()
    fireEvent.click(install)
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()?.confirmedUnverifiedScopes).toEqual(unverified)
  })

  it('entra 9b: going back clears a confirmation', async () => {
    await detectEntra(ENTRA_UNKNOWN_GUID_DISCOVER)
    fillCredentials()
    await toConfirm()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    const install = await toConfirm()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(install).toBeDisabled()
  })

  it('entra 9c: scopes edited to the host form drop the advertised list to confirm', async () => {
    installMock.mockResolvedValue(WORKIQ_INSTALLED)
    expect(ENTRA_UNKNOWN_GUID_DISCOVER.detected.unverifiedScopes?.length).toBeGreaterThan(0)
    const hostScope = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'
    await detectEntra(ENTRA_UNKNOWN_GUID_DISCOVER)
    fireEvent.change(scopesInput(), { target: { value: hostScope } })
    fillCredentials()
    const install = await toConfirm()

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot tie to this server/)).not.toBeInTheDocument()
    expect(install).toBeEnabled()
    fireEvent.click(install)
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()?.scopes).toEqual([hostScope])
    expect(lastInstallBody()).not.toHaveProperty('confirmedUnverifiedScopes')
  })

  it('entra 10: an edited scope the backend cannot verify turns into the confirmation', async () => {
    const edited = (SCOPE_AUDIENCE_UNVERIFIED_FAILURE.body as { scopes: string[] }).scopes
    installMock
      .mockRejectedValueOnce(apiErrorFrom(SCOPE_AUDIENCE_UNVERIFIED_FAILURE))
      .mockResolvedValueOnce(WORKIQ_INSTALLED)
    await detectEntra(WORKIQ_DISCOVER)
    fireEvent.change(scopesInput(), { target: { value: edited.join(' ') } })
    fillCredentials()
    const install = await toConfirm()
    // The discover-time list does not cover edited scopes: nothing to confirm yet.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(install)

    const confirm = await screen.findByRole('checkbox')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(install).toBeDisabled()
    expect(lastInstallBody()).not.toHaveProperty('confirmedUnverifiedScopes')

    fireEvent.click(confirm)
    fireEvent.click(install)
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(2))
    expect(lastInstallBody()).toMatchObject({ scopes: edited, confirmedUnverifiedScopes: edited })
  })

  it('entra 11: a known GUID scope for its own host needs no confirmation', async () => {
    expect(WORKIQ_DISCOVER.detected.unverifiedScopes).toBeUndefined()
    await detectEntra(WORKIQ_DISCOVER)
    fillCredentials()
    const install = await toConfirm()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot tie to this server/)).not.toBeInTheDocument()
    expect(install).toBeEnabled()
  })

  it('entra 12: sign-in scopes only warn on detect and the install explains the 400', async () => {
    installMock.mockRejectedValueOnce(apiErrorFrom(SCOPE_AUDIENCE_MISSING_FAILURE))
    await detectEntra(ENTRA_NO_SCOPES_DISCOVER)
    const banner = screen.getByText(/doesn’t advertise its own scope/)
    expect(banner.closest('[role="status"]')).not.toBeNull()

    fillCredentials()
    fireEvent.click(await toConfirm())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Add this server’s own scope. Sign-in scopes alone (openid, profile, email, offline_access) would send a Microsoft Graph token to the server.'
    )
  })

  it('entra 12b: an empty advertised scope still raises the audience warning', async () => {
    expect(ENTRA_EMPTY_SCOPE_DISCOVER.detected.scopeAudienceViolation).toBe('')
    await detectEntra(ENTRA_EMPTY_SCOPE_DISCOVER)
    const banner = screen.getByText(/The server advertises an empty scope/)
    expect(banner.closest('[role="status"]')).not.toBeNull()
    expect(banner).not.toHaveTextContent('""')
  })

  it('entra 13: 128 scopes pass the field; the backend limit message is shown', async () => {
    installMock.mockRejectedValueOnce(apiErrorFrom(SCOPE_LIMIT_EXCEEDED_FAILURE))
    await detectEntra(WORKIQ_DISCOVER)
    const many = Array.from({ length: 128 }, (_, i) => `api://workiq.svc.cloud.microsoft/Scope${i}`)
    fireEvent.change(scopesInput(), { target: { value: many.join(' ') } })
    expect(screen.queryByText(/At most 128 scopes/)).not.toBeInTheDocument()

    fillCredentials()
    fireEvent.click(await toConfirm())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      (SCOPE_LIMIT_EXCEEDED_FAILURE.body as { message: string }).message
    )
    expect(lastInstallBody()?.scopes).toEqual(many)
  })

  it('entra: a scope with characters OAuth forbids blocks Continue with the profile', async () => {
    await detectEntra(WORKIQ_DISCOVER)
    fireEvent.change(scopesInput(), { target: { value: 'bad"scope' } })
    expect(screen.getByText(/contains characters OAuth does not allow/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('entra: a tenant Entra does not know shows "did not recognize" and keeps the tenant', async () => {
    const unknownTenant = '00000000-0000-0000-0000-000000000001'
    discoverMock
      .mockRejectedValueOnce(apiErrorFrom(WORKIQ_DISCOVER_TENANT_REQUIRED))
      .mockRejectedValueOnce(apiErrorFrom(ENTRA_UNKNOWN_TENANT_DISCOVER_FAILURE))
    renderWizard()
    await fillIdentity(WORKIQ_URL, 'workiq')
    clickDetect()
    await screen.findByLabelText(/Microsoft Entra tenant ID/)
    fireEvent.change(tenantInput(), { target: { value: unknownTenant } })
    clickDetect()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Microsoft Entra ID did not recognize this tenant ID.'
    )
    expect(tenantInput()).toHaveValue(unknownTenant)
    expect(screen.getByRole('button', { name: 'Detect' })).toBeEnabled()
  })

  it('entra: editing the tenant after a detect forces a re-detect', async () => {
    await detectEntra(WORKIQ_DISCOVER)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()

    fireEvent.change(tenantInput(), { target: { value: '11111111-2222-3333-4444-555555555555' } })
    expect(screen.getByRole('button', { name: 'Detect' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Configure/ })).toBeDisabled()
  })

  it('without a profile, advertised scopes OAuth would reject are accepted as advertised', async () => {
    // No golden advertises a scope outside RFC 6749; Linear's body with only `scopes`
    // changed stands for a server whose PRM lists one (control-api copies the list as is).
    const nonConforming: DiscoverRemoteResponse = {
      ...LINEAR_DISCOVER,
      detected: { ...LINEAR_DISCOVER.detected, scopes: ['read', 'issues\\write'] },
    }
    discoverMock.mockResolvedValue(nonConforming)
    installMock.mockResolvedValue(LINEAR_INSTALLED)
    renderWizard()
    await fillIdentity('https://mcp.linear.app/mcp', 'linear')
    clickDetect()
    expect(await screen.findByLabelText('Scopes')).toHaveValue('read issues\\write')
    expect(screen.queryByText(/contains characters OAuth does not allow/)).not.toBeInTheDocument()

    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).toBeEnabled()
    fireEvent.click(await toConfirm())
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(lastInstallBody()).not.toHaveProperty('scopes')
  })
})
