// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette } from '.'

afterEach(cleanup)

function renderPalette(onClose = vi.fn(), onExecute = vi.fn()) {
  const rendered = render(
    <CommandPalette
      platform="darwin"
      isEligible={() => true}
      onClose={onClose}
      onExecute={onExecute}
    />
  )
  return { ...rendered, onClose, onExecute }
}

describe('CommandPalette modal dismissal ownership', () => {
  it.each([
    ['input', () => screen.getByRole('textbox', { name: 'Search commands' })],
    ['result', () => screen.getByRole('option', { name: /New chat tab/ })],
    ['panel', () => screen.getByRole('dialog', { name: 'Command palette' })],
    ['modal descendant', () => screen.getByText('Open a blank chat view tab.')],
  ])('dismisses on Escape from the %s', (_label, getTarget) => {
    const { onClose } = renderPalette()
    fireEvent.keyDown(getTarget(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('dismisses on Escape from empty-result content', () => {
    const { onClose } = renderPalette()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search commands' }), {
      target: { value: 'no command has this label' },
    })
    fireEvent.keyDown(screen.getByText('No matching commands.'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('dismisses only true backdrop pointer clicks', () => {
    const { container, onClose, onExecute } = renderPalette()
    const backdrop = container.querySelector('.command-palette-backdrop') as HTMLElement
    const panel = screen.getByRole('dialog', { name: 'Command palette' })
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    const result = screen.getByRole('option', { name: /New chat tab/ })
    const shortcut = screen.getByText('⌘T')

    fireEvent.mouseDown(panel)
    fireEvent.mouseDown(input)
    fireEvent.click(shortcut)
    expect(onClose).not.toHaveBeenCalled()
    expect(onExecute).toHaveBeenCalledOnce()
    expect(onExecute).toHaveBeenLastCalledWith('chat.newTab')
    onExecute.mockClear()

    fireEvent.click(result)
    expect(onExecute).toHaveBeenCalledWith('chat.newTab')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('restores prior focus after backdrop dismissal', async () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()

    function Owner() {
      const [open, setOpen] = useState(true)
      return open ? (
        <CommandPalette
          platform="darwin"
          isEligible={() => true}
          onClose={() => setOpen(false)}
          onExecute={vi.fn()}
        />
      ) : null
    }

    const { container } = render(<Owner />)
    fireEvent.mouseDown(container.querySelector('.command-palette-backdrop') as HTMLElement)
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => {
        expect(document.activeElement).toBe(previous)
        resolve()
      })
    )
    previous.remove()
  })
})
