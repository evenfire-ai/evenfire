import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CONTROL_ROUTES } from '../../app/constants/routes'
import AddRemoteServerPage from '../../app/mcp-servers/remote/new/page'
import { apiSend, getRegistryEntryVersion } from '../../lib/api'
import type { RegistryEntry } from '../../lib/api'
import { REMOTE_MCP_BASE } from '../../lib/remoteMcp'
import type { DiscoverRemoteResponse, InstallRemoteResponse } from '../../lib/remoteMcp.types'
import {
  CATALOG_CIMD_DISCOVER,
  CATALOG_CIMD_INSTALLED,
  CATALOG_CLIENT_ID_IN_USE_FAILURE,
  CATALOG_DEAD_URL_DISCOVER,
  CATALOG_DRIFT_DCR_TO_MANUAL_DISCOVER,
  CATALOG_DRIFT_WITH_GUIDE_DISCOVER,
  CATALOG_INSTALL_IN_PROGRESS_FAILURE,
  CATALOG_INVALID_DISCOVER_FAILURE,
  CATALOG_ORG_PRE_REGISTERED_DISCOVER,
  CATALOG_SERVER_NAME_IN_USE_FAILURE,
  CATALOG_SLOT_RESIDUE_FAILURE,
  CATALOG_TRANSPORT_UNREACHABLE_FAILURE,
  CATALOG_WORKIQ_DISCOVER,
  CATALOG_WORKIQ_TENANT_REQUIRED,
  CURATOR_CIMD_ENTRY,
  CURATOR_CIMD_USER_ONLY_ENTRY,
  CURATOR_DCR_ON_MANUAL_AS_ENTRY,
  CURATOR_DCR_WITH_GUIDE_ON_MANUAL_AS_ENTRY,
  CURATOR_DEAD_URL_ENTRY,
  CURATOR_INVALID_ENTRY,
  CURATOR_WORKIQ_ENTRY,
  ORG_DCR_ENTRY,
  ORG_PRE_REGISTERED_ENTRY,
  PLAIN_REMOTE_ENTRY,
} from '../../test/fixtures/catalogRemoteOAuthWire'
import {
  ENTRA_UNKNOWN_TENANT_DISCOVER_FAILURE,
  SCOPE_AUDIENCE_UNVERIFIED_FAILURE,
  apiErrorFrom,
} from '../../test/fixtures/remoteMcpWire'
import { ToastProvider } from '../Toast'

/**
 * The remote wizard in Marketplace catalog mode, through the real page, loader and
 * request builders. Only the network boundary is doubled (`apiSend` and the entry
 * read), and every answer is a control-api golden (catalogRemoteOAuthWire), so the
 * assertions cover the exact body the wizard puts on the wire.
 */

const mockPush = vi.fn()
let mockQuery = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mockQuery),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, apiSend: vi.fn(), getRegistryEntryVersion: vi.fn() }
})

const apiSendMock = vi.mocked(apiSend)
const DISCOVER_PATH = `${REMOTE_MCP_BASE}/discover`
const MARKETPLACE = CONTROL_ROUTES.marketplace.connectors

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  apiSendMock.mockReset()
  vi.mocked(getRegistryEntryVersion).mockReset()
})

type Answer = { resolve: unknown } | { reject: unknown } | { pending: true }

/** Route `apiSend` by path: each call to a path takes the next queued answer. */
function serveApi(answers: { discover?: Answer[]; install?: Answer[] }) {
  const queues = { discover: [...(answers.discover ?? [])], install: [...(answers.install ?? [])] }
  apiSendMock.mockImplementation(async (_method: string, path: string) => {
    const queue = path === DISCOVER_PATH ? queues.discover : queues.install
    const next = queue.shift()
    if (!next) throw new Error(`unexpected call to ${path}`)
    if ('pending' in next) return new Promise(() => undefined)
    if ('reject' in next) throw next.reject
    return next.resolve
  })
}

function bodiesSentTo(path: string): Record<string, unknown>[] {
  return apiSendMock.mock.calls
    .filter(([, callPath]) => callPath === path)
    .map(([, , body]) => body as Record<string, unknown>)
}

function openPage(entry: RegistryEntry, query: string) {
  mockQuery = query
  vi.mocked(getRegistryEntryVersion).mockResolvedValue(entry)
  return render(
    <ToastProvider>
      <AddRemoteServerPage />
    </ToastProvider>
  )
}

function catalogQuery(entry: RegistryEntry, scope: 'user' | 'context', extra = ''): string {
  return `entry=${encodeURIComponent(entry.name)}&version=${entry.version}&scope=${scope}${extra}`
}

const urlField = () => screen.getByLabelText(/Remote server URL/) as HTMLInputElement
const nameField = () => screen.getByLabelText(/Server name/) as HTMLInputElement

function entryUrl(entry: RegistryEntry): string {
  return (entry.mcp_server_meta as { remoteEndpoints: Array<{ url: string }> }).remoteEndpoints[0]
    .url
}

async function continueTo(stepButton = 'Continue') {
  fireEvent.click(await screen.findByRole('button', { name: stepButton }))
}

describe('AddRemoteServerWizard — Marketplace catalog mode', () => {
  it('detects on open, shows the entry URL and the assigned name read-only, and installs only that URL', async () => {
    serveApi({
      discover: [{ resolve: CATALOG_CIMD_DISCOVER }],
      install: [{ resolve: CATALOG_CIMD_INSTALLED }],
    })
    // A crafted link may carry a URL; the wizard must ignore it. The link also names the
    // entry by an alias: everything sent afterwards uses the name the registry returned.
    openPage(
      CURATOR_CIMD_ENTRY,
      'entry=linear-remote&version=1.0.0&scope=user' +
        '&baseUrl=https%3A%2F%2Fevil.example.com%2Fmcp&url=https%3A%2F%2Fevil.example.com'
    )

    await waitFor(() => expect(nameField().value).toBe(CATALOG_CIMD_DISCOVER.serverName))
    expect(getRegistryEntryVersion).toHaveBeenCalledWith('linear-remote', '1.0.0')
    expect(bodiesSentTo(DISCOVER_PATH)).toEqual([
      { catalogEntry: { name: '@evenfire/linear-remote', version: '1.0.0' }, grantScope: 'user' },
    ])
    expect(urlField().value).toBe('https://mcp.linear.app/mcp')
    expect(urlField()).toHaveAttribute('readonly')
    expect(nameField()).toHaveAttribute('readonly')
    expect(screen.queryByDisplayValue(/evil\.example\.com/)).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('evil.example.com')
    // Provenance and verification of a curator entry.
    expect(screen.getByText('Verified 2026-09-25')).toBeInTheDocument()

    // Stays on Identify after the automatic detection; the operator moves on.
    await continueTo()
    const scopes = (await screen.findByLabelText('Scopes')) as HTMLInputElement
    expect(scopes.value).toBe('read') // the entry's suggested scopes, still editable
    expect(scopes).not.toHaveAttribute('readonly')
    const grantScope = screen.getByLabelText('Grant scope') as HTMLInputElement
    expect(grantScope.tagName).toBe('INPUT')
    expect(grantScope.value).toBe('Per user')
    expect(grantScope).toHaveAttribute('readonly')

    await continueTo()
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(MARKETPLACE))

    const [installBody] = bodiesSentTo(REMOTE_MCP_BASE)
    expect(installBody).toEqual({
      catalogEntry: { name: '@evenfire/linear-remote', version: '1.0.0' },
      grantScope: 'user',
      baseUrl: entryUrl(CURATOR_CIMD_ENTRY),
      mode: 'cimd',
      scopes: ['read'],
    })
    expect(installBody).not.toHaveProperty('serverName')
  })

  it('names the publisher of an org entry instead of any badge it claimed', async () => {
    serveApi({ discover: [{ pending: true }] })
    openPage(ORG_DCR_ENTRY, catalogQuery(ORG_DCR_ENTRY, 'user'))

    expect(await screen.findByText('Unverified · published by @acme')).toBeInTheDocument()
    expect(screen.queryByText(/^Verified/)).not.toBeInTheDocument()
    expect(screen.getByText('@acme/notion-remote v1.0.0')).toBeInTheDocument()
  })

  it('a dead entry URL says to report it to the curator and never offers the suggested URL', async () => {
    serveApi({ discover: [{ resolve: CATALOG_DEAD_URL_DISCOVER }] })
    openPage(CURATOR_DEAD_URL_ENTRY, catalogQuery(CURATOR_DEAD_URL_ENTRY, 'user'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      "This Marketplace entry's URL does not respond with MCP (HTTP 404), so it cannot be installed. Report it to the Marketplace curator."
    )
    expect(CATALOG_DEAD_URL_DISCOVER.transport).toMatchObject({
      suggestedBaseUrl: 'https://mcp.vercel.com/',
    })
    expect(screen.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('https://mcp.vercel.com/ ')
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
  })

  it('an entry control-api marked invalid shows an error with a way back, not the wizard', async () => {
    openPage(CURATOR_INVALID_ENTRY, catalogQuery(CURATOR_INVALID_ENTRY, 'user'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '@evenfire/broken-remote v1.0.0 cannot be installed (setup_guide_required)'
    )
    expect(apiSendMock).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(/Remote server URL/)).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to Marketplace' })[0])
    expect(mockPush).toHaveBeenCalledWith(MARKETPLACE)
  })

  it('an entry that is not remote-OAuth, or a slot the entry does not offer, is refused', async () => {
    openPage(PLAIN_REMOTE_ENTRY, catalogQuery(PLAIN_REMOTE_ENTRY, 'user'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '@evenfire/plain-remote is not a remote OAuth connector'
    )
    cleanup()

    openPage(CURATOR_CIMD_USER_ONLY_ENTRY, catalogQuery(CURATOR_CIMD_USER_ONLY_ENTRY, 'context'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '@evenfire/linear-user does not offer a per-context slot'
    )
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('a partial Marketplace link is an error, never the manual wizard', async () => {
    openPage(CURATOR_CIMD_ENTRY, 'entry=%40evenfire%2Flinear-remote&version=1.0.0')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This Marketplace link is incomplete'
    )
    expect(getRegistryEntryVersion).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('https://mcp.example.com/mcp')).not.toBeInTheDocument()
  })

  it('a discover refused as invalid by control-api surfaces its reason', async () => {
    // The entry looked valid when loaded but control-api's own read refuses it.
    serveApi({ discover: [{ reject: apiErrorFrom(CATALOG_INVALID_DISCOVER_FAILURE) }] })
    openPage(CURATOR_CIMD_USER_ONLY_ENTRY, catalogQuery(CURATOR_CIMD_USER_ONLY_ENTRY, 'user'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This Marketplace entry cannot be installed (setup_guide_required). Report it to the Marketplace curator.'
    )
  })

  it('an Entra entry shows the tenant field from the start, then shows the curator guide in Configure', async () => {
    serveApi({
      discover: [
        { reject: apiErrorFrom(CATALOG_WORKIQ_TENANT_REQUIRED) },
        { resolve: CATALOG_WORKIQ_DISCOVER },
      ],
    })
    openPage(CURATOR_WORKIQ_ENTRY, catalogQuery(CURATOR_WORKIQ_ENTRY, 'user'))

    // Visible as soon as the wizard opens, before the first discover answers.
    expect(await screen.findByLabelText(/Microsoft Entra tenant ID/)).toBeInTheDocument()
    expect(screen.getByText('Known issue')).toHaveAttribute(
      'title',
      'Consent needs a tenant admin.'
    )

    await waitFor(() => expect(bodiesSentTo(DISCOVER_PATH)).toHaveLength(1))
    fireEvent.change(screen.getByLabelText(/Microsoft Entra tenant ID/), {
      target: { value: '72f988bf-86f1-41af-91ab-2d7cd011db47' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
    await waitFor(() => expect(nameField().value).toBe(CATALOG_WORKIQ_DISCOVER.serverName))
    expect(bodiesSentTo(DISCOVER_PATH)[1]).toEqual({
      catalogEntry: { name: '@evenfire/workiq-remote', version: '1.0.0' },
      grantScope: 'user',
      authorizationServer:
        'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
    })

    await continueTo()
    const guide = await screen.findByRole('region', { name: 'OAuth app setup' })
    expect(
      within(guide).getByRole('article', { name: 'Setup guide from the Marketplace curator' })
    ).toBeInTheDocument()
    expect(within(guide).getByRole('link', { name: 'Open entra.microsoft.com' })).toHaveAttribute(
      'target',
      '_blank'
    )
    const redirect = within(guide).getByRole('textbox', {
      name: 'Redirect URI',
    }) as HTMLInputElement
    expect(redirect.value).toContain(CATALOG_WORKIQ_DISCOVER.serverName as string)
    expect(within(guide).getByRole('button', { name: 'Copy redirect URI' })).toBeInTheDocument()
  })

  it('warns about a registration drift and that the entry ships no guide for the credentials step', async () => {
    serveApi({ discover: [{ resolve: CATALOG_DRIFT_DCR_TO_MANUAL_DISCOVER }] })
    openPage(CURATOR_DCR_ON_MANUAL_AS_ENTRY, catalogQuery(CURATOR_DCR_ON_MANUAL_AS_ENTRY, 'user'))

    await waitFor(() => expect(nameField().value).not.toBe(''))
    await continueTo()
    const statuses = await screen.findAllByRole('status')
    const drift = statuses.find(el =>
      el.textContent?.includes('The provider changed its configuration')
    )
    expect(drift).toBeDefined()
    expect(drift).not.toHaveTextContent('setup guide')
    // The missing guide is said exactly once, by the credentials step.
    expect(screen.getAllByText(/ships no setup guide/)).toHaveLength(1)
    // Drift never blocks: the credentials step is open.
    expect(screen.getByLabelText(/Client ID/)).toBeInTheDocument()
    expect(
      screen.getByText(/This entry ships no setup guide from the Marketplace curator\./)
    ).toBeInTheDocument()
  })

  async function reachPreRegisteredInstall() {
    serveApi({ discover: [{ resolve: CATALOG_ORG_PRE_REGISTERED_DISCOVER }] })
    openPage(ORG_PRE_REGISTERED_ENTRY, catalogQuery(ORG_PRE_REGISTERED_ENTRY, 'user'))
    await waitFor(() =>
      expect(nameField().value).toBe(CATALOG_ORG_PRE_REGISTERED_DISCOVER.serverName)
    )
    await continueTo()
    // An org pre-registered entry carries no guide: the no-guide note stands in for it.
    expect(
      await screen.findByText(/This entry ships no setup guide from the Marketplace curator\./)
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'OAuth app setup' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: 'acme-user-app' } })
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 'acme-secret' } })
    await continueTo()
  }

  it('a reused OAuth app is explained as one app per slot', async () => {
    await reachPreRegisteredInstall()
    apiSendMock.mockRejectedValueOnce(apiErrorFrom(CATALOG_CLIENT_ID_IN_USE_FAILURE))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Each slot needs its own OAuth app. This client ID is already used by another remote server.'
    )
    expect(bodiesSentTo(REMOTE_MCP_BASE)[0]).toEqual({
      catalogEntry: { name: '@acme/linear-pre', version: '1.0.0' },
      grantScope: 'user',
      baseUrl: entryUrl(ORG_PRE_REGISTERED_ENTRY),
      mode: 'pre-registered',
      clientId: 'acme-user-app',
      clientSecret: 'acme-secret',
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('a leftover client Secret names the Secret and says the repair is manual', async () => {
    await reachPreRegisteredInstall()
    apiSendMock.mockRejectedValueOnce(apiErrorFrom(CATALOG_SLOT_RESIDUE_FAILURE))
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('mcp-acme-linear-pre-u-64164363-oauth-client')
    expect(alert).toHaveTextContent('Freeing it is a manual repair')
  })

  it('a slot taken meanwhile returns to the Marketplace with the reason', async () => {
    serveApi({
      discover: [{ resolve: CATALOG_CIMD_DISCOVER }],
      install: [{ reject: apiErrorFrom(CATALOG_SERVER_NAME_IN_USE_FAILURE) }],
    })
    openPage(CURATOR_CIMD_ENTRY, catalogQuery(CURATOR_CIMD_ENTRY, 'user'))
    await waitFor(() => expect(nameField().value).not.toBe(''))
    await continueTo()
    await continueTo()
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(MARKETPLACE))
    expect(await screen.findByText(/This slot is already installed/)).toBeInTheDocument()
  })

  it('a pre-registered install holds on the redirect URI, then Done returns to the Marketplace', async () => {
    const { CATALOG_PRE_REGISTERED_INSTALLED } =
      await import('../../test/fixtures/catalogRemoteOAuthWire')
    await reachPreRegisteredInstall()
    apiSendMock.mockResolvedValueOnce(CATALOG_PRE_REGISTERED_INSTALLED as InstallRemoteResponse)
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    expect(
      await screen.findByText(/give agents access from its Marketplace card/)
    ).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(mockPush).toHaveBeenCalledWith(MARKETPLACE)
  })

  it('shows the Entra tenant field while the first discover is still in flight', async () => {
    serveApi({ discover: [{ pending: true }] })
    openPage(CURATOR_WORKIQ_ENTRY, catalogQuery(CURATOR_WORKIQ_ENTRY, 'user'))

    await waitFor(() => expect(bodiesSentTo(DISCOVER_PATH)).toHaveLength(1))
    // Nothing has answered yet: the field comes from the entry's hint alone.
    expect(screen.getByLabelText(/Microsoft Entra tenant ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Microsoft Entra tenant ID/)).not.toHaveFocus()
  })

  it('sends a tenant typed after an unrelated discover failure, once control-api names the template', async () => {
    serveApi({
      discover: [
        { reject: apiErrorFrom(ENTRA_UNKNOWN_TENANT_DISCOVER_FAILURE) },
        { reject: apiErrorFrom(CATALOG_WORKIQ_TENANT_REQUIRED) },
        { resolve: CATALOG_WORKIQ_DISCOVER },
      ],
    })
    openPage(CURATOR_WORKIQ_ENTRY, catalogQuery(CURATOR_WORKIQ_ENTRY, 'user'))

    await screen.findByRole('alert')
    fireEvent.change(screen.getByLabelText(/Microsoft Entra tenant ID/), {
      target: { value: '72f988bf-86f1-41af-91ab-2d7cd011db47' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))

    await waitFor(() => expect(nameField().value).toBe(CATALOG_WORKIQ_DISCOVER.serverName))
    const bodies = bodiesSentTo(DISCOVER_PATH)
    expect(bodies).toHaveLength(3)
    expect(bodies[1]).not.toHaveProperty('authorizationServer')
    expect(bodies[2]).toMatchObject({
      authorizationServer:
        'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
    })
  })

  it('a guided entry that drifted to a pre-registered client shows its guide and no "no guide" notice', async () => {
    serveApi({ discover: [{ resolve: CATALOG_DRIFT_WITH_GUIDE_DISCOVER }] })
    openPage(
      CURATOR_DCR_WITH_GUIDE_ON_MANUAL_AS_ENTRY,
      catalogQuery(CURATOR_DCR_WITH_GUIDE_ON_MANUAL_AS_ENTRY, 'user')
    )
    await waitFor(() => expect(nameField().value).not.toBe(''))
    await continueTo()

    expect(await screen.findByText(/The provider changed its configuration/)).toBeInTheDocument()
    const guide = screen.getByRole('region', { name: 'OAuth app setup' })
    expect(within(guide).getByRole('link', { name: 'Open linear.app' })).toBeInTheDocument()
    expect(screen.queryByText(/ships no setup guide/)).not.toBeInTheDocument()
  })

  it('never shows a guide or console carried by an entry not proven to be the curator', async () => {
    const oauth = (ORG_PRE_REGISTERED_ENTRY.mcp_server_meta as { oauth: Record<string, unknown> })
      .oauth
    // Adversarial: the served org entry as if its presentation keys had not been stripped.
    const leaked: RegistryEntry = {
      ...ORG_PRE_REGISTERED_ENTRY,
      mcp_server_meta: {
        ...ORG_PRE_REGISTERED_ENTRY.mcp_server_meta,
        oauth: {
          ...oauth,
          setupGuide: 'Register at [acme](https://acme.example.com/register).',
          providerConsoleUrl: 'https://acme.example.com/console',
        },
      },
    }
    serveApi({ discover: [{ resolve: CATALOG_ORG_PRE_REGISTERED_DISCOVER }] })
    openPage(leaked, catalogQuery(leaked, 'user'))
    await waitFor(() => expect(nameField().value).not.toBe(''))
    await continueTo()

    expect(await screen.findByText(/ships no setup guide/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'OAuth app setup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /acme/ })).not.toBeInTheDocument()
  })

  async function reachCimdInstall() {
    openPage(CURATOR_CIMD_ENTRY, catalogQuery(CURATOR_CIMD_ENTRY, 'user'))
    await waitFor(() => expect(nameField().value).not.toBe(''))
    await continueTo()
    await continueTo()
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))
  }

  it('an install already in flight for the slot returns to the Marketplace like a taken slot', async () => {
    serveApi({
      discover: [{ resolve: CATALOG_CIMD_DISCOVER }],
      install: [{ reject: apiErrorFrom(CATALOG_INSTALL_IN_PROGRESS_FAILURE) }],
    })
    await reachCimdInstall()
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(MARKETPLACE))
    expect(await screen.findByText(/another install of it is in progress/)).toBeInTheDocument()
  })

  it('an entry URL found dead at install points to the curator, never to detecting another URL', async () => {
    serveApi({
      discover: [{ resolve: CATALOG_CIMD_DISCOVER }],
      install: [{ reject: apiErrorFrom(CATALOG_TRANSPORT_UNREACHABLE_FAILURE) }],
    })
    await reachCimdInstall()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      "This Marketplace entry's URL does not respond with MCP (HTTP 404), so it cannot be installed. Report it to the Marketplace curator."
    )
    expect(alert).not.toHaveTextContent('detect that URL instead')
    expect(alert).not.toHaveTextContent('https://mcp.vercel.com/')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('a dead entry URL without a reported status names no HTTP code', async () => {
    // control-api always sends detail.httpStatus; the body without it is the golden
    // minus that one field, so the copy must not fill in a status nobody reported.
    const { httpStatus: _status, ...detailWithoutStatus } = (
      CATALOG_TRANSPORT_UNREACHABLE_FAILURE.body as { detail: Record<string, unknown> }
    ).detail
    const withoutStatus = {
      ...CATALOG_TRANSPORT_UNREACHABLE_FAILURE,
      body: {
        ...(CATALOG_TRANSPORT_UNREACHABLE_FAILURE.body as Record<string, unknown>),
        detail: detailWithoutStatus,
      },
    }
    serveApi({
      discover: [{ resolve: CATALOG_CIMD_DISCOVER }],
      install: [{ reject: apiErrorFrom(withoutStatus) }],
    })
    await reachCimdInstall()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      "This Marketplace entry's URL does not respond with MCP, so it cannot be installed. Report it to the Marketplace curator."
    )
    expect(alert).not.toHaveTextContent('HTTP')
  })

  it('the unverified-scope confirmation works in catalog mode and resends the catalog body', async () => {
    serveApi({
      discover: [
        { reject: apiErrorFrom(CATALOG_WORKIQ_TENANT_REQUIRED) },
        { resolve: CATALOG_WORKIQ_DISCOVER },
      ],
      install: [{ reject: apiErrorFrom(SCOPE_AUDIENCE_UNVERIFIED_FAILURE) }, { pending: true }],
    })
    openPage(CURATOR_WORKIQ_ENTRY, catalogQuery(CURATOR_WORKIQ_ENTRY, 'user'))
    await waitFor(() => expect(bodiesSentTo(DISCOVER_PATH)).toHaveLength(1))
    fireEvent.change(screen.getByLabelText(/Microsoft Entra tenant ID/), {
      target: { value: '72f988bf-86f1-41af-91ab-2d7cd011db47' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
    await waitFor(() => expect(nameField().value).toBe(CATALOG_WORKIQ_DISCOVER.serverName))
    await continueTo()
    fireEvent.change(screen.getByLabelText(/Client ID/), {
      target: { value: '11111111-2222-3333-4444-555555555555' },
    })
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 's3cret' } })
    await continueTo()
    fireEvent.click(await screen.findByRole('button', { name: 'Install remote server' }))

    const confirm = await screen.findByRole('checkbox', {
      name: 'I confirm these scopes belong to this server’s own API.',
    })
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Install remote server' }))

    await waitFor(() => expect(bodiesSentTo(REMOTE_MCP_BASE)).toHaveLength(2))
    const retry = bodiesSentTo(REMOTE_MCP_BASE)[1]
    expect(retry).toMatchObject({
      catalogEntry: { name: '@evenfire/workiq-remote', version: '1.0.0' },
      grantScope: 'user',
      baseUrl: entryUrl(CURATOR_WORKIQ_ENTRY),
      mode: 'pre-registered',
      confirmedUnverifiedScopes: ['11111111-2222-3333-4444-555555555555/Tools.Read'],
    })
    expect(retry).not.toHaveProperty('serverName')
  })
})

// Keep the golden's declared shape honest for the assertions above.
const _shape: DiscoverRemoteResponse = CATALOG_CIMD_DISCOVER
void _shape
