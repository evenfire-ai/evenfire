import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SingleValueEditDialog } from '../SingleValueEditDialog'

afterEach(cleanup)

describe('SingleValueEditDialog', () => {
  it('keeps one value atomic, disables unchanged/invalid saves, and saves the edited value', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onDismiss = vi.fn()
    function Harness() {
      const [value, setValue] = useState('original')
      return (
        <SingleValueEditDialog
          initialValue="original"
          isValid={value.length > 2}
          onDismiss={onDismiss}
          onSave={onSave}
          open
          renderEditor={({ value: draft, onChange, disabled }) => (
            <label>
              Value
              <input
                disabled={disabled}
                onChange={event => {
                  onChange(event.currentTarget.value)
                  setValue(event.currentTarget.value)
                }}
                value={draft}
              />
            </label>
          )}
          title="Edit value"
        />
      )
    }
    render(<Harness />)
    const dialog = await screen.findByRole('dialog', { name: 'Edit value' })
    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    const input = within(dialog).getByLabelText('Value')
    await user.clear(input)
    await user.type(input, 'x')
    expect(save).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'changed')
    expect(save).toBeEnabled()
    await user.type(input, '{Enter}')
    expect(onSave).toHaveBeenCalledWith('changed')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('discards the local draft through the cancel callback', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <SingleValueEditDialog
        initialValue={4}
        onDismiss={onDismiss}
        onSave={vi.fn()}
        open
        renderEditor={({ value }) => <output>{value}</output>}
        title="Edit count"
      />
    )
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDismiss).toHaveBeenCalledWith('cancel')
  })
})
