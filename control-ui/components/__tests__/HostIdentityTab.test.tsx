import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as api from '../../lib/api'
import { HostIdentityTab } from '../HostIdentityTab'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getHostPersonalization: vi.fn(),
  updateHostPersonalization: vi.fn(),
}))

afterEach(cleanup)

const initialFiles = {
  agents: '## Agent instructions',
  identity: '## Mission\n\nProtect identity.',
  resourceVersion: '1',
  soul: '## Values',
  user: '## User context',
}

describe('HostIdentityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getHostPersonalization).mockResolvedValue(initialFiles)
  })

  function renderTab(onActionsChange?: (actions: React.ReactNode | null) => void) {
    return render(
      <ToastProvider>
        <HostIdentityTab hostName="foo" onActionsChange={onActionsChange} />
      </ToastProvider>
    )
  }

  async function openIdentityEditor() {
    await screen.findByRole('article', { name: 'Rendered Identity document' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit IDENTITY.md' })
    await within(dialog).findByLabelText('Identity markdown', undefined, { timeout: 10000 })
    return dialog
  }

  it('renders each document as read content with an Edit action beside its title', async () => {
    renderTab()

    const identity = await screen.findByRole('article', { name: 'Rendered Identity document' })
    await waitFor(() => expect(identity).toHaveTextContent('Mission'), { timeout: 10000 })
    expect(screen.getByRole('heading', { name: 'IDENTITY.md' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Identity markdown')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Soul' }))
    const soul = await screen.findByRole('article', { name: 'Rendered Soul document' })
    await waitFor(() => expect(soul).toHaveTextContent('Values'), { timeout: 10000 })
    expect(screen.getByRole('heading', { name: 'SOUL.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('opens the editor from the empty identity surface by click or keyboard', async () => {
    vi.mocked(api.getHostPersonalization).mockResolvedValue({
      ...initialFiles,
      identity: '',
    })
    renderTab()

    const emptySurface = await screen.findByRole('button', { name: 'Edit IDENTITY.md' })
    fireEvent.click(emptySurface)
    const dialog = await screen.findByRole('dialog', { name: 'Edit IDENTITY.md' })
    expect(dialog).toHaveClass('cu-identity-edit-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    fireEvent.keyDown(emptySurface, { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: 'Edit IDENTITY.md' })).toBeInTheDocument()
  })

  it('opens the current Markdown editor in the large shared dialog and cancels without saving', async () => {
    renderTab()
    const dialog = await openIdentityEditor()
    expect(dialog).toHaveClass('eft-dialog--large')
    expect(dialog).toHaveClass('cu-identity-edit-dialog')
    expect(within(dialog).getByLabelText('Identity markdown')).toHaveValue(initialFiles.identity)

    fireEvent.change(within(dialog).getByLabelText('Identity markdown'), {
      target: { value: 'draft' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Edit IDENTITY.md' })).toBeNull()
    expect(screen.getByRole('article', { name: 'Rendered Identity document' })).toHaveTextContent(
      'Protect identity.'
    )
    expect(api.updateHostPersonalization).not.toHaveBeenCalled()
  })

  it('saves one document and renders the authoritative refreshed content', async () => {
    vi.mocked(api.updateHostPersonalization).mockResolvedValue({ resourceVersion: '2' })
    vi.mocked(api.getHostPersonalization)
      .mockResolvedValueOnce(initialFiles)
      .mockResolvedValueOnce({
        ...initialFiles,
        identity: '## Canonical updated mission',
        resourceVersion: '2',
      })
    renderTab()
    const dialog = await openIdentityEditor()
    fireEvent.change(within(dialog).getByLabelText('Identity markdown'), {
      target: { value: '## Updated mission' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' }))

    await waitFor(() =>
      expect(api.updateHostPersonalization).toHaveBeenCalledWith('foo', {
        agents: initialFiles.agents,
        identity: '## Updated mission',
        resourceVersion: '1',
        soul: initialFiles.soul,
        user: initialFiles.user,
      })
    )
    await waitFor(() => expect(api.getHostPersonalization).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('article', { name: 'Rendered Identity document' })).toHaveTextContent(
      'Canonical updated mission'
    )
    expect(screen.getByText('IDENTITY.md saved.')).toBeInTheDocument()
  })

  it('retains a failed draft in place for correction and retry', async () => {
    vi.mocked(api.updateHostPersonalization).mockRejectedValue(new Error('Save failed upstream'))
    renderTab()
    const dialog = await openIdentityEditor()
    const editor = within(dialog).getByLabelText('Identity markdown')
    fireEvent.change(editor, { target: { value: 'retry me' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Save failed upstream')
    expect(editor).toHaveValue('retry me')
    expect(screen.getByRole('dialog', { name: 'Edit IDENTITY.md' })).toBeInTheDocument()
  })

  it('reloads a conflict and reapplies the retained draft with the new resourceVersion', async () => {
    vi.mocked(api.updateHostPersonalization)
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 409'), { status: 409 }))
      .mockResolvedValueOnce({ resourceVersion: '3' })
    vi.mocked(api.getHostPersonalization)
      .mockResolvedValueOnce(initialFiles)
      .mockResolvedValueOnce({
        ...initialFiles,
        identity: 'server revision',
        soul: 'server soul',
        resourceVersion: '2',
      })
    renderTab()
    const dialog = await openIdentityEditor()
    const editor = within(dialog).getByLabelText('Identity markdown')
    fireEvent.change(editor, { target: { value: 'my retained draft' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/reload the latest version/i)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload latest and reapply draft' }))
    await waitFor(() => expect(api.getHostPersonalization).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(editor).toHaveValue('my retained draft'))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' }))
    await waitFor(() =>
      expect(api.updateHostPersonalization).toHaveBeenLastCalledWith('foo', {
        agents: initialFiles.agents,
        identity: 'my retained draft',
        resourceVersion: '2',
        soul: 'server soul',
        user: initialFiles.user,
      })
    )
  })

  it('disables Save and marks the editor invalid above the 64 KiB limit', async () => {
    renderTab()
    const dialog = await openIdentityEditor()
    const editor = within(dialog).getByLabelText('Identity markdown')
    fireEvent.change(editor, { target: { value: 'x'.repeat(64 * 1024 + 1) } })

    expect(editor.closest('.cu-markdown-editor')).toHaveClass('cu-markdown-editor--invalid')
    expect(within(dialog).getByRole('button', { name: 'Save document' })).toBeDisabled()
  })

  it('keeps host-page header actions empty because edit is document-local', async () => {
    const onActionsChange = vi.fn()
    renderTab(onActionsChange)
    await screen.findByRole('article', { name: 'Rendered Identity document' })
    expect(onActionsChange).toHaveBeenCalledWith(null)
  })
})
