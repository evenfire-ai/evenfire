// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GfsResourceMenu } from '../GfsResourceMenu'

describe('GfsResourceMenu', () => {
  afterEach(() => {
    cleanup()
  })

  it('presents the Share action in an icon-led, grouped menu', () => {
    render(
      <GfsResourceMenu
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
        onDownload={vi.fn()}
        onManage={vi.fn()}
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

    const menu = screen.getByRole('menu')
    expect(menu.classList.contains('cu-gfs-resource-menu__menu')).toBe(true)
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(3)
    expect(menu.querySelectorAll('.cu-gfs-resource-menu__icon')).toHaveLength(7)
    expect(screen.getByRole('menuitem', { name: 'Share' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Manage access' })).toBeNull()
  })
})
