// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComposerAgentFilesModal } from '../ComposerAgentFilesModal'

function installSharedFiles(
  listAttached: ReturnType<typeof vi.fn>,
  listDirectory: ReturnType<typeof vi.fn>
) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { sharedFiles: { listAttached, listDirectory } },
  })
}

describe('ComposerAgentFilesModal', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps navigation and selected attachment references under the existing component state', async () => {
    const listAttached = vi.fn(async () => ({
      items: [{ name: 'workspace', mountPath: '/workspace', phase: 'ready' }],
    }))
    const listDirectory = vi.fn(async (_contextId: string, _filesystem: string, path: string) => ({
      entries:
        path === '/Reports'
          ? [{ name: 'roadmap.md', kind: 'file', size: 24, mtime: '2026-01-01T00:00:00Z' }]
          : [
              { name: 'Reports', kind: 'directory', size: 0, mtime: '2026-01-01T00:00:00Z' },
              { name: 'notes.txt', kind: 'file', size: 12, mtime: '2026-01-01T00:00:00Z' },
              { name: 'shortcut', kind: 'other', size: 0, mtime: '2026-01-01T00:00:00Z' },
            ],
    }))
    const onAdd = vi.fn()
    const onClose = vi.fn()
    installSharedFiles(listAttached, listDirectory)

    render(<ComposerAgentFilesModal contextId="context-1" onAdd={onAdd} onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open workspace' }))
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith('context-1', 'workspace', '/'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Attach folder Reports' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Attach file notes.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open folder Reports' }))
    await waitFor(() =>
      expect(listDirectory).toHaveBeenLastCalledWith('context-1', 'workspace', '/Reports')
    )
    expect(await screen.findByText('roadmap.md')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() =>
      expect(listDirectory).toHaveBeenLastCalledWith('context-1', 'workspace', '/')
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'directory',
          path: '/Reports',
          filesystemName: 'workspace',
        }),
        expect.objectContaining({ kind: 'file', path: '/notes.txt', filesystemName: 'workspace' }),
      ])
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retains list failures and supports the existing cancel callback', async () => {
    const listAttached = vi.fn(async () => {
      throw new Error('filesystem listing failed')
    })
    const listDirectory = vi.fn()
    const onAdd = vi.fn()
    const onClose = vi.fn()
    installSharedFiles(listAttached, listDirectory)

    render(<ComposerAgentFilesModal contextId="context-1" onAdd={onAdd} onClose={onClose} />)

    expect(await screen.findByText('filesystem listing failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onAdd).not.toHaveBeenCalled()
  })
})
