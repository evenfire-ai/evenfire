// @vitest-environment jsdom
/**
 * Actions an EvenDrive resource may not run are offered greyed out, with the
 * reason as their tooltip, instead of disappearing. The menus here are built
 * the way their surfaces build them: the real surface options, the real
 * action model and the real menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { filesRowActionOptions, sidebarRowActionOptions } from '@lib/gfsResourceActionSurfaces'
import type { GfsResourceAction } from '@lib/gfsResourceActions'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import type { GfsResourceMenuPermissionGateStatus } from '@lib/gfsResourceMenuPermissionGate'
import { gfsRowActionAvailability } from '@lib/gfsRowActionAvailability'
import type { GfsRowListing } from '@lib/gfsRowActionAvailability.types'
import { expectUnavailable, isMenuItemEnabled } from '../../test/gfsMenuItemState'
import { GfsResourceMenu } from './index'

const URI = 'gfs://main/0123456789abcdef0123456789abcdef'

type Row = {
  kind: 'directory' | 'file'
  name: string
  readable?: boolean
  parentResourceId: string | null
  listing: GfsRowListing
  /** The listing's bits (roots) or the row's own affordances (folder children). */
  held: string[]
  parentHeld: string[] | null
}

function availabilityOf(row: Row) {
  return gfsRowActionAvailability({
    resource: { parentResourceId: row.parentResourceId, permissions: row.held },
    listing: row.listing,
    rowAffordances: { held: row.held },
    parentAffordances: row.parentHeld ? { held: row.parentHeld } : null,
  })
}

function rowHandlers() {
  return {
    'copy-link': vi.fn(),
    'open-route': vi.fn(),
    'open-folder': vi.fn(),
    'new-folder': vi.fn(),
    'upload-file': vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    share: vi.fn(),
    delete: vi.fn(),
    preview: vi.fn(),
    download: vi.fn(),
    'download-zip': vi.fn(),
  }
}

function filesRowActions(row: Row, handlers = rowHandlers()) {
  return getGfsMenuActions(
    buildGfsResourceActions(
      filesRowActionOptions({
        kind: row.kind,
        uri: URI,
        readable: row.readable,
        previewable: row.name.endsWith('.md'),
        parentResourceId: row.parentResourceId,
        availability: availabilityOf(row),
        mutating: false,
        handlers,
      })
    )
  )
}

function sidebarRowActions(
  row: Row,
  bits: GfsResourceMenuPermissionGateStatus,
  handlers = rowHandlers()
) {
  return getGfsMenuActions(
    buildGfsResourceActions(
      sidebarRowActionOptions({
        kind: row.kind,
        uri: URI,
        readable: row.readable,
        previewable: row.name.endsWith('.md'),
        parentResourceId: row.parentResourceId,
        bits,
        availability: availabilityOf(row),
        hostAvailable: true,
        mutating: false,
        handlers,
      })
    )
  )
}

function openTriggerMenu(actions: GfsResourceAction[], name: string) {
  const view = render(<GfsResourceMenu actions={actions} resourceName={name} />)
  fireEvent.click(screen.getByRole('button', { name: `Options for ${name}` }))
  return { view, menu: screen.getByRole('menu', { name: `Actions for ${name}` }) }
}

const labels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map(item => item.textContent)

const item = (menu: HTMLElement, name: string) => within(menu).getByRole('menuitem', { name })

describe('GfsResourceMenu: unavailable actions', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('greys out what a read-only subfolder may not do, keeping every item reachable', () => {
    const handlers = rowHandlers()
    const { menu } = openTriggerMenu(
      filesRowActions(
        {
          kind: 'directory',
          name: 'Drafts',
          parentResourceId: 'parent-1',
          listing: 'folder',
          held: ['read'],
          parentHeld: ['read'],
        },
        handlers
      ),
      'Drafts'
    )

    expect(labels(menu)).toEqual([
      'Share',
      'Open folder',
      'Rename',
      'Move to',
      'New folder',
      'Upload file',
      'Download as zip',
      'Delete',
    ])
    for (const label of ['Rename', 'Move to', 'New folder', 'Upload file', 'Delete']) {
      expectUnavailable(item(menu, label), `${label} isn't available`)
    }
    expect(isMenuItemEnabled(item(menu, 'Open folder'))).toBe(true)
    expect(isMenuItemEnabled(item(menu, 'Download as zip'))).toBe(true)
    // Delete keeps its danger colour, only dimmed.
    expect(item(menu, 'Delete').classList.contains('ui-menu-item--danger')).toBe(true)

    // The keyboard walks the greyed-out items too.
    const share = item(menu, 'Share')
    expect(document.activeElement).toBe(share)
    const reached: Array<string | null> = []
    for (let step = 0; step < 7; step += 1) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      reached.push(document.activeElement?.textContent ?? null)
    }
    expect(reached).toEqual(labels(menu).slice(1))

    // Activating an inert item runs nothing and keeps the menu open.
    fireEvent.click(item(menu, 'Rename'))
    fireEvent.click(item(menu, 'Delete'))
    expect(handlers.rename).not.toHaveBeenCalled()
    expect(handlers.delete).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Actions for Drafts' })).toBeTruthy()

    fireEvent.click(share)
    const flyout = screen.getByRole('menu', { name: 'Share options for Drafts' })
    expect(share.getAttribute('aria-disabled')).toBeNull()
    expect(labels(flyout)).toEqual(['Share', 'Copy link'])
    expectUnavailable(item(flyout, 'Share'), "Share isn't available")
    fireEvent.click(item(flyout, 'Copy link'))
    expect(handlers['copy-link']).toHaveBeenCalledOnce()
  })

  it('names the missing read access on the reads of an unreadable file', () => {
    const { menu } = openTriggerMenu(
      filesRowActions({
        kind: 'file',
        name: 'locked.md',
        readable: false,
        parentResourceId: 'parent-1',
        listing: 'folder',
        held: ['read', 'write', 'delete', 'manage_acl'],
        parentHeld: ['read', 'write', 'delete'],
      }),
      'locked.md'
    )
    expectUnavailable(item(menu, 'Preview'), "You don't have read access to this file")
    expectUnavailable(item(menu, 'Download'), "You don't have read access to this file")
    expect(isMenuItemEnabled(item(menu, 'Rename'))).toBe(true)
  })

  it('names the missing read access on the sidebar reads too', () => {
    const { menu } = openTriggerMenu(
      sidebarRowActions(
        {
          kind: 'file',
          name: 'locked.md',
          readable: false,
          parentResourceId: null,
          listing: 'roots',
          held: ['read'],
          parentHeld: null,
        },
        'ok'
      ),
      'locked.md'
    )
    expectUnavailable(item(menu, 'Preview'), "You don't have read access to this file")
    expectUnavailable(item(menu, 'Download'), "You don't have read access to this file")
  })

  it.each([
    ['Files', (row: Row) => filesRowActions(row)],
    ['sidebar', (row: Row) => sidebarRowActions(row, 'ok')],
  ] as const)(
    'offers Move on a %s Shared with me root only when it has a parent folder',
    (_surface, actionsFor) => {
      const root = (parentResourceId: string | null, parentHeld: string[] | null): Row => ({
        kind: 'file',
        name: 'report.txt',
        parentResourceId,
        listing: 'roots',
        held: ['read'],
        parentHeld,
      })

      const allowed = openTriggerMenu(
        actionsFor(root('parent-1', ['read', 'write', 'delete'])),
        'report.txt'
      )
      expect(isMenuItemEnabled(item(allowed.menu, 'Move to'))).toBe(true)
      allowed.view.unmount()

      const refused = openTriggerMenu(actionsFor(root('parent-1', ['read'])), 'report.txt')
      expectUnavailable(item(refused.menu, 'Move to'), "Move to isn't available")
      refused.view.unmount()

      const orphan = openTriggerMenu(actionsFor(root(null, null)), 'report.txt')
      expect(within(orphan.menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    }
  )

  it('keeps the sidebar menu items and their order while the bits settle without permission', () => {
    const row: Row = {
      kind: 'file',
      name: 'notes.md',
      parentResourceId: 'parent-1',
      listing: 'folder',
      held: ['read'],
      parentHeld: ['read'],
    }
    const keysOf = (menu: HTMLElement) =>
      within(menu)
        .getAllByRole('menuitem')
        .map(entry => entry.getAttribute('data-gfs-action'))
    const handlers = rowHandlers()
    const view = render(
      <GfsResourceMenu
        actions={sidebarRowActions(row, 'pending', handlers)}
        anchor={{ x: 10, y: 10 }}
        permissionStatus="pending"
        resourceName="notes.md"
      />
    )
    const menu = screen.getByRole('menu', { name: 'Actions for notes.md' })
    const pendingKeys = keysOf(menu)
    const pendingNodes = within(menu).getAllByRole('menuitem')
    expectUnavailable(item(menu, 'Rename'), "Rename isn't available")

    view.rerender(
      <GfsResourceMenu
        actions={sidebarRowActions(row, 'ok', handlers)}
        anchor={{ x: 10, y: 10 }}
        permissionStatus="ok"
        resourceName="notes.md"
      />
    )

    expect(keysOf(menu)).toEqual(pendingKeys)
    // The same elements stay in place: nothing jumps once the bits arrive.
    expect(within(menu).getAllByRole('menuitem')).toEqual(pendingNodes)
    expectUnavailable(item(menu, 'Rename'), "Rename isn't available")
    expect(isMenuItemEnabled(item(menu, 'Preview'))).toBe(true)
  })

  it('keeps an item held back only by an in-flight change natively disabled, without a reason', () => {
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: URI,
      moveApplicable: false,
      previewable: false,
      handlers: { rename: vi.fn(), delete: vi.fn() },
      canRename: true,
      canDelete: false,
      mutating: true,
    })
    const { menu } = openTriggerMenu(actions, 'report.txt')
    const rename = item(menu, 'Rename') as HTMLButtonElement
    expect(rename.disabled).toBe(true)
    expect(rename.getAttribute('aria-disabled')).toBeNull()
    expect(rename.getAttribute('title')).toBeNull()
    // Refused as well: the permission reason wins.
    expectUnavailable(item(menu, 'Delete'), "Delete isn't available")
  })

  it('refuses a picked file while Replace is greyed out', () => {
    const replace = vi.fn()
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: URI,
      moveApplicable: false,
      previewable: false,
      handlers: { replace },
      canReplace: false,
    })
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const { menu } = openTriggerMenu(actions, 'report.txt')
    expectUnavailable(item(menu, 'Replace file'), "Replace file isn't available")

    fireEvent.click(item(menu, 'Replace file'))
    expect(inputClick).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Replace report.txt'), {
      target: { files: [new File(['replacement'], 'replacement.txt')] },
    })
    expect(replace).not.toHaveBeenCalled()
    // The menu stayed open: the refusal is the model's, not a closed menu's.
    expect(screen.getByRole('menu', { name: 'Actions for report.txt' })).toBeTruthy()
  })

  it('keeps the hidden file picker disabled exactly while Replace is greyed out', () => {
    const replaceInput = () => screen.getByLabelText('Replace report.txt') as HTMLInputElement
    const fileActions = (canReplace: boolean) =>
      buildGfsResourceActions({
        kind: 'file',
        uri: URI,
        moveApplicable: false,
        previewable: false,
        // The page's handler: no file yet means "open the picker".
        handlers: {
          replace: (file?: File, context?: { requestFileSelection?: () => void }) => {
            if (!file) context?.requestFileSelection?.()
          },
        },
        canReplace,
      })

    const refused = render(
      <GfsResourceMenu actions={fileActions(false)} resourceName="report.txt" />
    )
    expect(replaceInput().disabled).toBe(true)
    refused.unmount()

    for (const bits of ['pending', 'error'] as const) {
      const unsettled = render(
        <GfsResourceMenu
          actions={fileActions(true)}
          permissionStatus={bits}
          resourceName="report.txt"
        />
      )
      expect(replaceInput().disabled).toBe(true)
      unsettled.unmount()
    }

    const legacy = render(<GfsResourceMenu onReplace={vi.fn()} resourceName="report.txt" />)
    expect(replaceInput().disabled).toBe(false)
    legacy.unmount()

    // An enabled Replace still reaches an enabled picker: a disabled input
    // would swallow the programmatic click.
    const pickedFrom: HTMLInputElement[] = []
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement
    ) {
      pickedFrom.push(this)
    })
    const { menu } = openTriggerMenu(fileActions(true), 'report.txt')
    fireEvent.click(item(menu, 'Replace file'))
    expect(pickedFrom).toHaveLength(1)
    expect(pickedFrom[0]?.disabled).toBe(false)
  })
})
