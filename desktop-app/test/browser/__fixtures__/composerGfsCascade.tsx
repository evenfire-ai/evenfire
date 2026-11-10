import { useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { ComposerGfsCascadeLevel } from '../../../ui/src/components/agents/ComposerGfsCascade'
import type { BoundGfsFolder } from '../../../ui/src/components/agents/ComposerGfsCascade'
import { desktopQueryKeys } from '../../../ui/src/hooks/domain/queryKeys'
import type { GfsBrowserChild } from '../../../ui/src/hooks/domain/useGfsBrowserController'

const directory = (resourceId: string, name: string, parentResourceId: string | null = null) =>
  ({
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId,
    name,
    kind: 'directory',
    path: null,
    version: 1,
    bytes: 0,
    readable: true,
  }) satisfies GfsBrowserChild

const file = (resourceId: string, name: string, parentResourceId: string | null = null) =>
  ({
    ...directory(resourceId, name, parentResourceId),
    kind: 'file',
  }) satisfies GfsBrowserChild

const longName = 'Quarterly consolidated operating results and 2026 review.pdf'
const rootItems = [
  directory('folder-a', 'Folder A'),
  directory('folder-b', 'Folder B'),
  file('long-file', longName),
  file('short-file', 'short.txt'),
]
const children = [
  directory('folder-deep', 'Deep folder', 'folder-a'),
  file('child-file', 'child.txt', 'folder-a'),
]
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const rootAnchor = document.createElement('div')
Object.assign(rootAnchor.style, {
  position: 'fixed',
  left: `${Math.max(8, window.innerWidth - 340)}px`,
  top: '24px',
  width: '320px',
  maxHeight: '430px',
})
document.getElementById('composer-cascade-fixture')!.append(rootAnchor)
const root = createRoot(rootAnchor)
queryClient.setQueryData(desktopQueryKeys.gfsAccessible('test-session', 'main', 1), {
  pages: [{ items: rootItems, nextCursor: null }],
  pageParams: [undefined],
})

function ComposerCascadeFixture() {
  const [path, setPath] = useState<BoundGfsFolder[]>([])
  const panelRef = useRef<HTMLElement | null>(null)
  return (
    <div
      className="composer-reference-submenu composer-reference-submenu--evendrive"
      ref={panelRef}
      role="menu"
      aria-label="EvenDrive files"
      style={{ maxHeight: 430, overflowY: 'auto' }}
    >
      <ComposerGfsCascadeLevel
        items={rootItems}
        path={path}
        parentPath={[]}
        parentSnapshot={{
          revision: 1,
          data: queryClient.getQueryData(desktopQueryKeys.gfsAccessible('test-session', 'main', 1)),
          isCurrent: () => true,
        }}
        authorityByResourceId={
          new Map([
            ['folder-a', 'allowed'],
            ['folder-b', 'allowed'],
            ['folder-deep', 'allowed'],
            ['long-file', 'allowed'],
            ['short-file', 'allowed'],
            ['child-file', 'allowed'],
          ])
        }
        controller={
          {
            sessionScope: 'test-session',
            sessionGeneration: 1,
            accessState: 'active',
          } as never
        }
        rootAnchorRef={panelRef}
        registerRow={() => undefined}
        isCurrentPanel={() => true}
        isCurrentlyAllowed={() => true}
        isAdmissionCurrent={() => true}
        onActivateFolder={next => {
          const nextPath = next.map((entry, index) => ({ ...entry, bindingId: index + 1 }))
          setPath(nextPath)
          window.composerCascadeFixture.path = nextPath.map(entry => entry.resourceId)
        }}
        onInsert={entry => {
          window.composerCascadeFixture.inserted = [
            ...window.composerCascadeFixture.inserted,
            entry.gfsUri,
          ]
        }}
        onKeyboardClose={next => {
          const nextPath = next.map((entry, index) => ({ ...entry, bindingId: index + 1 }))
          setPath(nextPath)
          window.composerCascadeFixture.path = nextPath.map(entry => entry.resourceId)
        }}
        onKeyboardCloseRoot={() => undefined}
        suppressNextFolderFocusOpen={() => undefined}
        consumeSuppressedFolderFocusOpen={() => false}
        onChildEntries={() => undefined}
        onAuthorityFailure={() => undefined}
      />
    </div>
  )
}

window.clerum ??= {} as typeof window.clerum
window.clerum.gfs ??= {} as typeof window.clerum.gfs
window.clerum.gfs.listChildren = async folderId => {
  window.composerCascadeFixture.childRequests.push(folderId)
  return {
    items: folderId === 'folder-a' ? children : [],
    nextCursor: null,
  } as never
}
window.clerum.gfs.listAccessible = async () => ({ items: rootItems, nextCursor: null }) as never

Object.assign(window, {
  composerCascadeFixture: {
    inserted: [] as string[],
    path: [] as string[],
    childRequests: [] as string[],
    reset() {
      queryClient.clear()
      queryClient.setQueryData(desktopQueryKeys.gfsAccessible('test-session', 'main', 1), {
        pages: [{ items: rootItems, nextCursor: null }],
        pageParams: [undefined],
      })
      this.inserted = []
      this.path = []
      this.childRequests = []
      root.render(
        <QueryClientProvider client={queryClient}>
          <ComposerCascadeFixture />
        </QueryClientProvider>
      )
    },
  },
})
root.render(
  <QueryClientProvider client={queryClient}>
    <ComposerCascadeFixture />
  </QueryClientProvider>
)

declare global {
  interface Window {
    composerCascadeFixture: {
      inserted: string[]
      path: string[]
      childRequests: string[]
      reset(): void
    }
  }
}
