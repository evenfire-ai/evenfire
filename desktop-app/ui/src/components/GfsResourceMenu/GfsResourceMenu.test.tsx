// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsResourceMenu } from './index'

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

describe('GfsResourceMenu', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses a vertical kebab and presents an icon-led menu panel', () => {
    const onManage = vi.fn()
    render(
      <GfsResourceMenu
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
        onManage={onManage}
        onPreview={vi.fn()}
        onReplace={vi.fn()}
        resourceName="report.txt"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Options for report.txt' })
    const dotPositions = Array.from(trigger.querySelectorAll('circle')).map(circle => [
      circle.getAttribute('cx'),
      circle.getAttribute('cy'),
    ])
    expect(dotPositions).toEqual([
      ['12', '5'],
      ['12', '12'],
      ['12', '19'],
    ])

    fireEvent.click(trigger)

    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    expect(menu.tagName).toBe('DIV')
    expect(menu.classList.contains('da-gfs-resource-menu__panel')).toBe(true)
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2)
    expect(menu.querySelectorAll('.ui-menu-item__icon')).toHaveLength(4)
    const shareItem = within(menu).getByRole('menuitem', { name: 'Share' })
    expect(shareItem.getAttribute('aria-haspopup')).toBe('menu')
    expect(shareItem.getAttribute('aria-expanded')).toBe('false')
    expect(
      menu.querySelector('[data-gfs-action="share"] .ui-menu-item__icon path')?.getAttribute('d')
    ).toBe('M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0')
    expect(within(menu).queryByRole('menuitem', { name: 'Copy link' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Preview' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Replace file' })).toBeTruthy()

    fireEvent.click(shareItem)
    const shareMenu = screen.getByRole('menu', { name: 'Share options for report.txt' })
    expect(shareItem.getAttribute('aria-expanded')).toBe('true')
    expect(within(shareMenu).getByRole('menuitem', { name: 'Share' })).toBeTruthy()
    expect(within(shareMenu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    expect(within(shareMenu).queryByRole('menuitem', { name: 'Manage access' })).toBeNull()
    expect(
      shareMenu
        .querySelector('[data-gfs-action="share-access"] .ui-menu-item__icon path')
        ?.getAttribute('d')
    ).toBe('M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0')
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
    expect(onManage).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Actions for report.txt' })).toBeNull()
  })

  it.each(['Shared with me', 'Marketing'])(
    'keeps the %s breadcrumb menu inside the Files surface as the sidebar resizes',
    resourceName => {
      let sidebarExpanded = true
      const resizeCallbacks: ResizeObserverCallback[] = []

      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(918)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        if (this.classList.contains('da-gfs-drive')) {
          const left = sidebarExpanded ? 304 : 74
          return rect(left, 0, 918 - left, 700)
        }
        if (this.classList.contains('da-gfs-resource-menu__panel')) {
          return rect(0, 0, 360, 260)
        }
        if (this.getAttribute('aria-label') === `Options for ${resourceName}`) {
          const left = sidebarExpanded ? 526 : 296
          return rect(left, 100, 32, 32)
        }
        return rect(0, 0, 0, 0)
      })

      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }

        disconnect() {}
        observe() {}
        unobserve() {}
      }
      vi.stubGlobal('ResizeObserver', ResizeObserverMock)

      render(
        <section className="da-gfs-drive">
          <GfsResourceMenu resourceName={resourceName} onOpenGfsLink={vi.fn()} />
        </section>
      )

      fireEvent.click(screen.getByRole('button', { name: `Options for ${resourceName}` }))
      const menu = screen.getByRole('menu', { name: `Actions for ${resourceName}` })

      // Right alignment would start at 198px and disappear beneath the 304px
      // sidebar. The Files boundary clamps the whole panel to visible content.
      expect(menu.style.left).toBe('304px')

      sidebarExpanded = false
      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })
      expect(menu.style.left).toBe('74px')
    }
  )
})
