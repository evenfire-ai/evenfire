// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MarkdownDraftOwner } from '@lib/markdownDraftOwner'
import { MarkdownEditorSurface } from './MarkdownEditorSurface'

vi.mock('./MarkdownAdapter', () => ({
  GfsMarkdownEditor: ({
    ariaLabel,
    onChange,
    value,
  }: {
    ariaLabel: string
    onChange: (value: string) => void
    value: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      onChange={event => onChange(event.currentTarget.value)}
      value={value}
    />
  ),
}))

describe('MarkdownEditorSurface', () => {
  it('shows and copies an exact local draft without a resource read', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <MarkdownEditorSurface
        binding={null}
        fileName="private.md"
        mode="recover"
        owner={undefined}
        value="# Unsaved local content"
      />
    )

    expect(screen.getByLabelText('Unsaved Markdown draft content').textContent).toBe(
      '# Unsaved local content'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy unsaved draft' }))
    expect(writeText).toHaveBeenCalledWith('# Unsaved local content')
    expect(await screen.findByText('Unsaved Markdown draft copied.')).toBeTruthy()
  })
})
