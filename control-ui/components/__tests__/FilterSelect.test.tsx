import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FilterSelect } from '../FilterSelect'

const options = [
  { value: 'all', label: 'All providers' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
]

describe('FilterSelect keyboard interaction', () => {
  it('uses roving focus for Arrow, Home, and End keys, then restores the trigger on Escape', () => {
    render(
      <FilterSelect
        ariaLabel="Filter by provider"
        onChange={vi.fn()}
        options={options}
        value="anthropic"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Filter by provider' })
    fireEvent.click(trigger)
    const selectedOption = screen.getByRole('option', { name: 'Anthropic' })
    expect(selectedOption).toHaveFocus()

    fireEvent.keyDown(selectedOption, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'OpenAI' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: 'OpenAI' }), { key: 'Home' })
    expect(screen.getByRole('option', { name: 'All providers' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: 'All providers' }), { key: 'End' })
    expect(screen.getByRole('option', { name: 'OpenAI' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('option', { name: 'OpenAI' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Filter by provider' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('selects the active option with Enter and returns focus to the trigger', () => {
    const onChange = vi.fn()
    render(
      <FilterSelect
        ariaLabel="Filter by provider"
        onChange={onChange}
        options={options}
        value="all"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Filter by provider' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('option', { name: 'All providers' }), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('option', { name: 'Anthropic' }), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('anthropic')
    expect(screen.queryByRole('listbox', { name: 'Filter by provider' })).toBeNull()
    expect(trigger).toHaveFocus()
  })
})
