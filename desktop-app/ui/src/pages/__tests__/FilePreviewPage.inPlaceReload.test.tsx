// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  downloadResult,
  resolveDeniedMessage,
  resolveResource,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'
import type { FilePreviewPageProps } from '../FilePreviewPage.types'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const URI = 'gfs://main/notes'

function controller() {
  return {
    accessState: 'active' as const,
    sessionScope: 'preview-test-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    // Per-resource 403s are not session-authority failures, so the real
    // controller declines them; the preview must not treat them as a revoke.
    handleAuthorityFailure: vi.fn(() => false),
  }
}

type Download = Awaited<ReturnType<typeof downloadResult>>

function stubGfs() {
  const pending: Array<{ resolve: (value: Download) => void; reject: (error: unknown) => void }> =
    []
  const downloadPreview = vi.fn(
    () =>
      new Promise<Download>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  const resolve = vi.fn((uri: string) =>
    resolveResource(resolvedFile('notes', 'notes.md', { gfsUri: uri, bytes: 64 }))
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        downloadPreview,
        resolve,
        affordances: vi.fn(async () =>
          delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
        ),
      },
    },
  })
  return { downloadPreview, pending }
}

async function markdownDownload(text: string): Promise<Download> {
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer
  return downloadResult(
    resolvedFile('notes', 'notes.md', { gfsUri: URI, bytes: bytes.byteLength }),
    bytes
  )
}

async function imageDownload(seed: number): Promise<Download> {
  const bytes = new Uint8Array([seed, seed, seed]).buffer as ArrayBuffer
  return downloadResult(resolvedFile('notes', 'diagram.png', { gfsUri: URI, bytes: 3 }), bytes)
}

const queryClients: QueryClient[] = []

function renderPage(initial: Partial<FilePreviewPageProps>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  queryClients.push(queryClient)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const base: FilePreviewPageProps = {
    gfsUri: URI,
    fileName: 'notes.md',
    fileKind: 'markdown',
    byteLength: 64,
    ...initial,
  }
  const view = renderWithTestingLibrary(<FilePreviewPage {...base} />, { wrapper })
  return {
    ...view,
    update: (next: Partial<FilePreviewPageProps>) =>
      view.rerender(<FilePreviewPage {...base} {...next} />),
  }
}

let createdUrls: string[] = []

describe('FilePreviewPage in-place reload', () => {
  beforeEach(() => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    createdUrls = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        const url = `blob:gfs-preview-${createdUrls.length + 1}`
        createdUrls.push(url)
        return url
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    for (const queryClient of queryClients.splice(0)) queryClient.clear()
    vi.restoreAllMocks()
  })

  it('reloads markdown in place on a version bump without a loading state or scroll loss', async () => {
    const { pending, downloadPreview } = stubGfs()
    const view = renderPage({ reloadVersion: 3 })
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    await screen.findByRole('heading', { name: 'Version 3', level: 1 })
    const region = view.container.querySelector('.da-gfs-markdown-preview-dialog__body')
    if (!(region instanceof HTMLElement)) throw new Error('markdown scroll region is missing')
    region.scrollTop = 120

    view.update({ reloadVersion: 4 })
    await waitFor(() => expect(downloadPreview).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Loading preview…')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Version 3', level: 1 })).toBeTruthy()

    await act(async () => pending[1]!.resolve(await markdownDownload('# Version 4')))
    expect(await screen.findByRole('heading', { name: 'Version 4', level: 1 })).toBeTruthy()
    expect(view.container.querySelector('.da-gfs-markdown-preview-dialog__body')).toBe(region)
    expect(region.scrollTop).toBe(120)
  })

  it('keeps the visible image URL until the new version loads', async () => {
    const { pending } = stubGfs()
    const view = renderPage({
      fileName: 'diagram.png',
      fileKind: 'image',
      mimeType: 'image/png',
      byteLength: 3,
      reloadVersion: 3,
    })
    await act(async () => pending[0]!.resolve(await imageDownload(3)))
    const img = await screen.findByAltText('Preview of diagram.png')
    expect(img.getAttribute('src')).toBe('blob:gfs-preview-1')

    view.update({ reloadVersion: 4 })
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(screen.getByAltText('Preview of diagram.png').getAttribute('src')).toBe(
      'blob:gfs-preview-1'
    )
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:gfs-preview-1')

    await act(async () => pending[1]!.resolve(await imageDownload(4)))
    await waitFor(() =>
      expect(screen.getByAltText('Preview of diagram.png').getAttribute('src')).toBe(
        'blob:gfs-preview-2'
      )
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gfs-preview-1')
  })

  it('keeps the content on a per-resource 403 from the in-place download', async () => {
    const { pending } = stubGfs()
    const view = renderPage({ reloadVersion: 3 })
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    await screen.findByRole('heading', { name: 'Version 3', level: 1 })

    view.update({ reloadVersion: 4 })
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.reject(new Error(await resolveDeniedMessage(URI))))

    expect(await screen.findByText(/Could not update the preview/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Version 3', level: 1 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'File unavailable' })).toBeNull()
  })

  it('unmounts the body when the tab turns unavailable and remounts it fresh afterwards', async () => {
    const { pending } = stubGfs()
    const view = renderPage({
      fileName: 'diagram.png',
      fileKind: 'image',
      mimeType: 'image/png',
      byteLength: 3,
      reloadVersion: 3,
    })
    await act(async () => pending[0]!.resolve(await imageDownload(3)))
    await screen.findByAltText('Preview of diagram.png')

    view.update({ reloadVersion: 4, unavailable: true })
    expect(await screen.findByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByAltText('Preview of diagram.png')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gfs-preview-1')

    view.update({ reloadVersion: 5, unavailable: false })
    expect(await screen.findByText('Loading image preview…')).toBeTruthy()
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve(await imageDownload(5)))
    await waitFor(() =>
      expect(screen.getByAltText('Preview of diagram.png').getAttribute('src')).toBe(
        'blob:gfs-preview-2'
      )
    )
  })

  it('remounts the body on a manual refresh', async () => {
    const { pending } = stubGfs()
    const titlebar = document.createElement('div')
    document.body.appendChild(titlebar)
    renderPage({ reloadVersion: 3, titlebarLeadingTarget: titlebar })
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    await screen.findByRole('heading', { name: 'Version 3', level: 1 })

    fireEvent.click(within(titlebar).getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByText('Loading preview…')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Version 3', level: 1 })).toBeNull()
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve(await markdownDownload('# Version 4')))
    expect(await screen.findByRole('heading', { name: 'Version 4', level: 1 })).toBeTruthy()
    titlebar.remove()
  })
})
