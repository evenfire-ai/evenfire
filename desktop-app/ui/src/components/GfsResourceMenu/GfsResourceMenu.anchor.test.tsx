// @vitest-environment jsdom
import { Fragment, StrictMode, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import { gfsRowActionAvailability } from '@lib/gfsRowActionAvailability'
import type { GfsRowActionAvailability } from '@lib/gfsRowActionAvailability.types'
import { childView, listChildrenPage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { GfsResourceMenu } from './index'
import type { GfsResourceMenuPermissionStatus, GfsResourceMenuProps } from './types'

type GfsHeldAffordances = ReturnType<typeof heldPermissionResponse>
type ChildResource = Awaited<ReturnType<typeof listChildrenPage>>['items'][number]

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function folderChild(name: string): Promise<ChildResource> {
  const page = await listChildrenPage([
    childView('target', name, 'file', { parentResourceId: 'target-parent' }),
  ])
  return page.items[0]!
}

/**
 * Stand-in for the tree's menu owner: it reads the target's and its parent's
 * affordances through `window.clerum.gfs.affordances`, feeds them to
 * `gfsRowActionAvailability`, and offers every action optimistically until
 * they resolve, leaving the menu to keep the bit-dependent ones inert.
 */
function AnchoredMenuOwner({ resource }: { resource: ChildResource }) {
  const [bits, setBits] = useState<{
    status: GfsResourceMenuPermissionStatus
    availability?: GfsRowActionAvailability
  }>({ status: 'pending' })
  useEffect(() => {
    let live = true
    const read = (id: string) => window.clerum.gfs.affordances(id, 'main')
    Promise.all([read(resource.resourceId), read(resource.parentResourceId!)]).then(
      ([rowAffordances, parentAffordances]) => {
        if (!live) return
        setBits({
          status: 'ok',
          availability: gfsRowActionAvailability({
            resource,
            listing: 'folder',
            rowAffordances,
            parentAffordances,
          }),
        })
      },
      () => live && setBits({ status: 'error' })
    )
    return () => {
      live = false
    }
  }, [resource])
  const allowed = (key: keyof GfsRowActionAvailability) =>
    bits.status !== 'ok' || Boolean(bits.availability?.[key])
  const actions = buildGfsResourceActions({
    kind: resource.kind,
    uri: resource.gfsUri,
    moveApplicable: true,
    previewable: true,
    handlers: {
      share: vi.fn(),
      'copy-link': vi.fn(),
      preview: vi.fn(),
      rename: vi.fn(),
      move: vi.fn(),
      download: vi.fn(),
      delete: vi.fn(),
    },
    canShare: allowed('canManage'),
    canRename: allowed('canRename'),
    canMove: allowed('canMove'),
    canDelete: allowed('canDelete'),
    // The listing's `readable` gate stays with the owner, as in Files.
    canPreview: true,
    canDownload: true,
  })
  return (
    <GfsResourceMenu
      actions={actions}
      anchor={{ x: 40, y: 40 }}
      permissionStatus={bits.status}
      resourceName={resource.name}
    />
  )
}

function stubAffordances(resolveHeld: (resourceId: string) => Promise<GfsHeldAffordances>) {
  const produce = appServiceAffordanceProducer(resolveHeld)
  vi.stubGlobal('clerum', { gfs: { affordances: produce } })
}

/** Runnable: neither natively disabled nor `aria-disabled`. */
function itemEnabled(menu: HTMLElement, name: string): boolean {
  const item = within(menu).getByRole('menuitem', { name }) as HTMLButtonElement
  return !item.disabled && item.getAttribute('aria-disabled') !== 'true'
}

/**
 * The tree's ownership contract in miniature: the menu is unmounted on its
 * dismissal, while `onOpenChange` only feeds an app-level open flag.
 */
function TreeMenuHost({ treeMounted }: { treeMounted: boolean }) {
  const [treeMenuOpen, setTreeMenuOpen] = useState(false)
  const [menuMounted, setMenuMounted] = useState(true)
  return (
    <>
      <output data-testid="tree-menu-open">{String(treeMenuOpen)}</output>
      <output data-testid="menu-mounted">{String(menuMounted)}</output>
      {treeMounted && menuMounted ? (
        <GfsResourceMenu
          anchor={{ x: 10, y: 10 }}
          permissionStatus="ok"
          resourceName="notes.md"
          onDismiss={() => setMenuMounted(false)}
          onOpenChange={setTreeMenuOpen}
          onRename={vi.fn()}
        />
      ) : null}
    </>
  )
}

describe('GfsResourceMenu anchor mode', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps bit-dependent items inert while the bits are pending and enables them once they resolve', async () => {
    const held = new Map<string, ReturnType<typeof deferred<GfsHeldAffordances>>>()
    stubAffordances(resourceId => {
      const pending = deferred<GfsHeldAffordances>()
      held.set(resourceId, pending)
      return pending.promise
    })
    const resource = await folderChild('notes.md')
    render(<AnchoredMenuOwner resource={resource} />)

    const menu = screen.getByRole('menu', { name: 'Actions for notes.md' })
    expect(itemEnabled(menu, 'Rename')).toBe(false)
    expect(itemEnabled(menu, 'Move to')).toBe(false)
    expect(itemEnabled(menu, 'Delete')).toBe(false)
    expect(itemEnabled(menu, 'Preview')).toBe(true)
    expect(itemEnabled(menu, 'Download')).toBe(true)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
    const flyout = screen.getByRole('menu', { name: 'Share options for notes.md' })
    expect(itemEnabled(flyout, 'Share')).toBe(false)
    expect(itemEnabled(flyout, 'Copy link')).toBe(true)

    await act(async () => {
      held.get('target')!.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
      held.get('target-parent')!.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })

    expect(itemEnabled(menu, 'Rename')).toBe(true)
    expect(itemEnabled(menu, 'Move to')).toBe(true)
    // The target holds no `delete`: still offered, greyed out with its reason.
    expect(itemEnabled(menu, 'Delete')).toBe(false)
    expect(within(menu).getByRole('menuitem', { name: 'Delete' }).getAttribute('title')).toBe(
      "Delete isn't available"
    )
    expect(itemEnabled(flyout, 'Share')).toBe(true)
  })

  it('keeps bit-dependent items inert when the bits fail to load', async () => {
    stubAffordances(async () => {
      throw new Error('affordances unavailable')
    })
    const resource = await folderChild('notes.md')
    render(<AnchoredMenuOwner resource={resource} />)
    await act(async () => {})

    const menu = screen.getByRole('menu', { name: 'Actions for notes.md' })
    expect(itemEnabled(menu, 'Rename')).toBe(false)
    expect(itemEnabled(menu, 'Delete')).toBe(false)
    expect(itemEnabled(menu, 'Download')).toBe(true)
  })

  it('opens at the point without a trigger button', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.classList.contains('da-gfs-resource-menu__panel')
        ? rect(0, 0, 200, 150)
        : rect(0, 0, 0, 0)
    })
    const onOpenChange = vi.fn()
    render(
      <GfsResourceMenu
        anchor={{ x: 100, y: 200 }}
        permissionStatus="ok"
        onCopyLink={vi.fn()}
        onOpenChange={onOpenChange}
        onRename={vi.fn()}
        resourceName="notes.md"
      />
    )

    expect(screen.queryByRole('button', { name: 'Options for notes.md' })).toBeNull()
    const menu = screen.getByRole('menu', { name: 'Actions for notes.md' })
    expect(menu.style.left).toBe('106px')
    expect(menu.style.top).toBe('206px')
    expect(onOpenChange.mock.calls).toEqual([[true]])
  })

  it('flips away from the right and bottom edges near the viewport corner', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.classList.contains('da-gfs-resource-menu__panel')
        ? rect(0, 0, 200, 150)
        : rect(0, 0, 0, 0)
    })
    render(
      <GfsResourceMenu
        anchor={{ x: 950, y: 750 }}
        permissionStatus="ok"
        onRename={vi.fn()}
        resourceName="a"
      />
    )

    const menu = screen.getByRole('menu', { name: 'Actions for a' })
    expect(menu.style.left).toBe('744px')
    expect(menu.style.top).toBe('594px')
  })

  it.each([
    // StrictMode replays the mount report before the real close.
    ['', Fragment, [[true], [false]]],
    [' under StrictMode', StrictMode, [[true], [false], [true], [false]]],
  ])(
    'returns focus to the element focused before it opened when Escape closes it%s',
    (_label, Wrapper, expectedReports) => {
      const row = document.createElement('button')
      row.textContent = 'notes.md row'
      document.body.appendChild(row)
      row.focus()
      const onOpenChange = vi.fn()
      render(
        <Wrapper>
          <GfsResourceMenu
            anchor={{ x: 10, y: 10 }}
            permissionStatus="ok"
            onOpenChange={onOpenChange}
            onRename={vi.fn()}
            resourceName="notes.md"
          />
        </Wrapper>
      )
      const rename = screen.getByRole('menuitem', { name: 'Rename' })
      expect(document.activeElement).toBe(rename)

      fireEvent.keyDown(rename, { key: 'Escape' })

      expect(screen.queryByRole('menu', { name: 'Actions for notes.md' })).toBeNull()
      expect(document.activeElement).toBe(row)
      expect(onOpenChange.mock.calls).toEqual(expectedReports)
      row.remove()
    }
  )

  it.each([
    ['anchor', { anchor: { x: 10, y: 10 }, permissionStatus: 'ok' as const }],
    ['trigger', {}],
  ])('reports closed when unmounted while open (%s mode)', (_mode, props) => {
    const onOpenChange = vi.fn()
    const { unmount } = render(
      <GfsResourceMenu
        {...props}
        onOpenChange={onOpenChange}
        onRename={vi.fn()}
        resourceName="notes.md"
      />
    )
    const trigger = screen.queryByRole('button', { name: 'Options for notes.md' })
    if (trigger) fireEvent.click(trigger)
    expect(onOpenChange.mock.calls).toEqual([[true]])

    unmount()

    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it('stays mounted under StrictMode and leaves unmounting to the dismissal', () => {
    render(
      <StrictMode>
        <TreeMenuHost treeMounted />
      </StrictMode>
    )
    expect(screen.getByRole('menu', { name: 'Actions for notes.md' })).toBeTruthy()
    expect(screen.getByTestId('tree-menu-open').textContent).toBe('true')
    expect(screen.getByTestId('menu-mounted').textContent).toBe('true')

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' })

    expect(screen.queryByRole('menu', { name: 'Actions for notes.md' })).toBeNull()
    expect(screen.getByTestId('tree-menu-open').textContent).toBe('false')
    expect(screen.getByTestId('menu-mounted').textContent).toBe('false')
  })

  it.each([
    ['a click outside it', () => fireEvent.mouseDown(document.body)],
    ['choosing an action', () => fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))],
  ])('reports a dismissal on %s', (_label, dismiss) => {
    const onDismiss = vi.fn()
    const onRename = vi.fn()
    render(
      <GfsResourceMenu
        anchor={{ x: 10, y: 10 }}
        permissionStatus="ok"
        resourceName="notes.md"
        onDismiss={onDismiss}
        onRename={onRename}
      />
    )
    expect(onDismiss).not.toHaveBeenCalled()

    dismiss()

    expect(onDismiss).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Actions for notes.md' })).toBeNull()
  })

  it('reports closed when the tree unmounts with the menu open under StrictMode', () => {
    const { rerender } = render(
      <StrictMode>
        <TreeMenuHost treeMounted />
      </StrictMode>
    )
    expect(screen.getByTestId('tree-menu-open').textContent).toBe('true')

    rerender(
      <StrictMode>
        <TreeMenuHost treeMounted={false} />
      </StrictMode>
    )

    expect(screen.queryByRole('menu', { name: 'Actions for notes.md' })).toBeNull()
    expect(screen.getByTestId('tree-menu-open').textContent).toBe('false')
  })

  it.each([
    ['enabled', 'ok', 1],
    ['inert', 'pending', 0],
  ] as const)(
    'keeps the hidden Replace input out of the tab order and %s with %s bits',
    (_label, permissionStatus, expectedRuns) => {
      const replace = vi.fn()
      const actions = buildGfsResourceActions({
        kind: 'file',
        uri: 'gfs://main/0123456789abcdef0123456789abcdef',
        moveApplicable: true,
        previewable: true,
        handlers: { replace },
        canReplace: true,
      })
      const onReplace = vi.fn()
      const variants: Array<Pick<GfsResourceMenuProps, 'actions' | 'onReplace'>> = [
        { actions },
        { onReplace },
      ]
      for (const variant of variants) {
        const { unmount } = render(
          <GfsResourceMenu
            {...variant}
            anchor={{ x: 10, y: 10 }}
            permissionStatus={permissionStatus}
            resourceName="report.txt"
          />
        )
        const input = screen.getByLabelText('Replace report.txt')
        expect(input.tabIndex).toBe(-1)
        fireEvent.change(input, {
          target: { files: [new File(['replacement'], 'replacement.txt')] },
        })
        unmount()
      }

      expect(replace.mock.calls.filter(([file]) => file instanceof File)).toHaveLength(expectedRuns)
      expect(onReplace).toHaveBeenCalledTimes(expectedRuns)
    }
  )

  it('treats an anchored menu without a permission status as pending', () => {
    render(
      <GfsResourceMenu
        anchor={{ x: 10, y: 10 }}
        onPreview={vi.fn()}
        onRename={vi.fn()}
        resourceName="notes.md"
      />
    )

    const menu = screen.getByRole('menu', { name: 'Actions for notes.md' })
    expect(itemEnabled(menu, 'Rename')).toBe(false)
    expect(itemEnabled(menu, 'Preview')).toBe(true)
  })
})
