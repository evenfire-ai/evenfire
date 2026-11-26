import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HoverTooltip } from '../HoverTooltip'

afterEach(() => vi.restoreAllMocks())

describe('HoverTooltip review regressions', () => {
  it('clamps vertically when neither side of the trigger has enough space', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
    render(<HoverTooltip label="Type" tooltip="Lifecycle explanation" />)
    const trigger = screen.getByText('Type')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 85,
      bottom: 105,
      left: 100,
      right: 140,
      width: 40,
      height: 20,
      x: 100,
      y: 85,
      toJSON: () => ({}),
    })
    fireEvent.mouseEnter(trigger)
    const card = screen.getByRole('tooltip')
    fireEvent.scroll(card)
    expect(card).toBeVisible()
    expect(card).toHaveStyle({ top: '92px' })
    expect(parseFloat(card.style.top) + card.offsetHeight).toBeLessThanOrEqual(192)
  })
})
