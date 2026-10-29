// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GfsMoveConfirmDialog } from '../moveConfirmDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function request(canRename = true) {
  return {
    sourceName: 'Team folder',
    destinationName: 'Archive',
    canRename,
  }
}

describe('GfsMoveConfirmDialog — keyboard containment (RP-020)', () => {
  it('focuses the cancel action when it opens', () => {
    render(<GfsMoveConfirmDialog request={request()} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('keeps Tab inside the dialog', () => {
    // No rename option: the dialog's focusables are exactly Cancel and Move.
    render(<GfsMoveConfirmDialog request={request(false)} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Move folder Team folder to Archive' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const move = screen.getByRole('button', { name: 'Move' })

    // The last focusable control wraps back to the first one.
    move.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)

    // …and Shift+Tab from the first wraps to the last.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(move)
  })

  it('returns focus to the opener when the dialog closes', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open the tree row'
    document.body.append(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { unmount } = render(
      <GfsMoveConfirmDialog request={request()} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    expect(document.activeElement).not.toBe(opener)

    unmount()

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
