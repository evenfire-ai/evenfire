// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import { desktopQueryDefaults } from '@lib/queryClient'
import { createPageEmbed } from '@pages/__tests__/__fixtures__/launchingSandboxUiPage'
import { LaunchingSandboxUiPage } from '@pages/__tests__/__fixtures__/launchingSandboxUiPage'
import {
  childView,
  createFolderResult,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsActionHost } from '..'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import { useGfsActionHost } from '../context'
import { useGfsActionOverlay } from '../overlay'
import type { GfsHostActionTarget } from '../types'

const me = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member',
}
const auth = {
  isAuthenticated: true,
  me,
  runtimeConfigState: null,
  sessionGeneration: 1,
} as unknown as AuthContextValue

const TASK_APP = { appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }

const visibility: boolean[] = []
const sandboxUi = {
  listApps: vi.fn(async () => ({ apps: [] })),
  open: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  copyDeepLink: vi.fn(),
  setBounds: vi.fn(async () => undefined),
  setVisible: vi.fn(async (visible: boolean) => {
    visibility.push(visible)
  }),
  capturePreview: vi.fn(async () => null),
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(async () => undefined),
  focusActive: vi.fn(async () => true),
  onFindResult: vi.fn(() => vi.fn()),
}

/**
 * The sidebar's half of the gate as the tree will own it: a row menu that
 * reports its open state and, on a choice, starts the host action and is
 * dismissed in the same handler.
 */
function RowMenu({
  target,
  onOpenChange,
  onClosed,
}: {
  target: GfsHostActionTarget
  onOpenChange: (open: boolean) => void
  onClosed: () => void
}) {
  const host = useGfsActionHost()!
  const actions = buildGfsResourceActions({
    kind: target.kind,
    uri: target.gfsUri,
    handlers: { rename: () => host.openGfsAction(target, 'rename') },
    canRename: true,
  })
  return (
    <GfsResourceMenu
      actions={actions}
      anchor={{ x: 40, y: 40 }}
      permissionStatus="ok"
      resourceName={target.name}
      onDismiss={onClosed}
      onOpenChange={onOpenChange}
    />
  )
}

let openMenu: () => void = () => {}
let hostValue: ReturnType<typeof useGfsActionHost> = null
let uploadLanded: (() => void) | null = null

function HostProbe() {
  hostValue = useGfsActionHost()
  return null
}
let setTreeMounted: (mounted: boolean) => void = () => {}

function Shell({ embed, target }: { embed: EmbedOwnershipMachine; target: GfsHostActionTarget }) {
  const overlay = useGfsActionOverlay(true)
  const [menuKey, setMenuKey] = useState<number | null>(null)
  const [treeMounted, setMounted] = useState(true)
  openMenu = () => setMenuKey(key => (key ?? 0) + 1)
  setTreeMounted = setMounted
  return (
    <GfsActionHost
      pushToast={() => {}}
      refreshFilesLocation={() => {}}
      onActionOpenChange={overlay.onActionOpenChange}
    >
      <HostProbe />
      {treeMounted && menuKey !== null ? (
        <RowMenu
          key={menuKey}
          target={target}
          onOpenChange={overlay.onGfsMenuOpenChange}
          onClosed={() => setMenuKey(null)}
        />
      ) : null}
      <LaunchingSandboxUiPage
        embed={embed}
        initialLaunch={TASK_APP}
        sidebarShellOverlayOpen={overlay.overlayOpen}
      />
    </GfsActionHost>
  )
}

async function mountShell() {
  const page = await listChildrenPage([
    childView('file-t', 'notes.txt', 'file', { parentResourceId: 'folder-p', version: 3 }),
  ])
  const target = page.items[0] as GfsHostActionTarget
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const embed = createPageEmbed()
  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <Shell embed={embed} target={target} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
  await screen.findByTestId('sandbox-ui-mounted')
  await waitFor(() => expect(visibility).toContain(true))
  // The opening passes (minting, then mounted) each show the view; let them settle.
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 20))
  })
  expect(visibility.every(visible => visible)).toBe(true)
  visibility.length = 0
  return { embed }
}

async function relaunch(embed: EmbedOwnershipMachine) {
  const previous = embed.getSnapshot().owner
  const launch = {
    launchId: crypto.randomUUID(),
    tabId: 'ws-tab-1',
    appRef: TASK_APP.appRef,
    route: { kind: 'tab' as const },
    app: { label: TASK_APP.label, defaultPath: TASK_APP.defaultPath },
  }
  embed.registerWhenSettled(launch.launchId)
  embed.dispatch({ type: 'relaunch', launch })
  // Main confirms the old view is gone before the new one opens.
  await waitFor(() => expect(sandboxUi.close).toHaveBeenCalled())
  if (previous) embed.onReleased({ launchId: previous, reason: 'closed', location: null })
}

beforeEach(() => {
  visibility.length = 0
  vi.clearAllMocks()
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      sandboxUi,
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: {
        affordances: vi.fn(async () =>
          delegationAffordances(new Set(['read', 'write', 'delete']), false)
        ),
        getPathForFile: (file: File) => `/local/${file.name}`,
        createFileFromPath: vi.fn(
          async () =>
            new Promise(resolve => {
              uploadLanded = () =>
                resolve(createFolderResult('folder-d', childView('u1', 'report.txt', 'file')))
            })
        ),
      },
    },
  })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 12,
    left: 16,
    right: 416,
    bottom: 312,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => window.setTimeout(resolve, 0))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('GfsActionHost — native app view gate', () => {
  it('menu → checking → dialog → close hides the view once and shows it once, a relaunch in between', async () => {
    const { embed } = await mountShell()

    act(() => openMenu())
    await waitFor(() => expect(visibility).toEqual([false]))

    fireEvent.click(await screen.findByRole('menuitem', { name: /rename/i }))
    await screen.findByRole('dialog', { name: /rename file/i })
    expect(screen.queryByRole('menu')).toBeNull()

    // A relaunch mounts a new view, which main attaches visible: it is hidden again.
    await act(async () => {
      await relaunch(embed)
    })
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await screen.findByTestId('sandbox-ui-mounted')
    await act(async () => {})
    expect(visibility).not.toContain(true)
    expect(visibility.length).toBeGreaterThanOrEqual(2)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(visibility[visibility.length - 1]).toBe(true))
    expect(visibility.filter(visible => visible)).toEqual([true])
  })

  it('the tree unmounting with its menu open releases the gate', async () => {
    await mountShell()

    act(() => openMenu())
    await waitFor(() => expect(visibility).toEqual([false]))
    act(() => setTreeMounted(false))

    await waitFor(() => expect(visibility).toEqual([false, true]))
  })

  it('once the file is chosen the view shows again while the upload runs', async () => {
    await mountShell()
    const folder = (await listChildrenPage([childView('folder-d', 'Docs', 'directory')]))
      .items[0] as GfsHostActionTarget
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    act(() => hostValue!.openGfsAction(folder, 'upload-file'))
    await waitFor(() => expect(visibility).toEqual([false]))
    await act(async () => {
      fireEvent.change(screen.getByTestId('gfs-action-host-upload-input'), {
        target: { files: [new File(['data'], 'report.txt')] },
      })
    })

    await waitFor(() => expect(window.clerum.gfs.createFileFromPath).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(visibility).toEqual([false, true]))
    expect(uploadLanded).not.toBeNull()
    await act(async () => uploadLanded?.())
    click.mockRestore()
  })
})
