// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { ComposerGfsLinkPicker } from '../ComposerGfsLinkPicker'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

function resource(
  resourceId: string,
  name: string,
  kind: 'file' | 'directory',
  readable?: boolean
): GfsBrowserChild {
  return {
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind,
    path: `/${name}`,
    version: 1,
    bytes: 12,
    readable,
  }
}

function baseController(overrides: Record<string, unknown> = {}) {
  return {
    crumbs: [],
    current: null,
    sessionScope: 'env:user:team',
    items: [],
    accessibleResources: [],
    loading: false,
    loadingAccessible: false,
    error: null,
    accessibleError: null,
    accessibleNotice: null,
    discoveryFailure: null,
    hasMore: false,
    hasMoreAccessible: false,
    isFetchingMore: false,
    isFetchingMoreAccessible: false,
    retryChildren: vi.fn(),
    retryDiscovery: vi.fn(),
    loadMore: vi.fn(),
    loadMoreAccessible: vi.fn(),
    openChild: vi.fn(),
    openResource: vi.fn(),
    goToCrumb: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  }
}

describe('ComposerGfsLinkPicker', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists only readable producer rows and separates folder navigation from insertion', () => {
    const folder = resource('folder-a', 'Folder A', 'directory')
    const secret = resource('secret-file', 'Secret file', 'file', false)
    const controller = baseController({ accessibleResources: [folder, secret] })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const onInsert = vi.fn()
    const onSessionScope = vi.fn()
    render(
      <ComposerGfsLinkPicker
        sessionId={7}
        onInsert={onInsert}
        onSessionScope={onSessionScope}
        onEscapeRoot={vi.fn()}
      />
    )

    expect(screen.getByRole('menuitem', { name: 'Open folder Folder A' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Insert link to Folder A' })).toBeTruthy()
    expect(screen.queryByText('Secret file')).toBeNull()
    expect(onSessionScope).toHaveBeenCalledWith(7, 'env:user:team')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder Folder A' }))
    expect(controller.openResource).toHaveBeenCalledWith(folder)
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('supports arrow and Home/End menu navigation', () => {
    const controller = baseController({
      accessibleResources: [
        resource('folder-a', 'Folder A', 'directory'),
        resource('file-a', 'File A', 'file'),
      ],
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    render(
      <ComposerGfsLinkPicker
        sessionId={8}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={vi.fn()}
      />
    )

    const openFolder = screen.getByRole('menuitem', { name: 'Open folder Folder A' })
    const insertFolder = screen.getByRole('menuitem', { name: 'Insert link to Folder A' })
    const insertFile = screen.getByRole('menuitem', { name: 'Insert link to File A' })
    openFolder.focus()
    fireEvent.keyDown(openFolder, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(insertFolder)
    fireEvent.keyDown(insertFolder, { key: 'End' })
    expect(document.activeElement).toBe(insertFile)
    fireEvent.keyDown(insertFile, { key: 'Home' })
    expect(document.activeElement).toBe(openFolder)
  })

  it('inserts an exact file URI and keeps the current folder hierarchy mounted', () => {
    const file = resource('exact-file', 'Notes.md', 'file')
    const controller = baseController({
      crumbs: [
        {
          resourceId: 'folder-a',
          gfsUri: 'gfs://main/folder-a',
          name: 'Folder A',
          kind: 'directory',
          version: 1,
          bytes: 0,
        },
      ],
      current: { ...resource('folder-a', 'Folder A', 'directory') },
      items: [file],
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const onInsert = vi.fn()
    const onEscapeRoot = vi.fn()
    const { container } = render(
      <ComposerGfsLinkPicker
        sessionId={9}
        onInsert={onInsert}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Notes.md' }))
    expect(onInsert).toHaveBeenCalledWith(
      { label: 'Notes.md', uri: 'gfs://main/exact-file' },
      'env:user:team',
      9
    )
    expect(container.querySelector('[role="menu"]')).toBeTruthy()
    expect(onEscapeRoot).not.toHaveBeenCalled()
  })

  it('sanitizes bidi controls in displayed and inserted GFS names while retaining the URI', () => {
    const maliciousName = 'invoice.pdf\u202Eexe'
    const resourceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const uri = `gfs://main/${resourceId}`
    const file = resource(resourceId, maliciousName, 'file')
    hookMock.useGfsBrowserController.mockReturnValue(
      baseController({ accessibleResources: [file] })
    )
    const onInsert = vi.fn()
    render(
      <ComposerGfsLinkPicker
        sessionId={13}
        onInsert={onInsert}
        onSessionScope={vi.fn()}
        onEscapeRoot={vi.fn()}
      />
    )

    const insert = screen.getByRole('menuitem', { name: 'Insert link to invoice.pdfexe' })
    expect(screen.queryByText(maliciousName)).toBeNull()
    fireEvent.click(insert)

    expect(onInsert).toHaveBeenCalledWith({ label: 'invoice.pdfexe', uri }, 'env:user:team', 13)
  })

  it('uses Escape to navigate back one level, then closes the root picker', () => {
    const goToCrumb = vi.fn()
    const onEscapeRoot = vi.fn()
    const controller = baseController({
      crumbs: [
        { resourceId: 'root', gfsUri: 'gfs://main/root', name: 'Root', kind: 'directory' },
        { resourceId: 'child', gfsUri: 'gfs://main/child', name: 'Child', kind: 'directory' },
      ],
      current: resource('child', 'Child', 'directory'),
      goToCrumb,
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const { unmount } = render(
      <ComposerGfsLinkPicker
        sessionId={11}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />
    )

    const escape = () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    escape()
    expect(goToCrumb).toHaveBeenCalledWith(0)
    expect(onEscapeRoot).not.toHaveBeenCalled()
    unmount()

    const reset = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue(
      baseController({
        crumbs: [
          { resourceId: 'root', gfsUri: 'gfs://main/root', name: 'Root', kind: 'directory' },
        ],
        current: resource('root', 'Root', 'directory'),
        reset,
      })
    )
    const { unmount: unmountAtRoot } = render(
      <ComposerGfsLinkPicker
        sessionId={11}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />
    )
    escape()
    expect(reset).toHaveBeenCalledOnce()
    expect(onEscapeRoot).not.toHaveBeenCalled()
    unmountAtRoot()

    hookMock.useGfsBrowserController.mockReturnValue(baseController())
    render(
      <ComposerGfsLinkPicker
        sessionId={11}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />
    )
    escape()
    expect(onEscapeRoot).toHaveBeenCalledOnce()
  })
})
