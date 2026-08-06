import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SelectionDropdown } from '../SelectionDropdown'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SelectionDropdown', () => {
  it('renders its menu outside overflow containers and keeps option clicks active', () => {
    const onChange = vi.fn()
    const { container } = render(
      <div data-testid="overflow-container">
        <SelectionDropdown
          id="contexts"
          options={[{ value: 'context-1', label: 'Context 1' }]}
          value={[]}
          onChange={onChange}
          placeholder="Select contexts"
        />
      </div>
    )

    const trigger = screen.getByRole('button', { name: 'Select contexts' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      bottom: 144,
      height: 44,
      left: 120,
      right: 320,
      top: 100,
      width: 200,
      x: 120,
      y: 100,
      toJSON: () => ({}),
    })
    fireEvent.click(trigger)

    const option = screen.getByRole('option', { name: 'Context 1' })
    const menu = option.closest('.cu-selection-dropdown__menu')
    expect(menu).not.toBeNull()
    expect(container.contains(menu)).toBe(false)
    expect(menu).toHaveStyle({ left: '120px', top: '148px', width: '200px' })

    fireEvent.mouseDown(option)
    fireEvent.click(option)
    expect(onChange).toHaveBeenCalledWith(['context-1'])
  })

  it('restores focus to the trigger after Escape closes the menu', async () => {
    render(
      <SelectionDropdown
        id="agents"
        options={[{ value: 'agent-1', label: 'Agent 1' }]}
        value={[]}
        onChange={() => undefined}
        placeholder="Select agents"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Select agents' })
    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Agent 1' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('restores focus to the trigger after an outside click closes the menu', async () => {
    render(
      <div>
        <SelectionDropdown
          id="contexts"
          options={[{ value: 'context-1', label: 'Context 1' }]}
          value={[]}
          onChange={() => undefined}
          placeholder="Select contexts"
        />
        <button type="button">Outside action</button>
      </div>
    )

    const trigger = screen.getByRole('button', { name: 'Select contexts' })
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside action' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
