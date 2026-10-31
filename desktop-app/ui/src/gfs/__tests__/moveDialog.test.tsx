// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
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
const SESSION_GENERATION = 7

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
  producers: {
    listAccessible?: () => Promise<unknown>
    listChildren?: (resourceId: string) => Promise<unknown>
  },
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
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <GfsMoveDialog
        target={target}
        drive="main"
        // No caller home unless a test supplies one: the pre-existing
        // pagination and no-op cases exercise the shared roots only.
        home={null}
        sessionScope="anonymous"
        sessionGeneration={SESSION_GENERATION}
        initialCrumbs={[]}
        onMove={vi.fn(async () => undefined)}
        onRetryPermissionCheck={vi.fn(async () => undefined)}
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  )
  return { ...rendered, queryClient }
}

describe('GfsMoveDialog unknown session generation', () => {
  it('does not read destinations or enable Move without a published generation', async () => {
    const listAccessible = vi.fn(async () => ({
      items: [folder('dest', 'Destination')],
      nextCursor: null,
    }))
    renderDialog({ listAccessible }, { sessionGeneration: null })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    expect(listAccessible).not.toHaveBeenCalled()
    expect(within(dialog).queryByRole('button', { name: 'Destination' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Move' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('GfsMoveDialog pagination', () => {
  it('purges cached destination rows after an expanded folder is denied', async () => {
    let childReads = 0
    const listAccessible = vi.fn(async () => ({
      items: [folder('folder-1', 'Product')],
      nextCursor: null,
    }))
    const listChildren = vi.fn(async () => {
      childReads += 1
      if (childReads === 1) return { items: [folder('folder-2', 'Assets')], nextCursor: null }
      throw new Error('403 Forbidden: httpStatus=403')
    })
    const { queryClient } = renderDialog({ listAccessible, listChildren })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    await within(dialog).findByRole('button', { name: 'Product' })
    expect(
      queryClient.getQueryCache().find({
        queryKey: desktopQueryKeys.gfsAccessible('anonymous', 'main', SESSION_GENERATION),
        exact: true,
      })
    ).toBeDefined()
    const tree = within(dialog).getByRole('tree', { name: 'EvenDrive destination folders' })
    expect(await within(tree).findByRole('button', { name: 'Product' })).toBeTruthy()
    await fireEvent.click(within(tree).getByRole('button', { name: 'Expand Product' }))
    expect(await within(tree).findByRole('button', { name: 'Assets' })).toBeTruthy()
    expect(
      queryClient.getQueryCache().find({
        queryKey: desktopQueryKeys.gfsChildren('anonymous', 'folder-1', 'main', SESSION_GENERATION),
        exact: true,
      })
    ).toBeDefined()

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: desktopQueryKeys.gfsChildren('anonymous', 'folder-1', 'main', SESSION_GENERATION),
      })
    })

    expect(listChildren).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(within(tree).queryByRole('button', { name: 'Assets' })).toBeNull())
    expect(within(tree).getByRole('button', { name: 'Product' })).toBeTruthy()
  })

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
    expect(within(dialog).getByText('Move “notes.txt”')).toBeTruthy()
    expect(within(dialog).queryByText('Suggested')).toBeNull()
    expect(within(dialog).queryByText('Starred')).toBeNull()
    expect(within(dialog).queryByText('All locations')).toBeNull()
    const archive = await within(dialog).findByRole('button', { name: 'Archive' })
    expect(archive.classList.contains('da-gfs-move-dialog__tree-select')).toBe(true)
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

  it('keeps the hierarchy visible while expanding and selecting a nested destination', async () => {
    const onMove = vi.fn(async () => undefined)
    const listAccessible = vi.fn(async () => ({
      items: [folder('folder-1', 'Product')],
      nextCursor: null,
    }))
    const listChildren = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folder-1') {
        return { items: [folder('folder-2', 'Assets')], nextCursor: null }
      }
      return { items: [folder('folder-3', 'Reports')], nextCursor: null }
    })

    renderDialog({ listAccessible, listChildren }, { onMove })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    const tree = within(dialog).getByRole('tree', { name: 'EvenDrive destination folders' })
    expect(await within(tree).findByRole('button', { name: 'Product' })).toBeTruthy()

    await fireEvent.click(within(tree).getByRole('button', { name: 'Expand Product' }))
    expect(await within(tree).findByRole('button', { name: 'Assets' })).toBeTruthy()
    expect(within(tree).getByRole('button', { name: 'Product' })).toBeTruthy()

    // Selecting a folder also opens it, so the next level is available without
    // leaving the current tree view.
    await fireEvent.click(within(tree).getByRole('button', { name: 'Assets' }))
    expect(await within(tree).findByRole('button', { name: 'Reports' })).toBeTruthy()

    await fireEvent.click(within(tree).getByRole('button', { name: 'Reports' }))
    expect(
      within(tree).getByRole('button', { name: 'Reports' }).getAttribute('aria-selected')
    ).toBe('true')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Reports)' }))

    expect(onMove).toHaveBeenCalledWith('folder-3', 'Reports')
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
      {
        listAccessible: vi.fn(async () => ({
          items: [folder(parentCrumb.resourceId, parentCrumb.name)],
          nextCursor: null,
        })),
        listChildren,
      },
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

  it('presents a refused destination listing instead of reporting no folders', async () => {
    // Two separate claims the dialog used to make about a 429: the banner read
    // "Error invoking remote method 'gfs:listAccessible'" — our own process
    // boundary — and the tree said there were no folders, which the refused
    // request never established.
    const listAccessible = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
          'Too Many Requests httpStatus=429 retryAfterSeconds=7'
      )
    })

    renderDialog({ listAccessible })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    // Liveness witness: the listing really ran and really rejected, so the
    // absence of "No folders here." is a presented refusal and not a dialog
    // that never asked.
    expect(listAccessible).toHaveBeenCalled()
    expect(
      await within(dialog).findByText('Too many file requests — try again in 7s.')
    ).toBeTruthy()
    expect(within(dialog).queryByText(/Error invoking remote method/)).toBeNull()
    expect(within(dialog).queryByText('No folders here.')).toBeNull()
    expect(within(dialog).getByText('Destinations could not be listed.')).toBeTruthy()
  })
})

describe('GfsMoveDialog no-op destination guard', () => {
  it('does not preselect the current parent and reports the real current location', async () => {
    const listAccessible = vi.fn(async () => ({
      items: [folder('folder-1', 'Product'), folder('arch-1', 'Archive')],
      nextCursor: null,
    }))

    renderDialog({ listAccessible }, { initialCrumbs: [parentCrumb] })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    // The location pill names the folder that CONTAINS the target (the last
    // crumb), never the selection — and the old trap preselected exactly it.
    expect(within(dialog).getByText('Product', { selector: 'strong' })).toBeTruthy()
    expect(within(dialog).getByText('Select a destination folder')).toBeTruthy()
    const moveButton = within(dialog).getByRole('button', { name: 'Move' }) as HTMLButtonElement
    expect(moveButton.disabled).toBe(true)
  })

  it('refuses a no-op move into the folder that already contains the target', async () => {
    const onMove = vi.fn(async () => undefined)
    const listAccessible = vi.fn(async () => ({
      items: [folder('folder-1', 'Product'), folder('arch-1', 'Archive')],
      nextCursor: null,
    }))

    // Row-style target carrying its real parent id (e.g. a root-listed file
    // that actually lives in a shared folder).
    renderDialog(
      { listAccessible },
      {
        onMove,
        target: { ...target, parentResourceId: 'folder-1' },
        initialCrumbs: [],
      }
    )

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    // No breadcrumb context: the pill is honest about the unknown name.
    expect(within(dialog).getByText('another shared folder')).toBeTruthy()

    const productRow = await within(dialog).findByRole('button', { name: 'Product' })
    await fireEvent.click(productRow)
    const noOpButton = within(dialog).getByRole('button', {
      name: 'Move here (Product)',
    }) as HTMLButtonElement
    expect(noOpButton.disabled).toBe(true)
    expect(within(dialog).getByText(/is already in/)).toBeTruthy()

    // A different destination still commits normally.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
    expect(onMove).toHaveBeenCalledWith('arch-1', 'Archive')
    expect(onMove).toHaveBeenCalledTimes(1)
  })
})

/**
 * R3-M2 (plan §5.3, M2-U1..U6) — the Move dialog offers the caller's own home
 * as a "My home" destination and never lists it under "Shared with me". The
 * server names the home row after its storage folder; only the resource id and
 * drive identify it, so every label here comes from `isCallerHomeRoot`.
 */

const readyHome = {
  state: 'ready',
  drive: 'main',
  resourceId: 'home-1',
  path: '/Users/fixture',
}

const pendingHome = {
  // Deliberately carries the bound root: the server returns `state` and
  // `resource_id` independently, so a retrying home can be pending with a
  // resource id. The only reason the section is absent is the non-ready state.
  state: 'pending',
  drive: 'main',
  resourceId: 'home-1',
  path: '/Users/fixture',
}

/** Discovery row of the caller's home root, named after the storage folder. */
const homeRootRow: GfsBrowserChild = {
  ...folder('home-1', 'fixture'),
  path: '/Users/fixture',
}

const homeCrumb: GfsCrumb = {
  resourceId: 'home-1',
  gfsUri: 'gfs://main/home-1',
  name: 'fixture',
  kind: 'directory',
  version: 1,
  bytes: 0,
}

const sharedRootRow = folder('team-1', 'Team Docs')

describe('GfsMoveDialog My home destination', () => {
  it('lists the caller home as a My home destination apart from Shared with me', async () => {
    const listAccessible = vi.fn(async () => ({
      items: [homeRootRow, sharedRootRow],
      nextCursor: null,
    }))

    renderDialog({ listAccessible }, { home: readyHome })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    const homeTree = within(dialog).getByRole('tree', { name: 'My home destination' })
    expect(within(homeTree).getByRole('treeitem', { name: 'My home' })).toBeTruthy()

    const sharedTree = within(dialog).getByRole('tree', { name: 'EvenDrive destination folders' })
    // Witness: what others share is still a destination.
    expect(await within(sharedTree).findByRole('treeitem', { name: 'Team Docs' })).toBeTruthy()
    // The home is offered once, under My home — neither relabelled into the
    // shared roots nor leaked under its storage folder name.
    expect(within(sharedTree).queryByRole('treeitem', { name: 'My home' })).toBeNull()
    expect(within(sharedTree).queryByText('fixture')).toBeNull()
  })

  it('moves into My home and commits the destination as My home', async () => {
    const onMove = vi.fn(async () => undefined)
    const listAccessible = vi.fn(async () => ({
      items: [homeRootRow, sharedRootRow],
      nextCursor: null,
    }))

    renderDialog({ listAccessible }, { home: readyHome, onMove })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    const homeTree = within(dialog).getByRole('tree', { name: 'My home destination' })
    // Witness: the destination really rendered before it is selected, so the
    // call count below cannot pass on a dialog that never offered it.
    expect(within(homeTree).getByRole('treeitem', { name: 'My home' })).toBeTruthy()
    await fireEvent.click(within(homeTree).getByRole('button', { name: 'My home' }))

    const moveHere = within(dialog).getByRole('button', { name: 'Move here (My home)' })
    expect(moveHere).toBeTruthy()
    await fireEvent.click(moveHere)

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith('home-1', 'My home')
  })

  it('names the current location My home when the target sits at the home root', async () => {
    const listAccessible = vi.fn(async () => ({ items: [], nextCursor: null }))

    renderDialog({ listAccessible }, { home: readyHome, initialCrumbs: [homeCrumb] })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    // Witness: the location pill rendered for this target at all. Scope the
    // label to that row: the ready home's section heading also says My home.
    const currentLocation = within(dialog)
      .getByText('Current location:')
      .closest('.da-gfs-move-dialog__current-location') as HTMLElement | null
    expect(currentLocation).not.toBeNull()
    expect(
      within(currentLocation as HTMLElement).getByText('My home', { selector: 'strong' })
    ).toBeTruthy()
    expect(currentLocation?.textContent).not.toContain('fixture')
    expect(within(dialog).queryByText('fixture')).toBeNull()
  })

  it('lists the home under My home when discovery does not list it', async () => {
    const listAccessible = vi.fn(async () => ({
      items: [sharedRootRow],
      nextCursor: null,
    }))
    const insideHome: GfsCrumb = {
      resourceId: 'folder-2',
      gfsUri: 'gfs://main/folder-2',
      name: 'Projects',
      kind: 'directory',
      version: 1,
      bytes: 0,
    }

    renderDialog({ listAccessible }, { home: readyHome, initialCrumbs: [homeCrumb, insideHome] })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    // Discovery never names the home root; the current path supplies it, and
    // the home must still land in the My home section. Here the home root is
    // expanded (the crumbs start on it), so its treeitem's accessible name is
    // its label plus the child group's text ("My home No subfolders."); the
    // label prefix is what identifies it.
    const homeTree = within(dialog).getByRole('tree', { name: 'My home destination' })
    expect(await within(homeTree).findByRole('treeitem', { name: /^My home/ })).toBeTruthy()

    const sharedTree = within(dialog).getByRole('tree', { name: 'EvenDrive destination folders' })
    expect(await within(sharedTree).findByRole('treeitem', { name: 'Team Docs' })).toBeTruthy()
    expect(within(sharedTree).queryByRole('treeitem', { name: 'My home' })).toBeNull()
    expect(within(sharedTree).queryByText('fixture')).toBeNull()
  })

  it('omits the My home destination while the home is pending', async () => {
    const listAccessible = vi.fn(async () => ({
      items: [sharedRootRow],
      nextCursor: null,
    }))

    renderDialog({ listAccessible }, { home: pendingHome })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    const sharedTree = within(dialog).getByRole('tree', { name: 'EvenDrive destination folders' })
    // Witness: the shared roots are unaffected by the unusable home.
    expect(await within(sharedTree).findByRole('treeitem', { name: 'Team Docs' })).toBeTruthy()
    expect(within(dialog).queryByRole('tree', { name: 'My home destination' })).toBeNull()
    expect(within(dialog).queryByText('My home')).toBeNull()
  })

  it('shows the Shared with me empty state when the home is the only listed root', async () => {
    const listAccessible = vi.fn(async () => ({
      items: [homeRootRow],
      nextCursor: null,
    }))

    renderDialog({ listAccessible }, { home: readyHome })

    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    const homeTree = within(dialog).getByRole('tree', { name: 'My home destination' })
    // Witness: the home really is offered, so the notice below describes only
    // the remaining Shared with me section. The notice can only render once
    // the discovery query settled (a pending query shows "Loading folders…").
    expect(await within(homeTree).findByRole('treeitem', { name: 'My home' })).toBeTruthy()

    const sharedTree = within(dialog).getByRole('tree', { name: 'EvenDrive destination folders' })
    expect(await within(sharedTree).findByText('No folders here.')).toBeTruthy()
    expect(within(sharedTree).queryByText('fixture')).toBeNull()
  })
})
