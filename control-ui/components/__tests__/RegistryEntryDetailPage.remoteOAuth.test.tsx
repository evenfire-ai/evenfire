import type React from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { CONTROL_ROUTES } from '../../app/constants/routes'
import RegistryEntryDetailPage from '../../app/registry/entries/[name]/[version]/page'
import { getRegistryCatalog } from '../../lib/api'
import { CATALOG_BUMPED_VERSION, CATALOG_SLOTS } from '../../test/fixtures/catalogRemoteOAuthWire'
import { ToastProvider } from '../Toast'

const navigationState = vi.hoisted(() => ({
  push: vi.fn(),
  params: { name: '@evenfire/linear-remote', version: '1.0.1' },
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigationState.params,
  useRouter: () => ({ push: navigationState.push }),
}))

vi.mock('../../components/AuthContext', () => ({
  useAuth: () => ({
    authState: { isLoggedIn: true, isLoading: false },
    checkAuth: vi.fn(),
  }),
}))

vi.mock('../../components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, getRegistryCatalog: vi.fn() }
})

vi.mock('../../lib/hooks/useRegistryCapability', () => ({
  useRegistryCapability: () => ({
    capability: { orgName: null, scope: null, isCurator: false, mode: 'managed' },
    loading: false,
    error: false,
    reload: () => {},
  }),
}))

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Marketplace entry detail of a remote-OAuth entry', () => {
  it('shows the per-slot state on v+1 after a patch bump, never the catalogKeys Install', async () => {
    navigationState.params = { name: '@evenfire/linear-remote', version: '1.0.1' }
    vi.mocked(getRegistryCatalog).mockResolvedValue(CATALOG_BUMPED_VERSION)
    render(<RegistryEntryDetailPage />)

    const slots = await screen.findByRole('list', { name: 'Install slots' })
    expect(
      within(slots).getByText('Installed · v1.0.0 · mcp-evenfire-linear-remote-u-4ef7a4af')
    ).toBeInTheDocument()
    expect(within(slots).getByText('Not installed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Installed' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()

    fireEvent.click(within(slots).getByRole('button', { name: 'Install per context' }))
    expect(navigationState.push).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@evenfire/linear-remote',
        version: '1.0.1',
        scope: 'context',
      })
    )
    expect(
      within(slots).getByRole('button', { name: 'Uninstall mcp-evenfire-linear-remote-u-4ef7a4af' })
    ).toBeInTheDocument()
  })

  it('offers no install on an uninstalling or foreign-held slot', async () => {
    navigationState.params = { name: '@acme/linear-pre', version: '1.0.0' }
    vi.mocked(getRegistryCatalog).mockResolvedValue(CATALOG_SLOTS)
    render(<RegistryEntryDetailPage />)

    const slots = await screen.findByRole('list', { name: 'Install slots' })
    expect(within(slots).getByText('Uninstalling mcp-acme-linear-pre-u-64164363…')).toBeVisible()
    expect(within(slots).getByText('Occupied by mcp-acme-linear-pre-c-610fdec3')).toBeVisible()
    expect(within(slots).queryAllByRole('button')).toEqual([])
    expect(screen.getByText('Unverified · published by @acme')).toBeInTheDocument()
  })

  it('shows the provenance badge as its verification and no registry trust or tier', async () => {
    navigationState.params = { name: '@acme/linear-pre', version: '1.0.0' }
    vi.mocked(getRegistryCatalog).mockResolvedValue(CATALOG_SLOTS)
    render(<RegistryEntryDetailPage />)

    await screen.findByRole('list', { name: 'Install slots' })
    const entry = CATALOG_SLOTS.data.find(item => item.name === '@acme/linear-pre')!
    const verification = screen.getByText('Verification').parentElement as HTMLElement
    expect(within(verification).getByText('Unverified · published by @acme')).toBeVisible()
    expect(screen.getAllByText('Unverified · published by @acme')).toHaveLength(1)
    expect(screen.queryByText('Trust')).toBeNull()
    expect(screen.queryByText(entry.trust_level.toUpperCase())).toBeNull()
    expect(screen.queryByText(entry.quality_tier)).toBeNull()
  })

  it('keeps the registry trust and tier for an entry without remote OAuth', async () => {
    navigationState.params = { name: '@evenfire/plain-remote', version: '1.0.0' }
    vi.mocked(getRegistryCatalog).mockResolvedValue(CATALOG_SLOTS)
    render(<RegistryEntryDetailPage />)

    const entry = CATALOG_SLOTS.data.find(item => item.name === '@evenfire/plain-remote')!
    const trust = (await screen.findByText('Trust')).parentElement as HTMLElement
    expect(within(trust).getByText(entry.trust_level.toUpperCase())).toBeVisible()
    const verification = screen.getByText('Verification').parentElement as HTMLElement
    expect(within(verification).getByText(entry.quality_tier)).toBeVisible()
  })

  it('shows a refused entry as not installable', async () => {
    navigationState.params = { name: '@evenfire/broken-remote', version: '1.0.0' }
    vi.mocked(getRegistryCatalog).mockResolvedValue(CATALOG_SLOTS)
    render(<RegistryEntryDetailPage />)

    expect(
      await screen.findByText(/This entry cannot be installed \(setup_guide_required\)/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Install slots' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull()
  })

  it('re-reads in the background after an uninstall, keeping the slots on screen', async () => {
    navigationState.params = { name: '@evenfire/linear-remote', version: '1.0.1' }
    vi.mocked(getRegistryCatalog)
      .mockResolvedValueOnce(CATALOG_BUMPED_VERSION)
      .mockReturnValueOnce(new Promise(() => undefined))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ name: 'mcp-evenfire-linear-remote-u-4ef7a4af' }),
      }))
    )
    try {
      render(<RegistryEntryDetailPage />)
      const slots = await screen.findByRole('list', { name: 'Install slots' })
      fireEvent.click(
        within(slots).getByRole('button', {
          name: 'Uninstall mcp-evenfire-linear-remote-u-4ef7a4af',
        })
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))

      await waitFor(() => expect(getRegistryCatalog).toHaveBeenCalledTimes(2))
      expect(screen.queryByRole('status', { name: 'Loading Marketplace entry' })).toBeNull()
      expect(screen.getByRole('list', { name: 'Install slots' })).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops the refresh-failure banner once a later re-read succeeds', async () => {
    navigationState.params = { name: '@evenfire/linear-remote', version: '1.0.1' }
    vi.mocked(getRegistryCatalog)
      .mockResolvedValueOnce(CATALOG_BUMPED_VERSION)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce(CATALOG_BUMPED_VERSION)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ name: 'mcp-evenfire-linear-remote-u-4ef7a4af' }),
      }))
    )
    async function uninstall() {
      const slots = await screen.findByRole('list', { name: 'Install slots' })
      fireEvent.click(
        within(slots).getByRole('button', {
          name: 'Uninstall mcp-evenfire-linear-remote-u-4ef7a4af',
        })
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    }
    try {
      render(<RegistryEntryDetailPage />)
      await uninstall()
      expect(await screen.findByText(/The entry could not be refreshed/)).toBeInTheDocument()

      await uninstall()
      await waitFor(() => expect(getRegistryCatalog).toHaveBeenCalledTimes(3))
      await waitFor(() => expect(screen.queryByText(/The entry could not be refreshed/)).toBeNull())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
