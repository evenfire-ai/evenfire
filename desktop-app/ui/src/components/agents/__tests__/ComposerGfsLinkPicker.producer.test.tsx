// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { ComposerGfsLinkPicker } from '../ComposerGfsLinkPicker'

const auth = {
  isAuthenticated: true,
  sessionGeneration: 1,
  me: { id: 'user-1', teamId: 'team-1' },
  runtimeConfigState: { envKey: 'test' },
} as unknown as AuthContextValue

const folderA = accessibleResource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A', 'directory')
const folderB = childView('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Nested B', 'directory', {
  parentResourceId: folderA.resourceId,
  path: '/Folder A/Nested B',
})
const note = childView('cccccccccccccccccccccccccccccccc', 'Release notes.md', 'file', {
  parentResourceId: folderB.resourceId,
  path: '/Folder A/Nested B/Release notes.md',
})
const laterResource = accessibleResource(
  'dddddddddddddddddddddddddddddddd',
  'Later report.md',
  'file'
)

function installProducers() {
  const listAccessible = vi.fn(async () => listAccessiblePage([folderA]))
  const listChildren = vi.fn(async (resourceId: string) =>
    listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { listAccessible, listChildren } } as unknown as Window['clerum'],
  })
  return { listAccessible, listChildren }
}

describe('ComposerGfsLinkPicker producer integration', () => {
  afterEach(() => {
    cleanup()
    delete (window as Partial<typeof window>).clerum
  })

  it('browses producer-backed nested folders and returns the exact readable resource', async () => {
    const producers = installProducers()
    const onInsert = vi.fn()
    const onSessionScope = vi.fn()
    const onEscapeRoot = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={queryClient}>
          <ComposerGfsLinkPicker
            sessionId={41}
            onInsert={onInsert}
            onSessionScope={onSessionScope}
            onEscapeRoot={onEscapeRoot}
          />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Folder A' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Nested B' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Insert link to Release notes.md' })
    )

    expect(producers.listAccessible).toHaveBeenCalledOnce()
    expect(producers.listChildren).toHaveBeenCalledWith(folderA.resourceId, 'main', undefined)
    expect(producers.listChildren).toHaveBeenCalledWith(folderB.resourceId, 'main', undefined)
    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith(
        { label: note.name, uri: note.gfsUri },
        'test:user-1:team-1',
        41
      )
    )
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByText('Nested B')).toBeTruthy()
    expect(onEscapeRoot).not.toHaveBeenCalled()
    expect(onSessionScope).toHaveBeenCalledWith(41, 'test:user-1:team-1')
  })

  it('keeps a producer-backed second page available after browsing into and out of a folder', async () => {
    const listAccessible = vi.fn(async (_drive: string, cursor?: string) =>
      cursor === 'accessible-next'
        ? listAccessiblePage([laterResource])
        : listAccessiblePage([folderA], 'accessible-next')
    )
    const listChildren = vi.fn(async (resourceId: string) =>
      listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { listAccessible, listChildren } } as unknown as Window['clerum'],
    })
    const onInsert = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={queryClient}>
          <ComposerGfsLinkPicker
            sessionId={42}
            onInsert={onInsert}
            onSessionScope={vi.fn()}
            onEscapeRoot={vi.fn()}
          />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Later report.md' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Folder A' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Back to shared files' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Later report.md' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert link to Later report.md' }))

    expect(listAccessible).toHaveBeenNthCalledWith(1, 'main', undefined)
    expect(listAccessible).toHaveBeenNthCalledWith(2, 'main', 'accessible-next')
    expect(listChildren).toHaveBeenCalledWith(folderA.resourceId, 'main', undefined)
    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith(
        { label: laterResource.name, uri: laterResource.gfsUri },
        'test:user-1:team-1',
        42
      )
    )
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByText('Shared files')).toBeTruthy()
  })
})
