// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CommandPalette } from '.'

afterEach(cleanup)

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

describe('CommandPalette focus ownership', () => {
  it('reclaims focus once when native focus settles after the palette commits', async () => {
    const focusThief = document.createElement('button')
    document.body.append(focusThief)

    render(
      <CommandPalette
        platform="darwin"
        isEligible={() => true}
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    expect(document.activeElement).toBe(input)

    focusThief.focus()
    expect(document.activeElement).toBe(focusThief)

    await nextAnimationFrame()
    expect(document.activeElement).toBe(input)

    focusThief.remove()
  })
})
