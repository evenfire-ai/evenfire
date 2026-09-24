import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SelectionDropdown } from '../SelectionDropdown'

describe('SelectionDropdown portal menu', () => {
  it('renders outside overflow ancestors and keeps selection interactive', () => {
    const onChange = vi.fn()
    render(
      <div data-testid="overflow-parent" style={{ overflow: 'auto' }}>
        <SelectionDropdown
          ariaLabel="Access role"
          multiple={false}
          onChange={onChange}
          options={[
            { label: 'Read', value: 'read' },
            { label: 'Editor', value: 'editor' },
          ]}
          placeholder="Role"
          portal
          searchable={false}
          value={['read']}
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

    const listbox = screen.getByRole('listbox')
    const menu = listbox.parentElement
    expect(menu?.parentElement).toBe(document.body)
    expect(menu).toHaveClass('cu-selection-dropdown__menu--portal')
    expect(menu).toHaveStyle({ left: '200px', width: '112px' })

    const editor = screen.getByRole('option', { name: 'Editor' })
    fireEvent.mouseDown(editor)
    fireEvent.click(editor)
    expect(onChange).toHaveBeenCalledWith(['editor'])
  })
})
