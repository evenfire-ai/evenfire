// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DropdownSelect } from '..'

const OPTIONS = [
  { label: 'Alpha', value: 'alpha' },
  { label: 'Beta', value: 'beta' },
  { label: 'Gamma', value: 'gamma' },
]

function renderDropdown(onChange = vi.fn()) {
  render(
    <DropdownSelect
      ariaLabel="Resource subject"
      onChange={onChange}
      options={OPTIONS}
      placeholder="Choose a subject"
      value=""
    />
  )
  return onChange
}

describe('DropdownSelect', () => {
  afterEach(cleanup)

  it('supports open, roving keyboard focus, Escape, Home, and End', async () => {
    renderDropdown()
    const trigger = screen.getByRole('button', { name: 'Resource subject' })

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const alpha = await screen.findByRole('option', { name: 'Alpha' })
    await waitFor(() => expect(document.activeElement).toBe(alpha))
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Beta' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Gamma' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('selects an option and closes when clicking outside', async () => {
    const onChange = renderDropdown()
    const trigger = screen.getByRole('button', { name: 'Resource subject' })

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'Beta' }))
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(trigger)
    await screen.findByRole('listbox')
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('can portal its menu outside an overflow ancestor', async () => {
    const onChange = vi.fn()
    render(
      <div style={{ overflow: 'auto' }}>
        <DropdownSelect
          ariaLabel="Access role"
          className="access-role"
          onChange={onChange}
          options={OPTIONS}
          placeholder="Choose a role"
          portal
          value="alpha"
        />
      </div>
    )
    const trigger = screen.getByRole('button', { name: 'Access role' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      bottom: 140,
      height: 32,
      left: 200,
      right: 312,
      top: 108,
      width: 112,
      x: 200,
      y: 108,
      toJSON: () => undefined,
    })
    fireEvent.click(trigger)

    const menu = await screen.findByRole('listbox', { name: 'Access role' })
    expect(menu.parentElement).toBe(document.body)
    expect(menu.classList.contains('ui-dropdown-select__menu--portal')).toBe(true)
    expect(menu.style.left).toBe('200px')
    expect(menu.style.width).toBe('112px')
    expect(trigger.closest('.ui-dropdown-select')?.classList.contains('access-role')).toBe(true)

    const beta = screen.getByRole('option', { name: 'Beta' })
    fireEvent.mouseDown(beta)
    fireEvent.click(beta)
    expect(onChange).toHaveBeenCalledWith('beta')
  })
})
