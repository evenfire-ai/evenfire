// @vitest-environment jsdom
import { useCallback, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { GfsResourceDeepLinkQueue } from '../../../../../src/gfsResourceDeepLinkQueue'
import { type GfsPreviewResource, resolveGfsPreview } from '../../../lib/gfsPreview'
import type { GfsResourceNavigationRequest } from '../../../lib/gfsResourceNavigationIntent'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  openFilesTab,
  selectWorkspaceTab,
} from '../../../lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../../lib/workspaceTabs.types'
import { useNavigationController } from '../useNavigationController'

type TestLink = {
  id: number
  uri: string
  userNavigationGenerationAtActivation: number
}

type HarnessApi = {
  deliver: (link: TestLink) => GfsResourceNavigationRequest | null
  completePreview: (
    request: GfsResourceNavigationRequest,
    preview: GfsPreviewResource,
    returnLocation: { gfsUri: string | null; name: string | null }
  ) => boolean
}

let originalClerum: PropertyDescriptor | undefined

afterEach(() => {
  cleanup()
  if (originalClerum) Object.defineProperty(window, 'clerum', originalClerum)
  else Reflect.deleteProperty(window, 'clerum')
  originalClerum = undefined
})

function installMainNavigationGeneration(): { current: () => number } {
  originalClerum = Object.getOwnPropertyDescriptor(window, 'clerum')
  let generation = 0
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        getUserNavigationGeneration: () => generation,
        advanceUserNavigationGeneration: () => (generation += 1),
      },
    } as unknown as Window['clerum'],
  })
  return { current: () => generation }
}

function produceLink(
  uri: string,
  queue: GfsResourceDeepLinkQueue,
  activationGeneration: number
): TestLink {
  const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(uri))
  if (!target) throw new Error('The shared producer rejected the canonical GFS URI')
  const envelope = queue.enqueue(target, activationGeneration)
  return { ...envelope, userNavigationGenerationAtActivation: activationGeneration }
}

function tabRoute(tab: ReturnType<typeof activeWorkspaceTab>): string {
  if (!tab) return 'empty'
  if (tab.kind === 'files') return tab.files?.path ?? 'root'
  if (tab.kind === 'preview') return tab.preview?.gfsUri ?? 'preview'
  return tab.kind
}

function DeepLinkNavigationHarness({
  initialTabs,
  queue,
  onReady,
  onAcknowledge,
}: {
  initialTabs: WorkspaceTabsState
  queue: GfsResourceDeepLinkQueue
  onReady: (api: HarnessApi) => void
  onAcknowledge: (id: number) => void
}) {
  const nav = useNavigationController()
  const [pendingId, setPendingId] = useState<number | null>(null)

  useEffect(() => {
    nav.setWorkspaceTabs(initialTabs)
  }, [initialTabs, nav.setWorkspaceTabs])

  const deliver = useCallback(
    (link: TestLink) => {
      const request = nav.beginGfsResourceNavigation(
        link.id,
        link.uri,
        7,
        link.userNavigationGenerationAtActivation
      )
      if (!request) {
        onAcknowledge(link.id)
        queue.acknowledge(link.id)
        return null
      }
      if (!nav.activateGfsResourceNavigation(request, 7)) {
        onAcknowledge(link.id)
        queue.acknowledge(link.id)
        return null
      }
      setPendingId(request.id)
      return request
    },
    [nav.activateGfsResourceNavigation, nav.beginGfsResourceNavigation, onAcknowledge, queue]
  )

  const completePreview = useCallback(
    (
      request: GfsResourceNavigationRequest,
      preview: GfsPreviewResource,
      returnLocation: { gfsUri: string | null; name: string | null }
    ) => {
      const completed = nav.completeGfsResourceNavigationPreview(
        request,
        preview,
        7,
        returnLocation
      )
      if (completed) setPendingId(null)
      return completed
    },
    [nav.completeGfsResourceNavigationPreview]
  )

  useEffect(() => {
    onReady({ deliver, completePreview })
  }, [completePreview, deliver, onReady])

  const active = activeWorkspaceTab(nav.workspaceTabs)
  return (
    <>
      <div role="toolbar" aria-label="Workspace tabs">
        {nav.workspaceTabs.tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            aria-label={tab.title}
            aria-pressed={tab.id === active?.id}
            data-saved-route={tab.kind === 'files' ? (tab.files?.path ?? 'root') : undefined}
            onClick={() => nav.selectWorkspaceTabById(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <main
        data-testid="active-surface"
        data-tab-id={active?.id ?? ''}
        data-route={tabRoute(active)}
        data-pending-request-id={pendingId ?? ''}
      />
    </>
  )
}

function FilesNavigationReceiptHarness({
  initialTabs,
  path,
}: {
  initialTabs: WorkspaceTabsState
  path: string | null
}) {
  const nav = useNavigationController()
  const [receipt, setReceipt] = useState<{
    ownerTabId: string
    intentSequence: number
  } | null>(null)

  useEffect(() => {
    nav.setWorkspaceTabs(initialTabs)
  }, [initialTabs, nav.setWorkspaceTabs])

  const active = activeWorkspaceTab(nav.workspaceTabs)
  return (
    <>
      <button type="button" onClick={() => setReceipt(nav.openFilesSection(path) ?? null)}>
        Open destination
      </button>
      <output data-testid="receipt">
        {receipt ? `${receipt.ownerTabId}|${receipt.intentSequence}` : 'none'}
      </output>
      <output data-testid="active-tab-id">{active?.id ?? 'none'}</output>
      <output data-testid="active-route">{tabRoute(active)}</output>
      <output data-testid="intent-sequence">{nav.navigationIntentSequence}</output>
    </>
  )
}

describe('useNavigationController — Files navigation receipts', () => {
  it.each([
    {
      name: 'creates a new exact-path destination',
      initialTabs: createWorkspaceTabsState('chat-tab-1'),
      expectedOwnerTabId: 'ws-tab-2',
    },
    {
      name: 'returns the inactive exact-path destination selected by deduplication',
      initialTabs: selectWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
          id: 'existing-files',
          path: 'gfs://main/abababababababababababababababab',
          title: 'Existing destination',
        }),
        'chat-tab-1'
      ),
      expectedOwnerTabId: 'existing-files',
    },
    {
      name: 'returns the already active exact-path destination',
      initialTabs: openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'active-files',
        path: 'gfs://main/abababababababababababababababab',
        title: 'Active destination',
      }),
      expectedOwnerTabId: 'active-files',
    },
  ])('$name', async ({ initialTabs, expectedOwnerTabId }) => {
    installMainNavigationGeneration()
    const path = 'gfs://main/abababababababababababababababab'
    render(<FilesNavigationReceiptHarness initialTabs={initialTabs} path={path} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open destination' }))

    await waitFor(() => {
      expect(screen.getByTestId('active-tab-id').textContent).toBe(expectedOwnerTabId)
      expect(screen.getByTestId('active-route').textContent).toBe(path)
    })
    const intentSequence = Number(screen.getByTestId('intent-sequence').textContent)
    expect(screen.getByTestId('receipt').textContent).toBe(
      `${expectedOwnerTabId}|${intentSequence}`
    )
    expect(intentSequence).toBeGreaterThan(0)
  })
})

describe('useNavigationController — GFS activation ordering', () => {
  it('keeps Chat selected when an older link is delivered after an explicit Chat selection', async () => {
    const generation = installMainNavigationGeneration()
    const queue = new GfsResourceDeepLinkQueue()
    const uri = 'gfs://main/abababababababababababababababab'
    const link = produceLink(uri, queue, generation.current())
    const initialTabs = selectWorkspaceTab(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-root',
        path: null,
        title: 'Files root',
      }),
      'chat-tab-1'
    )
    let api: HarnessApi | null = null
    const acknowledge = vi.fn((id: number) => queue.acknowledge(id))
    render(
      <DeepLinkNavigationHarness
        initialTabs={initialTabs}
        queue={queue}
        onReady={value => {
          api = value
        }}
        onAcknowledge={acknowledge}
      />
    )

    const chatTab = await screen.findByRole('button', { name: 'New chat' })
    chatTab.focus()
    fireEvent.click(chatTab)
    act(() => api?.deliver(link))

    expect(chatTab.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('active-surface').getAttribute('data-tab-id')).toBe('chat-tab-1')
    expect(screen.getByTestId('active-surface').getAttribute('data-route')).toBe('chat')
    expect(
      screen.getByRole('button', { name: 'Files root' }).getAttribute('data-saved-route')
    ).toBe('root')
    expect(screen.getByRole('button', { name: 'Files root' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
    expect(document.activeElement).toBe(chatTab)
    expect(screen.getByTestId('active-surface').getAttribute('data-pending-request-id')).toBe('')
    expect(queue.list()).toEqual([])
    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledWith(link.id)
  })

  it('gives a genuinely newer link a separate Files destination', async () => {
    const generation = installMainNavigationGeneration()
    const queue = new GfsResourceDeepLinkQueue()
    const initialTabs = selectWorkspaceTab(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-root',
        path: null,
        title: 'Files root',
      }),
      'chat-tab-1'
    )
    let api: HarnessApi | null = null
    const acknowledge = vi.fn((id: number) => queue.acknowledge(id))
    render(
      <DeepLinkNavigationHarness
        initialTabs={initialTabs}
        queue={queue}
        onReady={value => {
          api = value
        }}
        onAcknowledge={acknowledge}
      />
    )

    const chatTab = await screen.findByRole('button', { name: 'New chat' })
    fireEvent.click(chatTab)
    const uri = 'gfs://main/acacacacacacacacacacacacacacacac'
    const link = produceLink(uri, queue, generation.current())
    let request: GfsResourceNavigationRequest | null = null
    act(() => {
      request = api?.deliver(link) ?? null
    })

    expect(request).not.toBeNull()
    const activeSurface = screen.getByTestId('active-surface')
    expect(activeSurface.getAttribute('data-tab-id')).not.toBe('files-root')
    expect(activeSurface.getAttribute('data-route')).toBe('root')
    expect(
      screen.getByRole('button', { name: 'Files root' }).getAttribute('data-saved-route')
    ).toBe('root')
    expect(screen.getAllByRole('button', { name: 'Files' })).toHaveLength(1)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(queue.list()).toHaveLength(1)
  })

  it('creates and selects a Files destination when a newer link arrives without any Files tab', async () => {
    const generation = installMainNavigationGeneration()
    const queue = new GfsResourceDeepLinkQueue()
    const initialTabs = createWorkspaceTabsState('chat-tab-1')
    let api: HarnessApi | null = null
    const acknowledge = vi.fn((id: number) => queue.acknowledge(id))
    render(
      <DeepLinkNavigationHarness
        initialTabs={initialTabs}
        queue={queue}
        onReady={value => {
          api = value
        }}
        onAcknowledge={acknowledge}
      />
    )

    const chatTab = await screen.findByRole('button', { name: 'New chat' })
    fireEvent.click(chatTab)
    const uri = 'gfs://main/adadadadadadadadadadadadadadadad'
    const link = produceLink(uri, queue, generation.current())
    act(() => api?.deliver(link))

    expect(screen.getByTestId('active-surface').getAttribute('data-route')).toBe('root')
    expect(screen.getAllByRole('button', { name: 'Files' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'New chat' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
    expect(acknowledge).not.toHaveBeenCalled()
    expect(queue.list()).toHaveLength(1)
  })

  it('reuses an inactive Files tab only when it already owns the exact canonical URI', async () => {
    const generation = installMainNavigationGeneration()
    const queue = new GfsResourceDeepLinkQueue()
    const uri = 'gfs://main/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const initialTabs = selectWorkspaceTab(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-exact',
        path: uri,
        title: 'Exact resource',
      }),
      'chat-tab-1'
    )
    let api: HarnessApi | null = null
    const acknowledge = vi.fn((id: number) => queue.acknowledge(id))
    render(
      <DeepLinkNavigationHarness
        initialTabs={initialTabs}
        queue={queue}
        onReady={value => {
          api = value
        }}
        onAcknowledge={acknowledge}
      />
    )

    const chatTab = await screen.findByRole('button', { name: 'New chat' })
    fireEvent.click(chatTab)
    const link = produceLink(uri, queue, generation.current())
    act(() => api?.deliver(link))

    expect(screen.getByTestId('active-surface').getAttribute('data-tab-id')).toBe('files-exact')
    expect(screen.getByTestId('active-surface').getAttribute('data-route')).toBe(uri)
    expect(screen.getAllByRole('button', { name: 'Exact resource' })).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Exact resource' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(acknowledge).not.toHaveBeenCalled()
    expect(queue.list()).toHaveLength(1)
  })

  it('does not let a deferred Files A result change the selected Files B tab', async () => {
    const generation = installMainNavigationGeneration()
    const queue = new GfsResourceDeepLinkQueue()
    const filesAUri = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const filesBUri = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const linkedUri = 'gfs://main/cccccccccccccccccccccccccccccccc'
    let initialTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-a',
      path: filesAUri,
      title: 'Files A',
    })
    initialTabs = openFilesTab(initialTabs, {
      id: 'files-b',
      path: filesBUri,
      title: 'Files B',
    })
    initialTabs = selectWorkspaceTab(initialTabs, 'files-a')
    const link = produceLink(linkedUri, queue, generation.current())
    let api: HarnessApi | null = null
    const acknowledge = vi.fn((id: number) => queue.acknowledge(id))
    render(
      <DeepLinkNavigationHarness
        initialTabs={initialTabs}
        queue={queue}
        onReady={value => {
          api = value
        }}
        onAcknowledge={acknowledge}
      />
    )

    await screen.findByRole('button', { name: 'Files A' })
    let request: GfsResourceNavigationRequest | null = null
    act(() => {
      request = api?.deliver(link) ?? null
    })
    expect(request).not.toBeNull()

    let resolveGfs!: (preview: GfsPreviewResource) => void
    const resolverPromise = new Promise<GfsPreviewResource>(resolve => {
      resolveGfs = resolve
    })
    let completed: boolean | undefined
    const completion = resolverPromise.then(preview =>
      api!.completePreview(request!, preview, { gfsUri: filesAUri, name: 'Files A' })
    )

    const filesBTab = screen.getByRole('button', { name: 'Files B' })
    filesBTab.focus()
    fireEvent.click(filesBTab)
    const preview = resolveGfsPreview({ gfsUri: linkedUri, name: 'delayed.md', bytes: 28 })
    expect(preview).not.toBeNull()
    await act(async () => {
      resolveGfs(preview!)
      completed = await completion
    })

    expect(completed).toBe(false)
    expect(filesBTab.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(filesBTab)
    expect(screen.getByTestId('active-surface').getAttribute('data-tab-id')).toBe('files-b')
    expect(screen.getByTestId('active-surface').getAttribute('data-route')).toBe(filesBUri)
    expect(screen.getByRole('button', { name: 'Files A' }).getAttribute('data-saved-route')).toBe(
      filesAUri
    )
    expect(screen.queryByRole('button', { name: 'delayed.md' })).toBeNull()
    expect(acknowledge).not.toHaveBeenCalled()
  })
})
