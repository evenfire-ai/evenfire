import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { desktopQueryClient } from '@lib/queryClient'
import '@styles/tokens.css'
import { App } from '@/App'
import '../src/styles.css'

const folder = {
  resourceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  rid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  gfsUri: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  drive: 'main',
  parentResourceId: null,
  name: 'Upload folder',
  kind: 'directory',
  path: '/Upload folder',
  version: 1,
  readable: true,
  sources: ['direct'],
  permissions: ['read', 'write'],
  coversDescendants: false,
}
const file = {
  ...folder,
  resourceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  rid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  gfsUri: 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'Replace target.txt',
  kind: 'file',
  path: '/Replace target.txt',
  version: 7,
  bytes: 4,
}
let generation = 0
const noop = () => () => {}
const bridge = {
  app: { rendererReady: async () => {} },
  auth: {
    getDesktopAppInfo: async () => ({ version: 'test' }),
    getSessionGeneration: async () => 1,
  },
  shortcuts: { onCommand: noop },
  sandboxUi: {
    onSessionInvalidated: noop,
    listApps: async () => ({ apps: [] }),
    listPendingDeepLinks: async () => ({ links: [] }),
    clearPendingDeepLinks: async () => {},
    acknowledgeDeepLink: async () => {},
    onDeepLink: noop,
    close: async () => {},
    getLocation: async () => null,
    focusActive: async () => true,
    setVisible: async () => {},
  },
  team: { directory: async () => ({ items: [] }) },
  agents: { listMine: async () => [] },
  gfs: {
    getUserNavigationGeneration: () => generation,
    advanceUserNavigationGeneration: () => ++generation,
    listAccessible: async () => ({ items: [folder, file], nextCursor: null }),
    listChildren: async () => ({ items: [], nextCursor: null }),
    resolve: async (uri: string) => {
      if (uri === folder.gfsUri && (window as any).__holdFolder) {
        ;(window as any).__folderResolveStarted = true
        await new Promise<void>(resolve => {
          ;(window as any).__releaseFolder = resolve
        })
      }
      if (uri === folder.gfsUri) return folder
      if (uri === file.gfsUri) return file
      throw new Error(`Unexpected fixture URI: ${uri}`)
    },
    affordances: async () => ({
      held: ['read', 'write', 'manage_acl'],
      canDelegate: true,
      grantableBits: ['read', 'write'],
      canCreateShare: true,
    }),
    onDeepLink: noop,
    listPendingDeepLinks: async () => ({ links: [] }),
    acknowledgeDeepLink: async () => {},
    getPathForFile: (file: File) => {
      ;(window as any).__selectedFile = { name: file.name, size: file.size }
      void file.text().then(text => {
        ;(window as any).__selectedFileText = text
      })
      return file.name
    },
    createFileFromPath: async (...args: unknown[]) => {
      ;(window as any).__uploadCreate = args
      ;((window as any).__uploadCreates ??= []).push(args)
      return {}
    },
    replaceFileFromPath: async (...args: unknown[]) => {
      ;((window as any).__replaceCalls ??= []).push(args)
      return {}
    },
  },
}
;(window as unknown as { clerum: unknown }).clerum = bridge
window.addEventListener('error', e => {
  ;(window as any).__nativeAppError = String(e.error?.stack || e.message)
})
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={desktopQueryClient}>
    <AgentTaskTrackerProvider>
      <App />
    </AgentTaskTrackerProvider>
  </QueryClientProvider>
)
