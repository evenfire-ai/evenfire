// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GfsResourceMenu } from './index'

describe('GfsResourceMenu', () => {
  afterEach(() => {
    cleanup()
  })

  it('uses a vertical kebab and presents a compact menu panel', () => {
    render(
      <GfsResourceMenu
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
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

    const menu = screen.getByRole('menu')
    expect(menu.tagName).toBe('DIV')
    expect(menu.classList.contains('da-gfs-resource-menu__panel')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Preview' })).toBeTruthy()
  })
})
