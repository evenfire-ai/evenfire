// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiGet } from '@lib/api'
import { GfsMoveDialog } from '../GfsMoveDialog'

vi.mock('@lib/api', () => ({ apiGet: vi.fn() }))

const mockApiGet = vi.mocked(apiGet)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GfsMoveDialog', () => {
  it('renders a compact folder picker and moves to the selected location', async () => {
    mockApiGet.mockImplementation(async path => {
      if (path === '/api/v1/gfs/tree') {
        return {
          rootResourceId: 'root-1',
          items: [
            {
              resourceId: 'archive-1',
              name: 'Archive',
              kind: 'directory',
            },
          ],
          nextCursor: null,
        }
      }
      return { items: [], nextCursor: null }
    })
    const onMove = vi.fn(async () => undefined)

    render(
      <GfsMoveDialog
        initialCrumbs={[{ id: 'product-1', name: 'Product' }]}
        onClose={vi.fn()}
        onMove={onMove}
        target={{ resourceId: 'file-1', name: 'notes.txt', kind: 'file' }}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Move file notes.txt' })
    expect(within(dialog).getByText('Move “notes.txt”')).toBeTruthy()
    expect(within(dialog).queryByText('Suggested')).toBeNull()
    expect(within(dialog).queryByText('Starred')).toBeNull()
    expect(within(dialog).queryByText('All locations')).toBeNull()

    const archive = await within(dialog).findByRole('button', { name: 'Archive' })
    expect(archive.classList.contains('cu-gfs-move-dialog__tree-select')).toBe(true)

    // The location pill reports the folder that CONTAINS the target (from the
    // crumbs) — never the pending selection.
    expect(within(dialog).getAllByText('Product', { selector: 'strong' })).toHaveLength(1)
    fireEvent.click(archive)

    await waitFor(() => {
      expect(within(dialog).getAllByText('Archive', { selector: 'strong' })).toHaveLength(1)
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() => expect(onMove).toHaveBeenCalledWith('archive-1', 'Archive'))
  })

  it('moves a file to the main root', async () => {
    mockApiGet.mockResolvedValue({
      rootResourceId: 'root-1',
      items: [{ resourceId: 'archive-1', name: 'Archive', kind: 'directory' }],
      nextCursor: null,
    })
    const onMove = vi.fn(async () => undefined)

    render(
      <GfsMoveDialog
        initialCrumbs={[{ id: 'product-1', name: 'Product' }]}
        onClose={vi.fn()}
        onMove={onMove}
        target={{ resourceId: 'file-1', name: 'notes.txt', kind: 'file' }}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Move file notes.txt' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'main' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (main)' }))

    await waitFor(() => expect(onMove).toHaveBeenCalledWith('root-1', 'main'))
  })

  it('refuses a no-op move into the folder that already contains the target', async () => {
    mockApiGet.mockImplementation(async path => {
      if (path === '/api/v1/gfs/tree') {
        return {
          items: [
            { resourceId: 'product-1', name: 'Product', kind: 'directory' },
            { resourceId: 'archive-1', name: 'Archive', kind: 'directory' },
          ],
          nextCursor: null,
        }
      }
      return { items: [], nextCursor: null }
    })
    const onMove = vi.fn(async () => undefined)

    render(
      <GfsMoveDialog
        initialCrumbs={[{ id: 'product-1', name: 'Product' }]}
        onClose={vi.fn()}
        onMove={onMove}
        target={{ resourceId: 'file-1', name: 'notes.txt', kind: 'file' }}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Move file notes.txt' })
    // The current parent is never preselected.
    expect(within(dialog).getByText('Select a destination folder')).toBeTruthy()

    const product = await within(dialog).findByRole('button', { name: 'Product' })
    fireEvent.click(product)
    const noOpButton = within(dialog).getByRole('button', {
      name: 'Move here (Product)',
    }) as HTMLButtonElement
    expect(noOpButton.disabled).toBe(true)
    expect(within(dialog).getByText(/is already in Product/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() => expect(onMove).toHaveBeenCalledWith('archive-1', 'Archive'))
    expect(onMove).toHaveBeenCalledTimes(1)
  })
})
