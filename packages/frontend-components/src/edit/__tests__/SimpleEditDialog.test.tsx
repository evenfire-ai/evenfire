import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimpleEditDialog } from '../SimpleEditDialog'

afterEach(cleanup)

describe('SimpleEditDialog', () => {
  it('keeps form validity, dirty state, and pending state at the action boundary', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <SimpleEditDialog
        isDirty={false}
        isValid
        onCancel={onCancel}
        onSave={onSave}
        open
        title="Edit profile"
      >
        <label>
          Name
          <input defaultValue="Ada" />
        </label>
      </SimpleEditDialog>
    )
    const dialog = await screen.findByRole('dialog', { name: 'Edit profile' })
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    rerender(
      <SimpleEditDialog
        isDirty
        isValid
        pending
        onCancel={onCancel}
        onSave={onSave}
        open
        title="Edit profile"
      >
        <label>
          Name
          <input defaultValue="Ada" />
        </label>
      </SimpleEditDialog>
    )
    expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('supports keyboard-only submission from the bounded form', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <SimpleEditDialog isDirty isValid onCancel={vi.fn()} onSave={onSave} open title="Add label">
        <label>
          Label
          <input defaultValue="Platform" />
        </label>
      </SimpleEditDialog>
    )
    const input = await screen.findByLabelText('Label')
    input.focus()
    await user.keyboard('{Enter}')
    expect(onSave).toHaveBeenCalledOnce()
  })
})
