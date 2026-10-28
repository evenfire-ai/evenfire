// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPalette } from '.'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'

const scrollIntoView = vi.fn()

beforeEach(installAntdDomEnvironment)
afterEach(() => {
  vi.restoreAllMocks()
  scrollIntoView.mockReset()
})

describe('CommandPalette arrow navigation', () => {
  it('scrolls each newly selected command into the visible list area', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    render(
      <CommandPalette
        platform="darwin"
        isEligible={() => true}
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    await waitFor(() =>
      expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    )
    scrollIntoView.mockClear()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    })

    scrollIntoView.mockClear()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    })
  })
})
