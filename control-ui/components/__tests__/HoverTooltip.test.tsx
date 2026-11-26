import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HoverTooltip } from '../HoverTooltip'

afterEach(() => vi.restoreAllMocks())

describe('HoverTooltip review regressions', () => {
  it('keeps Escape dismissal while a focused trigger loses pointer hover', async () => {
    const user = userEvent.setup()
    render(<HoverTooltip label="Type" tooltip="Lifecycle explanation" />)
    const trigger = screen.getByText('Type')
    await user.tab()
    await user.hover(trigger)
    expect(screen.getByRole('tooltip')).toBeVisible()
    await user.keyboard('{Escape}')
    await user.unhover(trigger)
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    await user.hover(trigger)
    expect(screen.getByRole('tooltip')).toBeVisible()
  })

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

  it('dismisses hover-only content with keyboard input while focus stays elsewhere', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <button>Other control</button>
        <HoverTooltip label="Type" tooltip="Lifecycle explanation" />
      </div>
    )
    const other = screen.getByRole('button', { name: 'Other control' })
    await user.click(other)
    await user.hover(screen.getByText('Type'))
    expect(screen.getByRole('tooltip')).toBeVisible()
    expect(other).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(other).toHaveFocus()
    // Removing an overlapping card can expose the trigger to the stationary pointer.
    fireEvent.mouseEnter(screen.getByText('Type'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Escape', defaultPrevented: false })
    )
  })
})
