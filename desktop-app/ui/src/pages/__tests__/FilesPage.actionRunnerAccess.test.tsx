// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { revokeGfsSessionAccess } from '@lib/gfsSessionAuthority'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  childView,
  listChildrenPage,
  renameResourceResult,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilesPage } from '../FilesPage'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

const FOLDER_URI = 'gfs://main/aaa'
const SCOPE = 'test-environment:user-1:team-1'
const authValue = {
  isAuthenticated: true,
  sessionGeneration: 0,
  me: {
    id: 'user-1',
    email: 'user@example.test',
    name: 'User One',
    picture: null,
    teamId: 'team-1',
    teamName: 'Team One',
    role: 'member' as const,
  },
  runtimeConfigState: { envKey: 'test-environment' },
} as unknown as AuthContextValue

async function mountRows(pushToast?: (message: string, tone: string) => void) {
  const folder = await resolveResource(
    resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
  )
  const report = childView('child-report', 'report.txt', 'file', {
    parentResourceId: 'folder-active',
  })
  const children = await listChildrenPage([report])
  const renamed = await renameResourceResult('child-report', 'renamed.txt', 2)
  const renameResource = vi.fn(async () => renamed)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 0) },
      gfs: {
        listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
        resolve: vi.fn(async () => folder),
        listChildren: vi.fn(async () => children),
        affordances: vi.fn(async () =>
          delegationAffordances(new Set(['read', 'write', 'delete']), false)
        ),
        renameResource,
      },
    },
  })
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const wrapper = ({ children: node }: { children: ReactNode }) => (
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </AuthContext.Provider>
  )
  render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, { wrapper })
  await screen.findByText('report.txt')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
  )
  return { client, renameResource }
}

async function mountWithRowEditor() {
  const { client, renameResource } = await mountRows()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rename report.txt' }))
  })
  const editor = await screen.findByRole('textbox', { name: 'New name' })
  fireEvent.change(editor, { target: { value: 'renamed.txt' } })
  return { client, renameResource, form: screen.getByRole('form', { name: 'Rename resource' }) }
}

/**
 * Counts reads of the session's access flag from here on. Files reads it only
 * inside action guards, never while rendering, so a read proves the action
 * reached its session guard instead of returning before it.
 */
function countAccessFlagReads(client: QueryClient): () => number {
  const accessKey = JSON.stringify(desktopQueryKeys.gfsAccessState(SCOPE, 0))
  const read = client.getQueryData.bind(client)
  let reads = 0
  vi.spyOn(client, 'getQueryData').mockImplementation((queryKey => {
    if (JSON.stringify(queryKey) === accessKey) reads += 1
    return read(queryKey)
  }) as QueryClient['getQueryData'])
  return () => reads
}

describe('FilesPage submits through the shared action runners', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('renames a row while the session keeps its access', async () => {
    const { client, renameResource, form } = await mountWithRowEditor()
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(1))
    expect(renameResource).toHaveBeenCalledWith('child-report', 'renamed.txt', 'main', 1)
    client.clear()
  })

  it('sends no rename when access is revoked in the same tick as the submit', async () => {
    const { client, renameResource, form } = await mountWithRowEditor()
    // Revoked in the cache, submitted before any observer re-renders the page.
    revokeGfsSessionAccess(client, SCOPE, 0)
    const accessFlagReads = countAccessFlagReads(client)
    fireEvent.submit(form)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(accessFlagReads()).toBeGreaterThan(0)
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('shows no permission-verification toast for an action opened in the revoking tick', async () => {
    const pushToast = vi.fn()
    const { client } = await mountRows(pushToast)
    const rename = screen.getByRole('button', { name: 'Rename report.txt' })
    // Revoked in the cache; the page has not re-rendered when Rename runs its
    // permission check, so the revoked session must stay silent on its own.
    revokeGfsSessionAccess(client, SCOPE, 0)
    const accessFlagReads = countAccessFlagReads(client)
    fireEvent.click(rename)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(accessFlagReads()).toBeGreaterThan(0)
    expect(screen.queryByRole('textbox', { name: 'New name' })).toBeNull()
    expect(pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not verify permissions'),
      expect.anything()
    )
    expect(pushToast).not.toHaveBeenCalled()
    client.clear()
  })
})
