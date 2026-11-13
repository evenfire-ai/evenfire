import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { CONTROL_ROUTES } from '../../app/constants/routes'
import * as api from '../../lib/api'
import type { RegistryCatalogResponse } from '../../lib/api'
import { CATALOG_SLOTS } from '../../test/fixtures/catalogRemoteOAuthWire'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getOwnedRegistryEntries: vi.fn(),
  getRegistryCatalog: vi.fn(),
  deleteRegistryEntry: vi.fn(),
  listOrgGrants: vi.fn().mockResolvedValue({ grants: [] }),
  createOrgGrant: vi.fn(),
  revokeOrgGrant: vi.fn(),
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(),
}))

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  // The catalog is control-api's golden; the owned list is the registry's
  // `/org/:org/entries` row shape for the two org entries that golden holds.
  vi.mocked(api.getRegistryCatalog).mockResolvedValue(CATALOG_SLOTS)
  vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
    data: [
      {
        name: '@acme/linear-pre',
        version: '1.0.0',
        visibility: 'public',
        status: 'published',
        entryType: 'mcp-server',
        serverMode: 'remote',
      },
      {
        name: '@acme/notion-remote',
        version: '1.0.0',
        visibility: 'public',
        status: 'published',
        entryType: 'mcp-server',
        serverMode: 'remote',
      },
    ],
  })
})

async function menuItems(name: string): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name} v1.0.0` }))
  return screen.getAllByRole('menuitem').map(item => item.textContent ?? '')
}

describe('OwnedEntries for remote-OAuth entries', () => {
  it('reads the slots, not catalogKeys: no Install on an uninstalling or foreign slot', async () => {
    rtlRender(
      <ToastProvider>
        <OwnedEntries orgScope="@acme" />
      </ToastProvider>
    )
    const items = await menuItems('@acme/linear-pre')
    expect(items).toContain('Per user: unavailable')
    expect(items).toContain('Per context: unavailable')
    expect(items.some(item => item === 'Install' || item.startsWith('Install ('))).toBe(false)
  })

  it('opens the wizard in catalog mode for a free slot', async () => {
    rtlRender(
      <ToastProvider>
        <OwnedEntries orgScope="@acme" />
      </ToastProvider>
    )
    await menuItems('@acme/notion-remote')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install (per user)' }))
    expect(navigation.push).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@acme/notion-remote',
        version: '1.0.0',
        scope: 'user',
      })
    )
  })

  it('installs the listed remote-OAuth version when this version is not in the catalog', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        {
          name: '@acme/notion-remote',
          version: '0.9.0',
          visibility: 'public',
          status: 'published',
          entryType: 'mcp-server',
          serverMode: 'remote',
        },
      ],
    })
    rtlRender(
      <ToastProvider>
        <OwnedEntries orgScope="@acme" />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for @acme/notion-remote v0.9.0' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install (per user)' }))
    expect(navigation.push).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@acme/notion-remote',
        version: '1.0.0',
        scope: 'user',
      })
    )
  })

  it("uses each listed version's own catalog row when several versions are in the catalog", async () => {
    const remoteOAuthRow = CATALOG_SLOTS.data.find(row => row.name === '@acme/notion-remote')!
    const plainRow = CATALOG_SLOTS.data.find(row => row.name === '@evenfire/plain-remote')!
    // An older version of the same entry, published before it was a remote-OAuth connector:
    // control-api's plain remote row under that name. Listed first, so a name-only lookup
    // would pick it for both versions.
    const catalog: RegistryCatalogResponse = {
      ...CATALOG_SLOTS,
      data: [{ ...plainRow, name: '@acme/notion-remote', version: '0.9.0' }, remoteOAuthRow],
    }
    vi.mocked(api.getRegistryCatalog).mockResolvedValue(catalog)
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: ['0.9.0', '1.0.0'].map(version => ({
        name: '@acme/notion-remote',
        version,
        visibility: 'public',
        status: 'published',
        entryType: 'mcp-server',
        serverMode: 'remote',
      })),
    })
    rtlRender(
      <ToastProvider>
        <OwnedEntries orgScope="@acme" />
      </ToastProvider>
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for @acme/notion-remote v0.9.0' })
    )
    expect(screen.queryByRole('menuitem', { name: 'Install (per user)' })).toBeNull()
    cleanup()

    rtlRender(
      <ToastProvider>
        <OwnedEntries orgScope="@acme" />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for @acme/notion-remote v1.0.0' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install (per user)' }))
    expect(navigation.push).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@acme/notion-remote',
        version: '1.0.0',
        scope: 'user',
      })
    )
  })
})
