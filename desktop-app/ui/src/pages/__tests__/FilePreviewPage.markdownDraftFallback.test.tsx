// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MarkdownDraftOwner } from '@lib/markdownDraftOwner'
import {
  previewDownloadResult,
  replaceFileResult,
  resolveResource,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const controllerMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => controllerMock)
vi.mock('@components/GfsMarkdownPreview/MarkdownAdapter', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@components/GfsMarkdownPreview/MarkdownAdapter')>()
  return {
    ...actual,
    GfsMarkdownEditor: (props: {
      ariaLabel: string
      onChange: (value: string) => void
      value: string
    }) => (
      <textarea
        aria-label={props.ariaLabel}
        onChange={event => props.onChange(event.currentTarget.value)}
        value={props.value}
      />
    ),
  }
})

describe('FilePreviewPage local Markdown draft fallback', () => {
  it('saves a supported BOM-prefixed source with the original BOM bytes intact', async () => {
    const uri = 'gfs://main/2123456789abcdef0123456789abcdef'
    const resource = await resolveResource({
      resourceId: '2123456789abcdef0123456789abcdef',
      rid: '2123456789abcdef0123456789abcdef',
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'parent',
      name: 'bom.md',
      kind: 'file',
      version: 1,
      bytes: 8,
    })
    const initialBytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('# Saved source'),
    ])
    const resolve = vi.fn(async () => resource)
    const replaceFile = vi.fn(
      async (resourceId: string, encodedData: string, drive?: string, ifMatch?: number) =>
        replaceFileResult(
          { resourceId, encodedData, drive, ifMatch },
          {
            ...resource,
            kind: 'file',
            rid: resource.rid ?? resource.resourceId,
            path: resource.path ?? null,
            bytes: resource.bytes ?? 0,
            version: 2,
          }
        )
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          downloadPreview: vi.fn(async (_uri: string, maxBytes: number) =>
            previewDownloadResult(resource, initialBytes.buffer, maxBytes)
          ),
          affordances: vi.fn(async () =>
            delegationAffordances(
              new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
              false
            )
          ),
          replaceFile,
        },
      },
    })
    controllerMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'user-bom:main',
      sessionGeneration: 1,
      principalScope: 'principal-bom',
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const owner = new MarkdownDraftOwner()
    const binding = {
      principalOwner: 'principal-bom',
      scopeKey: 'user-bom:main',
      tabId: 'tab-bom',
      gfsUri: uri,
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <FilePreviewPage
          byteLength={initialBytes.byteLength}
          fileKind="markdown"
          fileName="bom.md"
          gfsUri={uri}
          markdownDraftOwner={owner}
          markdownPrincipalOwner={binding.principalOwner}
          tabId={binding.tabId}
        />
      </QueryClientProvider>
    )
    await waitFor(() =>
      expect(owner.get(binding)).toMatchObject({
        savedSnapshot: { content: '\uFEFF# Saved source', version: 1 },
        capability: 'positive',
      })
    )
    fireEvent.click(
      within(
        screen
          .getByRole('heading', { name: 'bom.md', level: 2 })
          .closest('.da-gfs-preview-title-row') as HTMLElement
      ).getByRole('button', { name: 'Options for bom.md' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const editor = await screen.findByRole('textbox', { name: 'Edit Markdown source for bom.md' })
    const editedSource = '\uFEFF# Edited source'
    fireEvent.change(editor, { target: { value: editedSource } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(replaceFile).toHaveBeenCalledOnce())
    const encodedData = replaceFile.mock.calls[0]?.[1]
    if (encodedData === undefined) throw new Error('Save did not include encoded source bytes')
    expect(Array.from(atob(encodedData), character => character.charCodeAt(0))).toEqual(
      Array.from(new TextEncoder().encode(editedSource))
    )
    owner.quit()
    client.clear()
  })

  it('keeps a dirty draft inspectable after the preview becomes unavailable', async () => {
    const uri = 'gfs://main/1123456789abcdef0123456789abcdef'
    const resource = await resolveResource({
      resourceId: '1123456789abcdef0123456789abcdef',
      rid: '1123456789abcdef0123456789abcdef',
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'parent',
      name: 'unavailable.md',
      kind: 'file',
      version: 1,
      bytes: 12,
    })
    const source = '# Saved source'
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resource),
          downloadPreview: vi.fn(async (_uri: string, maxBytes: number) =>
            previewDownloadResult(resource, new TextEncoder().encode(source).buffer, maxBytes)
          ),
          affordances: vi.fn(async () =>
            delegationAffordances(
              new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
              false
            )
          ),
        },
      },
    })
    controllerMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'user-a:main',
      sessionGeneration: 1,
      principalScope: 'principal-a',
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const owner = new MarkdownDraftOwner()
    const props = {
      byteLength: 12,
      fileKind: 'markdown' as const,
      fileName: 'unavailable.md',
      gfsUri: uri,
      markdownDraftOwner: owner,
      markdownPrincipalOwner: 'principal-a',
      tabId: 'tab-unavailable',
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const view = render(
      <QueryClientProvider client={client}>
        <FilePreviewPage {...props} />
      </QueryClientProvider>
    )
    await screen.findByRole('heading', { name: 'Saved source' })
    await waitFor(() =>
      expect(
        owner.get({
          principalOwner: 'principal-a',
          scopeKey: 'user-a:main',
          tabId: 'tab-unavailable',
          gfsUri: uri,
        })?.capability
      ).toBe('positive')
    )
    fireEvent.click(
      within(
        screen
          .getByRole('heading', { name: 'unavailable.md', level: 2 })
          .closest('.da-gfs-preview-title-row') as HTMLElement
      ).getByRole('button', { name: 'Options for unavailable.md' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Edit Markdown source for unavailable.md' }),
      { target: { value: '# Keep this local draft' } }
    )
    view.rerender(
      <QueryClientProvider client={client}>
        <FilePreviewPage {...props} unavailable />
      </QueryClientProvider>
    )
    expect(screen.getByLabelText('Unsaved Markdown draft content').textContent).toBe(
      '# Keep this local draft'
    )
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    owner.quit()
    client.clear()
  })

  it('keeps only the exact dirty draft inspectable and copyable when unavailable', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource = await resolveResource({
      resourceId: '0123456789abcdef0123456789abcdef',
      rid: '0123456789abcdef0123456789abcdef',
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'parent',
      name: 'private.md',
      kind: 'file',
      version: 4,
      bytes: 12,
    })
    const source = '# Saved source'
    const resolve = vi.fn(async () => resource)
    const downloadPreview = vi.fn(async (_uri: string, maxBytes: number) =>
      previewDownloadResult(resource, new TextEncoder().encode(source).buffer, maxBytes)
    )
    const affordances = delegationAffordances(
      new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
      false
    )
    const loadAffordances = vi.fn(async () => affordances)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          downloadPreview,
          affordances: loadAffordances,
        },
      },
    })
    controllerMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'user-a:main',
      sessionGeneration: 1,
      principalScope: 'principal-a',
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const owner = new MarkdownDraftOwner()
    const props = {
      byteLength: 12,
      fileKind: 'markdown' as const,
      fileName: 'private.md',
      gfsUri: uri,
      markdownDraftOwner: owner,
      markdownPrincipalOwner: 'principal-a',
      tabId: 'tab-a',
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const view = render(
      <QueryClientProvider client={client}>
        <FilePreviewPage {...props} />
      </QueryClientProvider>
    )
    await screen.findByRole('heading', { name: 'Saved source' })
    await waitFor(() => expect(loadAffordances).toHaveBeenCalled())
    const title = screen.getByRole('heading', { name: 'private.md', level: 2 })
    fireEvent.click(
      within(title.closest('.da-gfs-preview-title-row') as HTMLElement).getByRole('button', {
        name: 'Options for private.md',
      })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Edit Markdown source for private.md' }),
      {
        target: { value: '# Unsaved private draft' },
      }
    )
    await waitFor(() =>
      expect(
        owner.get({
          principalOwner: 'principal-a',
          scopeKey: 'user-a:main',
          tabId: 'tab-a',
          gfsUri: uri,
        })?.dirty
      ).toBe(true)
    )

    const readsBeforeUnavailable = resolve.mock.calls.length
    view.rerender(
      <QueryClientProvider client={client}>
        <FilePreviewPage {...props} unavailable />
      </QueryClientProvider>
    )
    expect(screen.getByLabelText('Unsaved Markdown draft content').textContent).toBe(
      '# Unsaved private draft'
    )
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(readsBeforeUnavailable)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Copy unsaved draft' }))
    expect(writeText).toHaveBeenCalledWith('# Unsaved private draft')
    owner.quit()
    client.clear()
  })
})
