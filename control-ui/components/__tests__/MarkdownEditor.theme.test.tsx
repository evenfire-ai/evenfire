import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownEditor } from '../MarkdownEditor'
import { ThemeProvider, useTheme } from '../ThemeContext'

vi.mock('next/dynamic', () => ({
  default: () =>
    function MockMarkdownEditor({
      onChange,
      textareaProps,
      value,
    }: {
      onChange?: (value: string) => void
      textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>
      value?: string
    }) {
      return React.createElement('textarea', {
        ...textareaProps,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange?.(event.currentTarget.value),
        value,
      })
    },
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function ThemeControls() {
  const { setThemeMode } = useTheme()

  return (
    <>
      <button onClick={() => setThemeMode('light')} type="button">
        Use light theme
      </button>
      <button onClick={() => setThemeMode('dark')} type="button">
        Use dark theme
      </button>
    </>
  )
}

function EditorHarness() {
  const [value, setValue] = React.useState('# Preserve this draft')

  return <MarkdownEditor ariaLabel="Identity markdown" onChange={setValue} value={value} />
}

function renderEditor(themeMode: 'dark' | 'light' = 'dark') {
  window.localStorage.setItem('clerum.control-ui.theme', themeMode)

  return render(
    <ThemeProvider>
      <EditorHarness />
      <ThemeControls />
    </ThemeProvider>
  )
}

describe('MarkdownEditor theme', () => {
  it.each(['light', 'dark'] as const)('uses the active %s editor palette', async themeMode => {
    renderEditor(themeMode)

    const editor = await screen.findByRole('textbox', { name: 'Identity markdown' })
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', themeMode)
      expect(editor.closest('.cu-markdown-editor')).toHaveAttribute('data-color-mode', themeMode)
    })
    expect(editor).toHaveValue('# Preserve this draft')
  })

  it('updates the editor palette when the active theme changes', async () => {
    renderEditor('dark')
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: 'Identity markdown' })
    const markdownEditor = editor.closest('.cu-markdown-editor')

    await waitFor(() => expect(markdownEditor).toHaveAttribute('data-color-mode', 'dark'))
    await user.clear(editor)
    await user.type(editor, 'Unsaved changes')
    expect(editor).toHaveValue('Unsaved changes')

    await user.click(screen.getByRole('button', { name: 'Use light theme' }))
    await waitFor(() => expect(markdownEditor).toHaveAttribute('data-color-mode', 'light'))
    expect(editor).toHaveValue('Unsaved changes')

    await user.click(screen.getByRole('button', { name: 'Use dark theme' }))
    await waitFor(() => expect(markdownEditor).toHaveAttribute('data-color-mode', 'dark'))
    expect(editor).toHaveValue('Unsaved changes')
  })
})
