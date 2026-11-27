// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SingleValueEditDialog } from '..'
import type { SingleValueEditDialogProps } from '../types'

const TITLE = 'Rename conversation'
const LABEL = 'Title'
const INITIAL_VALUE = 'Pricing review'

function renderDialog(overrides: Partial<SingleValueEditDialogProps> = {}) {
  // A submit that never settles keeps every test in control of the pending state.
  const onSubmit = vi.fn<() => Promise<void>>(() => new Promise<void>(() => undefined))
  const onClose = vi.fn()
  const view = render(
    <SingleValueEditDialog
      initialValue={INITIAL_VALUE}
      label={LABEL}
      onClose={onClose}
      onSubmit={onSubmit}
      title={TITLE}
      {...overrides}
    />
  )
  return { onClose, onSubmit, ...view }
}

const dialog = () => screen.getByRole('dialog', { name: TITLE })
const input = () => screen.getByRole('textbox', { name: LABEL }) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement

function draft(value: string) {
  fireEvent.change(input(), { target: { value } })
}

describe('SingleValueEditDialog', () => {
  afterEach(cleanup)

  it('opens as a named modal with the current value selected in the labelled field', () => {
    renderDialog()

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(input().value).toBe(INITIAL_VALUE)
    expect(document.activeElement).toBe(input())
    expect(input().selectionEnd).toBe(INITIAL_VALUE.length)
  })

  it('keeps Save unavailable until the draft actually changes', () => {
    renderDialog()

    expect(saveButton().disabled).toBe(true)
    draft(`${INITIAL_VALUE}   `)
    expect(saveButton().disabled).toBe(true)
    draft('   ')
    expect(saveButton().disabled).toBe(true)
    draft('Roadmap')
    expect(saveButton().disabled).toBe(false)
  })

  it('submits the trimmed draft and closes once the save completes', async () => {
    const onSubmit = vi.fn(async () => undefined)
    const { onClose } = renderDialog({ onSubmit, submitLabel: 'Rename', cancelLabel: 'Keep' })
    draft('  Roadmap  ')

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith('Roadmap')
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy()
  })

  it('submits from the field with Enter', async () => {
    const onSubmit = vi.fn(async () => undefined)
    const { onClose } = renderDialog({ onSubmit })
    draft('Roadmap')

    fireEvent.submit(input())

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith('Roadmap')
  })

  it('keeps the draft and shows the reason when the save is rejected', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('Could not rename the conversation.')
    })
    const { onClose } = renderDialog({ onSubmit })
    draft('Roadmap')

    fireEvent.click(saveButton())
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull())

    // The banner carries its own "!" marker before the message.
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not rename the conversation.')
    expect(input().value).toBe('Roadmap')
    expect(input().getAttribute('aria-describedby')).toBe(alert.id)
    expect(saveButton().disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says something when a rejected save carries no reason', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error()
    })
    renderDialog({ onSubmit })
    draft('Roadmap')

    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not save. Please try again.')
    )
  })

  it('reports an invalid draft and withholds Save for it', () => {
    renderDialog({ validate: value => (value.length > 12 ? 'Keep it under 12 characters.' : null) })

    draft('A much longer title')
    expect(screen.getByRole('alert').textContent).toContain('Keep it under 12 characters.')
    expect(saveButton().disabled).toBe(true)

    draft('Roadmap')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it.each([
    ['Cancel', () => fireEvent.click(cancelButton())],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['the backdrop', () => fireEvent.mouseDown(dialog().parentElement!)],
  ])('%s closes without saving', (_dismiss, dismiss) => {
    const { onClose, onSubmit } = renderDialog()
    draft('Roadmap')

    dismiss()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not dismiss on a press inside the dialog', () => {
    const { onClose } = renderDialog()

    fireEvent.mouseDown(dialog())

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not submit, dismiss, or repeat while the save is pending', async () => {
    let finishSave: () => void = () => undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishSave = resolve
        })
    )
    const { onClose } = renderDialog({ onSubmit })
    draft('Roadmap')

    fireEvent.click(saveButton())
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    expect(cancelButton().disabled).toBe(true)
    expect(dialog().getAttribute('aria-busy')).toBe('true')

    fireEvent.click(saveButton())
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(dialog().parentElement!)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    finishSave()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('wraps Tab and Shift+Tab inside the dialog, skipping unavailable controls', () => {
    renderDialog()
    const save = saveButton()
    const cancel = cancelButton()

    // Unchanged draft: Save is unavailable, so it is not a stop.
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)

    // Changed draft: Save joins the cycle as the last stop.
    draft('Roadmap')
    save.focus()
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  it('returns focus to the control that opened it', () => {
    const openerButton = <button type="button">Conversation actions</button>
    const view = render(openerButton)
    const opener = screen.getByRole('button', { name: 'Conversation actions' })
    opener.focus()

    view.rerender(
      <>
        {openerButton}
        <SingleValueEditDialog
          initialValue={INITIAL_VALUE}
          label={LABEL}
          onClose={vi.fn()}
          onSubmit={vi.fn(async () => undefined)}
          title={TITLE}
        />
      </>
    )
    expect(document.activeElement).toBe(input())

    view.rerender(<>{openerButton}</>)

    expect(document.activeElement).toBe(opener)
  })
})
