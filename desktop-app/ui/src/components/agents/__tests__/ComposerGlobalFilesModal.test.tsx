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

function renderModal() {
  const onAdd = vi.fn()
  const onClose = vi.fn()
  render(<ComposerGlobalFilesModal onAdd={onAdd} onClose={onClose} />)
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
