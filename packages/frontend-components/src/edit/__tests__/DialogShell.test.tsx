import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { DialogShell } from '../DialogShell'

afterEach(cleanup)

describe('DialogShell', () => {
  it('labels the dialog, associates its description and error, and focuses inside on open', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">Open</button>
        <DialogShell
          description="Short explanatory text"
          error="Correct the required field"
          onDismiss={vi.fn()}
          open
          title="Edit item"
        >
          <label>
            Name <input />
          </label>
        </DialogShell>
      </>
    )

    const dialog = await screen.findByRole('dialog', { name: 'Edit item' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Short explanatory text Correct the required field')
    expect(screen.getByRole('alert')).toHaveTextContent('Correct the required field')
    await waitFor(() => expect(within(dialog).getByLabelText('Name')).toHaveFocus())
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toHaveFocus()
  })

  it('contains forward and reverse tab movement and returns focus to the opener', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    function OpenDialog() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open
          </button>
          <DialogShell
            onDismiss={reason => {
              onDismiss(reason)
              setOpen(false)
            }}
            open={open}
            title="Choose"
          >
            <button type="button">First</button>
            <button type="button">Last</button>
          </DialogShell>
        </>
      )
    }
    render(<OpenDialog />)
    const opener = screen.getByRole('button', { name: 'Open' })
    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Choose' })
    const first = within(dialog).getByRole('button', { name: 'First' })
    const last = within(dialog).getByRole('button', { name: 'Last' })
    const close = within(dialog).getByRole('button', { name: 'Close dialog' })
    await waitFor(() => expect(first).toHaveFocus())

    last.focus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(last).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledWith('escape')
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('supports configured dismissal paths and blocks them while busy by default', async () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <DialogShell busy onDismiss={onDismiss} open title="Saving">
        <button type="button">Continue</button>
      </DialogShell>
    )
    const dialog = await screen.findByRole('dialog', { name: 'Saving' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'))
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    expect(onDismiss).not.toHaveBeenCalled()

    rerender(
      <DialogShell onDismiss={onDismiss} open title="Saving" dismissOnEscape={false}>
        <button type="button">Continue</button>
      </DialogShell>
    )
    const nextDialog = screen.getByRole('dialog', { name: 'Saving' })
    fireEvent.keyDown(nextDialog, { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'))
    expect(onDismiss).toHaveBeenCalledWith('backdrop')
  })

  it('routes the explicit close control through the close-button dismissal reason', async () => {
    const onDismiss = vi.fn()
    render(
      <DialogShell onDismiss={onDismiss} open title="Closeable">
        <button type="button">Continue</button>
      </DialogShell>
    )
    const dialog = await screen.findByRole('dialog', { name: 'Closeable' })
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    expect(onDismiss).toHaveBeenCalledWith('close-button')
  })

  it('uses unique accessible IDs and supports the large layout', async () => {
    render(
      <>
        <DialogShell onDismiss={vi.fn()} open size="large" title="First dialog" />
        <DialogShell onDismiss={vi.fn()} open size="large" title="Second dialog" />
      </>
    )
    const first = await screen.findByRole('dialog', { name: 'First dialog' })
    const second = screen.getByRole('dialog', { name: 'Second dialog' })
    expect(first).toHaveClass('eft-dialog--large')
    expect(second).toHaveClass('eft-dialog--large')
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'))
  })
})

describe('ConfirmationDialog', () => {
  it.each(['info', 'warning', 'error', 'success'] as const)(
    'exposes the %s tone and orders cancel, optional secondary, then primary actions',
    async tone => {
      const user = userEvent.setup()
      const onCancel = vi.fn()
      const onSecondary = vi.fn()
      const onConfirm = vi.fn()
      render(
        <ConfirmationDialog
          confirmLabel="Apply"
          onCancel={onCancel}
          onConfirm={onConfirm}
          open
          secondaryAction={{ label: 'Review', onSelect: onSecondary }}
          title="Apply changes"
          tone={tone}
        />
      )
      const dialog = await screen.findByRole('alertdialog', { name: 'Apply changes' })
      expect(dialog.querySelector('[data-tone]')).toHaveAttribute('data-tone', tone)
      const buttons = within(dialog)
        .getAllByRole('button')
        .map(button => button.textContent?.trim())
      expect(buttons).toEqual(['×', 'Cancel', 'Review', 'Apply'])
      await user.click(within(dialog).getByRole('button', { name: 'Review' }))
      await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
      expect(onSecondary).toHaveBeenCalledOnce()
      expect(onConfirm).toHaveBeenCalledOnce()
    }
  )

  it('disables actions while pending and routes dismiss through cancel', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmationDialog
        onCancel={onCancel}
        onConfirm={onConfirm}
        open
        pending
        title="Remove access"
      />
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove access' })
    expect(within(dialog).getByRole('button', { name: 'Working…' })).toBeDisabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
