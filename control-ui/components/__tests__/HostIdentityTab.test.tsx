import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { HostIdentityTab } from '../HostIdentityTab'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getHostPersonalization: vi.fn(),
  updateHostPersonalization: vi.fn(),
}))

afterEach(() => {
  cleanup()
})

describe('HostIdentityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const findMarkdownEditor = (name: RegExp) =>
    screen.findByLabelText(name, undefined, { timeout: 10000 })

  async function expectMarkdownEditorValue(name: RegExp, value: string) {
    const editor = await findMarkdownEditor(name)
    await waitFor(() => expect(screen.getByLabelText(name)).toHaveValue(value), { timeout: 10000 })
    return editor
  }

  function renderTab() {
    return render(
      <ToastProvider>
        <HostIdentityTab hostName="foo" />
      </ToastProvider>
    )
  }

  it('renders the four section tabs and displays the editor for each section', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: 'a',
      identity: 'id',
      resourceVersion: '1',
      soul: 's',
      user: 'u',
    })
    renderTab()
    expect(await screen.findByRole('tab', { name: 'Identity' })).toBeInTheDocument()
    await expectMarkdownEditorValue(/Identity markdown/i, 'id')
    fireEvent.click(screen.getByRole('tab', { name: 'Soul' }))
    await expectMarkdownEditorValue(/Soul markdown/i, 's')
    fireEvent.click(screen.getByRole('tab', { name: 'Agent instructions' }))
    await expectMarkdownEditorValue(/Agent instructions markdown/i, 'a')
    fireEvent.click(screen.getByRole('tab', { name: 'User context' }))
    await expectMarkdownEditorValue(/User context markdown/i, 'u')
  }, 15_000)

  it('shows a loading skeleton while the initial request is pending', () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => undefined)
    )
    renderTab()
    expect(screen.getByLabelText(/loading identity files/i)).toBeInTheDocument()
  })

  it('shows the markdown editor directly for the active section', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: '',
      identity: '## Mission\n\n- Protect identity',
      resourceVersion: '1',
      soul: '',
      user: '',
    })
    renderTab()
    await expectMarkdownEditorValue(/Identity markdown/i, '## Mission\n\n- Protect identity')
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('enables Save after edit without marking valid content invalid, and calls update API', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: '',
      identity: 'old',
      resourceVersion: '1',
      soul: '',
      user: '',
    })
    ;(api.updateHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceVersion: '2',
    })
    renderTab()
    const idEl = await findMarkdownEditor(/Identity markdown/i)
    fireEvent.change(idEl, { target: { value: 'new' } })
    const saveBtn = screen.getByRole('button', { name: /save/i })
    expect(saveBtn).not.toBeDisabled()
    expect(idEl).not.toHaveClass('cu-input--invalid')

    fireEvent.click(saveBtn)
    await waitFor(() =>
      expect(api.updateHostPersonalization).toHaveBeenCalledWith('foo', {
        agents: '',
        identity: 'new',
        resourceVersion: '1',
        soul: '',
        user: '',
      })
    )
  })

  it('uses a success toast after a successful save', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: '',
      identity: 'old',
      resourceVersion: '1',
      soul: '',
      user: '',
    })
    ;(api.updateHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceVersion: '2',
    })
    renderTab()
    fireEvent.change(await findMarkdownEditor(/Identity markdown/i), {
      target: { value: 'new' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/^Identity files saved\.?$/i)).toBeInTheDocument())
  })

  it('discards pending edits across identity files', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: 'agents old',
      identity: 'identity old',
      resourceVersion: '1',
      soul: 'soul old',
      user: 'user old',
    })
    renderTab()
    const identityEditor = await findMarkdownEditor(/Identity markdown/i)
    fireEvent.change(identityEditor, { target: { value: 'identity new' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Soul' }))
    fireEvent.change(await findMarkdownEditor(/Soul markdown/i), {
      target: { value: 'soul new' },
    })

    expect(screen.getByText(/unsaved edits/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /discard/i }))

    await expectMarkdownEditorValue(/Soul markdown/i, 'soul old')
    fireEvent.click(screen.getByRole('tab', { name: 'Identity' }))
    await expectMarkdownEditorValue(/Identity markdown/i, 'identity old')
    expect(screen.getByText(/unsaved edits/i)).toHaveAttribute('data-hidden', 'true')
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('disables Save and marks the textarea invalid when the active field exceeds 64 KiB', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: '',
      identity: '',
      resourceVersion: '1',
      soul: '',
      user: '',
    })
    renderTab()
    const editor = await findMarkdownEditor(/Identity markdown/i)
    fireEvent.change(editor, {
      target: { value: 'x'.repeat(64 * 1024 + 1) },
    })
    expect(editor.closest('.cu-markdown-editor')).toHaveClass('cu-markdown-editor--invalid')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('on 409 surfaces a reload prompt and error toast', async () => {
    ;(api.getHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: '',
      identity: '',
      resourceVersion: '1',
      soul: '',
      user: '',
    })
    ;(api.updateHostPersonalization as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('HTTP 409: resourceVersion mismatch'), { status: 409 })
    )
    renderTab()
    fireEvent.change(await findMarkdownEditor(/Identity markdown/i), { target: { value: 'y' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getAllByText(/reload/i).length).toBeGreaterThan(0))
    expect(screen.getAllByText(/someone else updated these identity files/i).length).toBe(2)
  })
})
