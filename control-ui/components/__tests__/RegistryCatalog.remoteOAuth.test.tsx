import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { CONTROL_ROUTES } from '../../app/constants/routes'
import * as api from '../../lib/api'
import type { ContextResource, HostResource } from '../../lib/api'
import { __resetRegistryCapabilityCacheForTests } from '../../lib/hooks/useRegistryCapability'
import { CATALOG_SLOTS } from '../../test/fixtures/catalogRemoteOAuthWire'
import {
  contextRejectionResponse,
  okJsonResponse,
  unknownMcpServerBody,
} from '../../test/fixtures/contextMcpServerRejection'
import RegistryCatalog from '../RegistryCatalog'
import { ToastProvider } from '../Toast'

// The catalog response is control-api's own `GET /admin/registry/catalog` golden. The
// uninstall and context writes go through the real client over a stubbed fetch.
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getRegistryCatalog: vi.fn(),
    getRegistryConnection: vi.fn(),
    getPublishScope: vi.fn(),
    deleteRegistryEntry: vi.fn(),
    getContexts: vi.fn(),
    getHosts: vi.fn(),
  }
})

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}))

const LINEAR_USER_SERVER = 'mcp-evenfire-linear-remote-u-4ef7a4af'

let fetchMock: ReturnType<typeof vi.fn>

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name, { selector: '.cu-registry-name' })
  return cell.closest('tr') as HTMLElement
}

async function openMenu(name: string): Promise<string[]> {
  const row = await rowFor(name)
  fireEvent.click(within(row).getByRole('button', { name: `Actions for ${name} v1.0.0` }))
  return screen.getAllByRole('menuitem').map(item => item.textContent ?? '')
}

beforeEach(() => {
  __resetRegistryCapabilityCacheForTests()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(api.getPublishScope).mockResolvedValue({ scope: null, curator: false, orgName: null })
  vi.mocked(api.getRegistryConnection).mockRejectedValue(
    Object.assign(new Error('409 not_self_hosted'), { code: 'not_self_hosted' })
  )
  vi.mocked(api.getRegistryCatalog).mockResolvedValue(CATALOG_SLOTS)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Marketplace remote-OAuth slots', () => {
  it('shows each allowed slot with the state remoteOAuthSlots reports', async () => {
    render(<RegistryCatalog />)

    const linear = await rowFor('@evenfire/linear-remote')
    expect(within(linear).getByText('Per user')).toBeInTheDocument()
    expect(
      within(linear).getByText(`Installed · v1.0.0 · ${LINEAR_USER_SERVER}`)
    ).toBeInTheDocument()
    expect(within(linear).getByText('Per context')).toBeInTheDocument()
    expect(within(linear).getByText('Not installed')).toBeInTheDocument()

    const linearPre = await rowFor('@acme/linear-pre')
    expect(
      within(linearPre).getByText('Uninstalling mcp-acme-linear-pre-u-64164363…')
    ).toBeInTheDocument()
    expect(
      within(linearPre).getByText('Occupied by mcp-acme-linear-pre-c-610fdec3')
    ).toBeInTheDocument()

    const handNamed = await rowFor('@evenfire/linear-user')
    expect(
      within(handNamed).getByText('Occupied by hand-named-linear · v1.0.0')
    ).toBeInTheDocument()
    expect(
      within(handNamed).getByText(/carries this entry under a name other than the slot's/)
    ).toBeInTheDocument()
  })

  it('offers Install only on a free slot, and Agents/Uninstall on an installed one', async () => {
    render(<RegistryCatalog />)

    expect(await openMenu('@evenfire/linear-remote')).toEqual([
      'View details',
      'Agents… (per user)',
      'Uninstall (per user)',
      'Install (per context)',
    ])
  })

  it('never offers Install on an uninstalling or foreign-held slot', async () => {
    render(<RegistryCatalog />)
    expect(await openMenu('@acme/linear-pre')).toEqual(['View details'])
  })

  it('never offers Install on a slot held under a non-canonical name', async () => {
    render(<RegistryCatalog />)
    const items = await openMenu('@evenfire/linear-user')
    expect(items.some(item => item.startsWith('Install'))).toBe(false)
  })

  it('shows an entry control-api refused as not installable, with its reason', async () => {
    render(<RegistryCatalog />)
    const broken = await rowFor('@evenfire/broken-remote')
    expect(within(broken).getByText('Not installable')).toHaveAttribute(
      'title',
      'setup_guide_required'
    )
    expect(await openMenu('@evenfire/broken-remote')).toEqual(['View details'])
  })

  it('keeps the plain remote entry on the ordinary install flow', async () => {
    render(<RegistryCatalog />)
    expect(await openMenu('@evenfire/plain-remote')).toEqual(['View details', 'Install'])
  })

  it('opens the wizard in catalog mode for the chosen slot', async () => {
    render(<RegistryCatalog />)
    await openMenu('@evenfire/linear-remote')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install (per context)' }))
    expect(navigation.push).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@evenfire/linear-remote',
        version: '1.0.0',
        scope: 'context',
      })
    )
  })
})

describe('Marketplace remote-OAuth badges', () => {
  it('shows the verification states, and Install stays available in each', async () => {
    render(<RegistryCatalog />)

    const verified = await rowFor('@evenfire/linear-remote')
    expect(within(verified).getByText('Verified 2026-09-25')).toBeInTheDocument()
    const untested = await rowFor('@evenfire/linear-dcr')
    expect(within(untested).getByText('Unverified')).toBeInTheDocument()
    const knownIssue = await rowFor('@evenfire/workiq-remote')
    expect(within(knownIssue).getByText('Known issue')).toHaveAttribute(
      'title',
      'Consent needs a tenant admin.'
    )

    expect(await openMenu('@evenfire/linear-remote')).toContain('Install (per context)')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    cleanup()
    render(<RegistryCatalog />)
    expect(await openMenu('@evenfire/linear-dcr')).toContain('Install (per user)')
    cleanup()
    render(<RegistryCatalog />)
    expect(await openMenu('@evenfire/workiq-remote')).toContain('Install (per user)')
  })

  it('marks a pre-registered entry and links the curator console over https', async () => {
    render(<RegistryCatalog />)
    const workiq = await rowFor('@evenfire/workiq-remote')
    expect(within(workiq).getByText('Requires your OAuth app')).toBeInTheDocument()
    expect(within(workiq).getByRole('link', { name: 'Open entra.microsoft.com' })).toHaveAttribute(
      'href',
      'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps'
    )
    const cimd = await rowFor('@evenfire/linear-remote')
    expect(within(cimd).queryByText('Requires your OAuth app')).toBeNull()
  })

  it('names the publisher of an org entry, without a console link', async () => {
    render(<RegistryCatalog />)
    const orgPre = await rowFor('@acme/linear-pre')
    expect(within(orgPre).getByText('Unverified · published by @acme')).toBeInTheDocument()
    expect(within(orgPre).getByText('Requires your OAuth app')).toBeInTheDocument()
    expect(within(orgPre).queryByRole('link')).toBeNull()
    const orgDcr = await rowFor('@acme/notion-remote')
    expect(within(orgDcr).getByText('Unverified · published by @acme')).toBeInTheDocument()
    expect(within(orgDcr).queryByText(/Verified 2026/)).toBeNull()
  })
})

describe('Marketplace manual-instance notice', () => {
  it('flags a manual install of the same URL and grant scope', async () => {
    render(<RegistryCatalog />)
    const notion = await rowFor('@acme/notion-remote')
    expect(
      within(notion).getByText("Manual instance with this URL: 'manual-notion' (per user)")
    ).toBeInTheDocument()
    const linear = await rowFor('@evenfire/linear-remote')
    expect(within(linear).queryByText(/Manual instance/)).toBeNull()
  })
})

describe('Marketplace Remote OAuth filter', () => {
  it('narrows to remote-OAuth entries, then to one verification state', async () => {
    render(<RegistryCatalog />)
    await rowFor('@evenfire/plain-remote')
    function choose(label: string) {
      fireEvent.click(screen.getByRole('button', { name: 'Filter by Remote OAuth verification' }))
      fireEvent.click(screen.getByRole('option', { name: label }))
    }
    const listedNames = () =>
      screen
        .getAllByText(/^@/, { selector: '.cu-registry-name' })
        .map(node => node.textContent)
        .sort()

    choose('Remote OAuth')
    expect(screen.queryByText('@evenfire/plain-remote')).toBeNull()
    expect(screen.getByText('@evenfire/broken-remote')).toBeInTheDocument()

    choose('Remote OAuth · Known issue')
    expect(listedNames()).toEqual(['@evenfire/workiq-remote'])

    choose('Remote OAuth · Third-party')
    expect(listedNames()).toEqual(['@acme/linear-pre', '@acme/notion-remote'])
  })
})

describe('Marketplace slot actions', () => {
  it('uninstalls through the connector DELETE and re-reads the catalog', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ name: LINEAR_USER_SERVER }))
    render(<RegistryCatalog />)
    await openMenu('@evenfire/linear-remote')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall (per user)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))

    await waitFor(() => expect(api.getRegistryCatalog).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/admin/mcp-servers/${LINEAR_USER_SERVER}`),
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(await screen.findByText(`Connector ${LINEAR_USER_SERVER} uninstalled.`)).toBeVisible()
  })

  it('closes Agents… on a vanished connector, says so and re-reads the catalog', async () => {
    const contexts: ContextResource[] = [
      {
        metadata: { name: 'ctx-support', namespace: 'default', resourceVersion: '11' },
        spec: { contextId: 'ctx-support', mcpServers: [] },
      } as ContextResource,
    ]
    const hosts: HostResource[] = [
      { metadata: { name: 'support' }, spec: { host: 'Support', contextRef: 'ctx-support' } },
    ] as HostResource[]
    vi.mocked(api.getContexts).mockResolvedValue({ items: contexts })
    vi.mocked(api.getHosts).mockResolvedValue({ items: hosts })
    fetchMock.mockResolvedValueOnce(
      contextRejectionResponse(unknownMcpServerBody([LINEAR_USER_SERVER]))
    )

    render(<RegistryCatalog />)
    await openMenu('@evenfire/linear-remote')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agents… (per user)' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Give agents access to this connector',
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Support/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to agent' }))

    expect(
      await screen.findByText(
        `The connector ${LINEAR_USER_SERVER} no longer exists; reload the page and try again.`
      )
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Give agents access to this connector' })
      ).toBeNull()
    )
    expect(api.getRegistryCatalog).toHaveBeenCalledTimes(2)
  })

  it('keeps each uninstalling connector busy until its own delete settles', async () => {
    const pending = new Map<string, (response: Response) => void>()
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>(resolve => {
          pending.set(url.includes('hand-named-linear') ? 'hand' : 'linear', resolve)
        })
    )
    render(<RegistryCatalog />)

    async function startUninstall(entry: string) {
      await openMenu(entry)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall (per user)' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    }
    await startUninstall('@evenfire/linear-remote')
    await waitFor(() => expect(pending.has('linear')).toBe(true))
    await startUninstall('@evenfire/linear-user')
    await waitFor(() => expect(pending.has('hand')).toBe(true))

    pending.get('linear')!(okJsonResponse({ name: LINEAR_USER_SERVER }))
    await waitFor(() => expect(api.getRegistryCatalog).toHaveBeenCalledTimes(2))
    await screen.findByText(`Connector ${LINEAR_USER_SERVER} uninstalled.`)

    await openMenu('@evenfire/linear-user')
    expect(screen.getByRole('menuitem', { name: 'Uninstall (per user)' })).toBeDisabled()
  })
})
