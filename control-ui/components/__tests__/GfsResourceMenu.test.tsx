// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsResourceMenu } from '../GfsResourceMenu'

describe('GfsResourceMenu', () => {
  afterEach(() => {
    cleanup()
  })

  it('presents the Share action in an icon-led, grouped menu', () => {
    const onManage = vi.fn()
    render(
      <GfsResourceMenu
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
        onDownload={vi.fn()}
        onManage={onManage}
        onPreview={vi.fn()}
        onRename={vi.fn()}
        onReplace={vi.fn()}
        resourceName="report.txt"
        resourceUri="gfs://main/report.txt"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Actions for report.txt' })
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
    expect(menu.classList.contains('cu-gfs-resource-menu__menu')).toBe(true)
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(3)
    expect(menu.querySelectorAll('.cu-gfs-resource-menu__icon')).toHaveLength(6)
    const shareItem = within(menu).getByRole('menuitem', { name: 'Share' })
    expect(shareItem.getAttribute('aria-haspopup')).toBe('menu')
    expect(shareItem.getAttribute('aria-expanded')).toBe('false')
    expect(
      menu
        .querySelector('[data-gfs-action="share"] .cu-gfs-resource-menu__icon path')
        ?.getAttribute('d')
    ).toBe('M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0')
    expect(within(menu).queryByRole('menuitem', { name: 'Copy link' })).toBeNull()

    fireEvent.click(shareItem)
    const shareMenu = screen.getByRole('menu', { name: 'Share options for report.txt' })
    expect(shareItem.getAttribute('aria-expanded')).toBe('true')
    expect(within(shareMenu).getByRole('menuitem', { name: 'Share' })).toBeTruthy()
    expect(within(shareMenu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    expect(within(shareMenu).queryByRole('menuitem', { name: 'Manage access' })).toBeNull()
    expect(
      shareMenu
        .querySelector('[data-gfs-action="share-access"] .cu-gfs-resource-menu__icon path')
        ?.getAttribute('d')
    ).toBe('M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0')
    fireEvent.mouseEnter(within(menu).getByRole('menuitem', { name: 'Preview' }))
    expect(screen.getByRole('menu', { name: 'Share options for report.txt' })).toBeTruthy()
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
    expect(onManage).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Actions for report.txt' })).toBeNull()
  })
})
