// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
