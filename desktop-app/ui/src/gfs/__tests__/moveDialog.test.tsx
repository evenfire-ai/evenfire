// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { GfsBrowserChild, GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import { GfsMoveDialog } from '../moveDialog'

/**
 * R4 spec §3 — Move destination navigation is paginated: destinations beyond
 * page one must be reachable through an observable Load-more control, and a
 * page-two destination commits like any other. Cycle prevention (never offer
 * the moved resource itself; never commit through its own subtree) must hold
 * across pages.
 */

afterEach(cleanup)

const target = { resourceId: 'file-1', name: 'notes.txt', kind: 'file' as const }

function folder(id: string, name: string): GfsBrowserChild {
  return {
    resourceId: id,
    rid: id,
    gfsUri: `gfs://main/${id}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind: 'directory',
    path: `/${name}`,
    version: 1,
    bytes: 0,
  }
}

const parentCrumb: GfsCrumb = {
  resourceId: 'folder-1',
  gfsUri: 'gfs://main/folder-1',
  name: 'Product',
  kind: 'directory',
  version: 1,
  bytes: 0,
}

function renderDialog(
  producers: { listAccessible?: () => Promise<unknown>; listChildren?: () => Promise<unknown> },
  props: Partial<Parameters<typeof GfsMoveDialog>[0]> = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        listAccessible:
          producers.listAccessible ??
          (vi.fn(async () => ({ items: [], nextCursor: null })) as () => Promise<unknown>),
        listChildren:
          producers.listChildren ??
          (vi.fn(async () => ({ items: [], nextCursor: null })) as () => Promise<unknown>),
      },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <GfsMoveDialog
        target={target}
        initialCrumbs={[]}
        onMove={vi.fn(async () => undefined)}
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  )
}

describe('GfsMoveDialog pagination', () => {
  it('loads page two of the root destinations and commits a move to a page-two folder', async () => {
    const onMove = vi.fn(async () => undefined)
    let call = 0
    const listAccessible = vi.fn(async () => {
      call += 1
      return call === 1
        ? { items: [folder('arch-1', 'Archive')], nextCursor: 'page-2' }
        : { items: [folder('deep-9', 'Deep Storage')], nextCursor: null }
    })

    renderDialog({ listAccessible }, { onMove })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    expect(await within(dialog).findByRole('button', { name: 'Archive' })).toBeTruthy()
    // Page two is not silently fetched, but reachable through Load more.
    expect(within(dialog).queryByRole('button', { name: 'Deep Storage' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Load more' })).toBeTruthy()

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }))

    expect(await within(dialog).findByRole('button', { name: 'Deep Storage' })).toBeTruthy()
    // Page-one rows stay rendered while additional pages load.
    expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Load more' })).toBeNull()

    // A page-two destination selects and commits like a page-one row.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Deep Storage' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Deep Storage)' }))

    expect(onMove).toHaveBeenCalledWith('deep-9', 'Deep Storage')
  })

  it('loads page two inside a child folder listing and keeps cycle prevention', async () => {
    const directoryTarget = { resourceId: 'moved-folder', name: 'Docs', kind: 'directory' as const }
    const onMove = vi.fn(async () => undefined)
    let call = 0
    const listChildren = vi.fn(async () => {
      call += 1
      return call === 1
        ? {
            items: [folder('moved-folder', 'Docs'), folder('arch-1', 'Archive')],
            nextCursor: 'p2',
          }
        : { items: [folder('nested-7', 'Nested Vault')], nextCursor: null }
    })

    renderDialog(
      { listChildren },
      { target: directoryTarget, initialCrumbs: [parentCrumb], onMove }
    )

    const dialog = await screen.findByRole('dialog', { name: 'Move folder Docs' })
    expect(await within(dialog).findByRole('button', { name: 'Archive' })).toBeTruthy()
    // The moved resource itself is never offered as a destination — on any page.
    expect(within(dialog).queryByRole('button', { name: 'Docs' })).toBeNull()

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }))
    expect(await within(dialog).findByRole('button', { name: 'Nested Vault' })).toBeTruthy()

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Nested Vault' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Nested Vault)' }))

    expect(onMove).toHaveBeenCalledWith('nested-7', 'Nested Vault')
  })

  it('keeps the empty notice when the listing has no next page', async () => {
    renderDialog({})

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    expect(await within(dialog).findByText('No folders here.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})
