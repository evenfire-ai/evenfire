// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatLocalSearch } from '@components/ChatLocalSearch'
import { CommandPalette } from '@components/CommandPalette'
import { TextInput } from './TextInput'

afterEach(cleanup)

function expectEditingEventsRemainNative(input: HTMLElement): void {
  for (const key of ['a', 'c', 'x', 'v', 'z']) {
    expect(fireEvent.keyDown(input, { key, metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key, ctrlKey: true })).toBe(true)
  }
  expect(
    fireEvent.paste(input, {
      clipboardData: { files: [], items: [], getData: () => 'pasted text' },
    })
  ).toBe(true)
}

describe('Desktop editable input contracts', () => {
  it('keeps shared text inputs available to native selection and clipboard commands', () => {
    render(<TextInput aria-label="Settings text field" defaultValue="editable" />)
    expectEditingEventsRemainNative(screen.getByRole('textbox', { name: 'Settings text field' }))
  })

  it('does not cancel editing commands in current-chat search', () => {
    render(<ChatLocalSearch models={[]} onClose={vi.fn()} onSearchStateChange={vi.fn()} />)
    expectEditingEventsRemainNative(screen.getByRole('textbox', { name: 'Find in current chat' }))
  })

  it('does not cancel editing commands in the command palette', () => {
    render(
      <CommandPalette
        platform="darwin"
        isEligible={() => true}
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    )
    expectEditingEventsRemainNative(screen.getByRole('textbox', { name: 'Search commands' }))
  })
})
