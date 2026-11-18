// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GfsNameDialog } from '../nameDialog'

function renderDialog(props: Partial<Parameters<typeof GfsNameDialog>[0]> = {}) {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const view = render(
    <GfsNameDialog
      busy={false}
      description="Rename notes.txt."
      fieldLabel="Name"
      formLabel="Rename resource"
      submitLabel="Save"
      title="Rename"
      initialValue="notes.txt"
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...props}
    />
  )
  return { ...view, onSubmit, onCancel }
}

afterEach(cleanup)

describe('GfsNameDialog', () => {
  it('keeps Save disabled until the name actually changes', () => {
    const { onSubmit } = renderDialog()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(save.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '  notes.txt  ' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(save.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'renamed.txt' } })
    expect(save.disabled).toBe(false)
    fireEvent.submit(screen.getByRole('form', { name: 'Rename resource' }))
    expect(onSubmit).toHaveBeenCalledWith('renamed.txt')
  })

  it('takes its in-flight state from the caller and cannot be dismissed while busy', () => {
    const { onCancel, rerender } = renderDialog({ busy: true })
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(input.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(screen.getByRole('presentation'))
    expect(onCancel).not.toHaveBeenCalled()

    rerender(
      <GfsNameDialog
        busy={false}
        description="Rename notes.txt."
        fieldLabel="Name"
        formLabel="Rename resource"
        submitLabel="Save"
        title="Rename"
        initialValue="notes.txt"
        onCancel={onCancel}
        onSubmit={vi.fn()}
      />
    )
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).disabled).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
