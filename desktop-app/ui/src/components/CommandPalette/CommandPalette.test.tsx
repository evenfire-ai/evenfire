// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette } from '.'

afterEach(cleanup)

describe('CommandPalette', () => {
  it('filters commands only, navigates, executes eligible actions, and closes', () => {
    const onExecute = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandPalette
        platform="darwin"
        isEligible={id => id !== 'search.current'}
        onClose={onClose}
        onExecute={onExecute}
      />
    )
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    expect(document.activeElement).toBe(input)
    expect(screen.getByText('New chat tab')).toBeTruthy()
    expect(screen.queryByText('Search Results')).toBeNull()

    fireEvent.change(input, { target: { value: 'current content' } })
    const disabledCommand = screen.getByRole('option', { name: /Search current content/ })
    expect(disabledCommand.hasAttribute('disabled')).toBe(true)
    fireEvent.click(disabledCommand)
    expect(onExecute).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'new chat' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onExecute).toHaveBeenCalledWith('chat.newTab')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('supports click, wrapping arrows, focus trap, and focus restoration', () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    const onExecute = vi.fn()
    const { unmount } = render(
      <CommandPalette
        platform="win32"
        isEligible={() => true}
        onClose={vi.fn()}
        onExecute={onExecute}
      />
    )
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    fireEvent.keyDown(dialog, { key: 'ArrowUp' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onExecute).toHaveBeenCalled()
    expect(screen.getByText('Ctrl+K')).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /Keyboard shortcuts/ }))
    expect(onExecute).toHaveBeenLastCalledWith('settings.shortcuts')

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    input.focus()
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).not.toBe(input)
    unmount()
    return new Promise<void>(resolve =>
      requestAnimationFrame(() => {
        expect(document.activeElement).toBe(previous)
        previous.remove()
        resolve()
      })
    )
  })
})
