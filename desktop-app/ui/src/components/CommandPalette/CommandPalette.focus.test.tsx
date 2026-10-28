// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { CommandPalette } from '.'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'

beforeEach(installAntdDomEnvironment)
afterEach(cleanup)

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

    focusThief.focus()
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(input))

    focusThief.remove()
  })
})
