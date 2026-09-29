// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerGlobalFilesModal } from '../ComposerGlobalFilesModal'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Only the fields this modal reads. The component destructures them directly,
 * so a field added to the controller and consumed here without landing in this
 * fixture surfaces as `undefined` rather than as a type error.
 */
function baseController() {
  return {
    current: null,
    crumbs: [],
    items: [],
    accessibleResources: [],
    loading: false,
    loadingAccessible: false,
    error: null,
    errorUpdatedAt: 0,
    accessibleError: null,
    accessibleNotice: null,
    discoveryFailure: null,
    retryDiscovery: vi.fn(),
    retryChildren: vi.fn(),
    hasMore: false,
    hasMoreAccessible: false,
    isFetchingMore: false,
    isFetchingMoreAccessible: false,
    loadMore: vi.fn(),
    loadMoreAccessible: vi.fn(),
    openChild: vi.fn(),
    openResource: vi.fn(),
    goToCrumb: vi.fn(),
    reset: vi.fn(),
  }
}

function attachedElsewhere(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `global-file:main:elsewhere-${index}`)
}

function renderModal(attachedIds: string[] = []) {
  const onAdd = vi.fn()
  const onClose = vi.fn()
  render(<ComposerGlobalFilesModal attachedIds={attachedIds} onAdd={onAdd} onClose={onClose} />)
  return { onAdd, onClose }
}

const RATE_LIMITED_DISCOVERY =
  "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
  'Too Many Requests retryAfterSeconds=7'

const RATE_LIMITED_CHILDREN =
  "Error invoking remote method 'gfs:listChildren': Error: 429 Too Many Requests: " +
  'Too Many Requests retryAfterSeconds=7'

describe('ComposerGlobalFilesModal', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('lists the resources discovery returned', () => {
    // Liveness witness for the whole file: the happy path really renders rows,
    // so every "not shown" assertion below describes a branch that was taken
    // and not a modal that failed to mount at all.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: null,
          name: 'notes.txt',
          kind: 'file',
          path: '/notes.txt',
          version: 1,
          bytes: 12,
        },
      ],
    })

    renderModal()

    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
  })

  it('stops selecting at the shared ten-file message limit', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: Array.from({ length: 11 }, (_, index) => ({
        resourceId: `file-${index}`,
        rid: `file-${index}`,
        gfsUri: `gfs://main/file-${index}`,
        drive: 'main',
        parentResourceId: null,
        name: `file-${index}.txt`,
        kind: 'file',
        path: `/file-${index}.txt`,
        version: 1,
        bytes: 12,
      })),
    })

    renderModal()

    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox')
    for (const box of boxes) act(() => fireEvent.click(box))
    expect(boxes.slice(0, 10).every(box => box.checked)).toBe(true)
    // The eleventh stayed unselectable and the footer names the limit.
    expect(boxes[10]!.checked).toBe(false)
    expect(boxes[10]!.disabled).toBe(true)
    expect(screen.getByText('10').tagName).toBe('STRONG')
    expect(screen.getByText('files selected')).toBeTruthy()
    expect(screen.getByText('Up to 10 files per message.')).toBeTruthy()
  })

  it('counts files already in the composer against the ten-file message limit', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: Array.from({ length: 6 }, (_, index) => ({
        resourceId: `file-${index}`,
        rid: `file-${index}`,
        gfsUri: `gfs://main/file-${index}`,
        drive: 'main',
        parentResourceId: null,
        name: `file-${index}.txt`,
        kind: 'file',
        path: `/file-${index}.txt`,
        version: 1,
        bytes: 12,
      })),
    })

    const { onAdd } = renderModal(attachedElsewhere(7))

    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox')
    for (const box of boxes) act(() => fireEvent.click(box))
    // Liveness witness: the picker did select, so the stop below is the limit
    // and not a modal that ignores clicks.
    expect(boxes.slice(0, 3).every(box => box.checked)).toBe(true)
    expect(boxes.slice(3).every(box => !box.checked && box.disabled)).toBe(true)
    expect(screen.getByText('Up to 10 files per message (7 already attached).')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Attach 3' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0]![0]).toHaveLength(3)
    // The limit summary is announced when it appears.
    expect(screen.getByRole('status').textContent).toContain('7 already attached')
  })

  it('shows a file already in the composer as attached and does not count it twice', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: Array.from({ length: 2 }, (_, index) => ({
        resourceId: `file-${index}`,
        rid: `file-${index}`,
        gfsUri: `gfs://main/file-${index}`,
        drive: 'main',
        parentResourceId: null,
        name: `file-${index}.txt`,
        kind: 'file',
        path: `/file-${index}.txt`,
        version: 1,
        bytes: 12,
      })),
    })

    // Nine attached, one of them file-0: one slot is left for file-1.
    const { onAdd } = renderModal([...attachedElsewhere(8), 'global-file:main:file-0'])

    const [attachedBox, freeBox] = screen.getAllByRole<HTMLInputElement>('checkbox')
    expect(attachedBox!.checked).toBe(true)
    expect(attachedBox!.disabled).toBe(true)
    expect(screen.getByText('Attached')).toBeTruthy()
    // Liveness witness: the free row is selectable, so the disabled state above
    // belongs to the attached row and not to a modal that blocks every click.
    expect(freeBox!.disabled).toBe(false)
    act(() => fireEvent.click(freeBox!))
    expect(freeBox!.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1' }))
    expect(onAdd.mock.calls[0]![0].map((file: { id: string }) => file.id)).toEqual([
      'global-file:main:file-1',
    ])
  })

  it('answers a rate-limited discovery with a retry, not "No shared files yet"', async () => {
    vi.useFakeTimers()
    const retryDiscovery = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleError: RATE_LIMITED_DISCOVERY,
      discoveryFailure: {
        kind: 'rate-limited',
        message: RATE_LIMITED_DISCOVERY,
        retryAvailableAt: Date.now() + 7_000,
      },
      retryDiscovery,
    })

    renderModal()

    // The picker used to state the user's library was empty on the strength of
    // a request the server refused, and offered no way back: the only exit was
    // to close and reopen the modal, spending another request against the
    // budget that had just refused one.
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(screen.getByText('Too many file requests')).toBeTruthy()
    expect(screen.getByTestId('gfs-discovery-retry-seconds').textContent).toBe('7')
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()

    const disabled = screen.getByRole('button', {
      name: /retry file listing/i,
    }) as HTMLButtonElement
    expect(disabled.disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000)
    })
    const enabled = screen.getByRole('button', { name: /retry file listing/i }) as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(enabled)
    })
    // Witness: wired to the controller, not to a local no-op.
    expect(retryDiscovery).toHaveBeenCalledTimes(1)
  })

  it('answers a rate-limited folder listing by retrying the children query', async () => {
    const retryChildren = vi.fn()
    const retryDiscovery = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      items: [],
      error: RATE_LIMITED_CHILDREN,
      errorUpdatedAt: Date.now() - 7_000,
      retryChildren,
      retryDiscovery,
    })

    renderModal()

    expect(screen.queryByText('This folder is empty')).toBeNull()
    expect(screen.getByText('Too many file requests')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry file listing/i }))
    })
    // The query that failed is the one retried. Discovery was never asked
    // anything on this plane and must not be spent here.
    expect(retryChildren).toHaveBeenCalledTimes(1)
    expect(retryDiscovery).not.toHaveBeenCalled()
  })

  it('keeps a loaded listing when only the next page was refused', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: null,
          name: 'notes.txt',
          kind: 'file',
          path: '/notes.txt',
          version: 1,
          bytes: 12,
        },
      ],
      hasMoreAccessible: true,
      accessibleError: RATE_LIMITED_DISCOVERY,
      discoveryFailure: {
        kind: 'rate-limited',
        message: RATE_LIMITED_DISCOVERY,
        retryAvailableAt: Date.now() + 7_000,
      },
    })

    renderModal()

    // Witness: the row the user already had is still there.
    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
    // Still surfaced, as the banner, and presented rather than raw.
    expect(screen.getByText(/Too many file requests — try again in 7s\./)).toBeTruthy()
  })

  it('leaves an unsupported discovery on its notice, with no retry to offer', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleNotice:
        'Automatic GFS discovery is not available from this server yet. You can still open any GFS link you have.',
      discoveryFailure: {
        kind: 'unsupported',
        message: '404 Not Found: Not Found',
        retryAvailableAt: null,
      },
    })

    renderModal()

    // Witness: this is the unsupported branch, not an unmounted modal.
    expect(screen.getByText(/Automatic GFS discovery is not available/)).toBeTruthy()
    // A Retry would promise an endpoint that does not appear because a button
    // was pressed.
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
    expect(screen.queryByText('Too many file requests')).toBeNull()
    // Excluding the failure card left the empty state to speak, and it claimed
    // the library was empty — an answer the server explicitly could not give.
    // A user told they have nothing to attach stops looking.
    expect(screen.getByText('Files cannot be listed here')).toBeTruthy()
    expect(screen.queryByText('No shared files yet')).toBeNull()
  })

  it('still reports an empty FOLDER as empty while discovery is unsupported', () => {
    // The unsupported verdict describes the ROOT listing and stays set while
    // the user browses. Inside a folder the server did answer — with nothing —
    // so "cannot be listed" would be the false statement here.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-a',
        gfsUri: 'gfs://main/folder-a',
        name: 'Marketing',
        kind: 'directory',
      },
      crumbs: [{ resourceId: 'folder-a', name: 'Marketing' }],
      discoveryFailure: {
        kind: 'unsupported',
        message: '404 Not Found: Not Found',
        retryAvailableAt: null,
      },
    })

    renderModal()

    // Witness: the modal really is inside that folder, so the copy below is the
    // folder branch and not a root render that never saw `current`.
    expect(screen.getByText('Marketing')).toBeTruthy()
    expect(screen.getByText('This folder is empty')).toBeTruthy()
    expect(screen.queryByText('Files cannot be listed here')).toBeNull()
  })

  it('reports an empty library only when discovery actually answered', () => {
    hookMock.useGfsBrowserController.mockReturnValue(baseController())

    renderModal()

    expect(screen.getByText('No shared files yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
  })
})
