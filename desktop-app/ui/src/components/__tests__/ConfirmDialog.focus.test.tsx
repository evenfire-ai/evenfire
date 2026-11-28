// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialog } from '../ConfirmDialog'

afterEach(cleanup)

it('contains focus including pending mutations, rejects duplicate clicks, and restores its opener', async () => {
  let complete!: () => void
  const pending = new Promise<void>(resolve => {
    complete = resolve
  })
  const mutation = vi.fn(() => pending)
  function Harness() {
    const [open, setOpen] = useState(false)
    const opener = useRef<HTMLButtonElement | null>(null)
    return (
      <>
        <button ref={opener} onClick={() => setOpen(true)}>
          Open
        </button>
        <button>Outside</button>
        {open && (
          <ConfirmDialog
            title="Delete?"
            body="Cannot recover."
            returnFocusTo={opener.current}
            onCancel={() => setOpen(false)}
            onConfirm={async () => {
              await mutation()
              setOpen(false)
            }}
          />
        )}
      </>
    )
  }
  render(<Harness />)
  const opener = screen.getByRole('button', { name: 'Open' })
  fireEvent.click(opener)
  const dialog = screen.getByRole('dialog')
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  const confirm = screen.getByRole('button', { name: 'Confirm' })
  expect(document.activeElement).toBe(cancel)
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(confirm)
  fireEvent.keyDown(confirm, { key: 'Tab' })
  expect(document.activeElement).toBe(cancel)
  screen.getByRole('button', { name: 'Outside' }).focus()
  expect(dialog.contains(document.activeElement)).toBe(true)
  fireEvent.click(confirm)
  expect(dialog.getAttribute('aria-busy')).toBe('true')
  fireEvent.keyDown(dialog, { key: 'Tab' })
  expect(dialog.contains(document.activeElement)).toBe(true)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  fireEvent.click(confirm)
  expect(mutation).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).toBe(dialog)
  complete()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(opener)
})

it('restores focus within the surviving region when deletion removes the opener', async () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    const [deleted, setDeleted] = useState(false)
    const opener = useRef<HTMLButtonElement | null>(null)
    const region = useRef<HTMLDivElement | null>(null)
    return (
      <div ref={region}>
        {!deleted && (
          <button ref={opener} onClick={() => setOpen(true)}>
            Delete item
          </button>
        )}
        <button>Surviving conversation</button>
        {open && (
          <ConfirmDialog
            title="Delete?"
            body="Cannot recover."
            returnFocusTo={opener.current}
            fallbackFocusWithin={region.current}
            onCancel={() => setOpen(false)}
            onConfirm={async () => {
              setDeleted(true)
              setOpen(false)
            }}
          />
        )}
      </div>
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete item' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Surviving conversation' })
  )
})
