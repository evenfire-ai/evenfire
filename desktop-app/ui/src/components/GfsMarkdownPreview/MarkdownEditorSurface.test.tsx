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
  it('blocks actual editor input while close authorization is pending', () => {
    const onChange = vi.fn()
    const owner = new MarkdownDraftOwner()
    const binding = {
      principalOwner: 'principal-a',
      scopeKey: 'user-a:main',
      tabId: 'draft-tab',
      gfsUri: 'gfs://main/draft',
    }
    owner.open(binding, { sessionGeneration: 1 })
    const read = owner.beginStableRead(binding)!
    owner.completeStableRead(read, { content: '# saved', version: 1, stable: true })
    const capability = owner.beginCapabilityRefresh(binding)!
    owner.completeCapabilityRefresh(capability, true)
    owner.beginEdit(binding)
    owner.type(binding, '# retained')
    owner.requestClose(binding.tabId)
    owner.resolveClose(binding.tabId, 'discard')
    render(
      <MarkdownEditorSurface
        binding={binding}
        fileName="draft.md"
        mode="edit"
        owner={owner}
        onChange={onChange}
        value="# retained"
      />
    )

    const editor = screen.getByRole('textbox', { name: 'Edit Markdown source for draft.md' })
    expect(editor.closest('[inert]')).not.toBeNull()
    fireEvent.change(editor, { target: { value: '# silently dropped' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Editing is paused')
    expect(owner.get(binding)?.draft).toBe('# retained')
    owner.quit()
  })

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
