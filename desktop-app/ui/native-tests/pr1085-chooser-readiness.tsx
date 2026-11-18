import { AuthContext } from '@contexts/AuthContext'
import type { AuthContextValue } from '@contexts/AuthContext.types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import '@styles/tokens.css'
import '../src/styles.css'

const resource = {
  resourceId: 'native-sidebar-file',
  rid: 'native-sidebar-file',
  gfsUri: 'gfs://main/native-sidebar-file',
  drive: 'main',
  parentResourceId: null,
  name: 'native-menu-file.md',
  kind: 'file' as const,
  path: '/native-menu-file.md',
  version: 1,
  bytes: 32,
  readable: true,
  sources: ['direct'],
  permissions: ['read'],
  coversDescendants: false,
}
const secondResource = {
  ...resource,
  resourceId: 'native-sidebar-second',
  rid: 'native-sidebar-second',
  gfsUri: 'gfs://main/native-sidebar-second',
  name: 'zz-second.md',
  path: '/zz-second.md',
  version: 2,
}
const folder = {
  ...resource,
  resourceId: 'native-sidebar-folder',
  rid: 'native-sidebar-folder',
  gfsUri: 'gfs://main/native-sidebar-folder',
  name: 'upload-folder',
  path: '/upload-folder',
  kind: 'directory' as const,
}

const bridge = {
  auth: { getSessionGeneration: async () => 7 },
  gfs: {
    listAccessible: async () => ({ items: [resource, secondResource, folder], nextCursor: null }),
    listChildren: async () => ({ items: [], nextCursor: null }),
    affordances: async () => ({
      held: ['read', 'manage_acl', 'write'],
      canDelegate: true,
      grantableBits: ['read', 'write'],
      canCreateShare: true,
    }),
  },
}
;(window as unknown as { clerum: unknown }).clerum = bridge

const auth = {
  isAuthenticated: true,
  me: { id: 'native-acceptance', teamId: 'native-acceptance' },
  runtimeConfigState: { envKey: 'native-acceptance' },
  sessionGeneration: 7,
} as AuthContextValue

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = createRoot(document.getElementById('root')!)
root.render(
  <AuthContext.Provider value={auth}>
    <QueryClientProvider client={queryClient}>
      <div className="native-acceptance-shell">
        <aside className="left-nav" aria-label="Sidebar">
          <FileExplorerTree
            onOpenFolder={() => {}}
            onOpenPreview={() => {}}
            onResourceAction={(node, action, file) => {
              const resultWindow = window as unknown as { __chooserCalls?: string[] }
              ;(resultWindow.__chooserCalls ??= []).push(`${action}:${node.resourceId}`)
              if (action === 'upload-file') {
                ;(window as unknown as { __uploadDispatch: unknown }).__uploadDispatch = {
                  resourceId: node.resourceId,
                  active: navigator.userActivation.isActive,
                  hasFile: Boolean(file),
                }
              }
              void file?.text().then(text => {
                ;(window as unknown as { __chooserResult: unknown }).__chooserResult = {
                  action,
                  resourceId: node.resourceId,
                  gfsUri: node.gfsUri,
                  version: node.version,
                  fileName: file.name,
                  text,
                }
              })
            }}
            pushToast={() => {}}
          />
        </aside>
        <main className="native-acceptance-workspace">
          <section className="native-acceptance-content">
            <div className="sandbox-ui-embed-slot" data-testid="native-slot" />
          </section>
        </main>
      </div>
    </QueryClientProvider>
  </AuthContext.Provider>
)

const style = document.createElement('style')
style.textContent = `
  html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  .native-acceptance-shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); width: 100vw; height: 100vh; }
  .native-acceptance-shell > .left-nav { position: relative !important; inset: auto !important; width: 280px !important; height: 100%; min-width: 0; overflow: auto; }
  .native-acceptance-workspace { position: relative; min-width: 0; height: 100%; }
  .native-acceptance-content { position: relative; width: 100%; height: 100%; }
  .native-acceptance-content .sandbox-ui-embed-slot { position: absolute; inset: 0; }
`
document.head.append(style)

const ready = window.setInterval(() => {
  if (!document.querySelector('.da-file-explorer__label')) return
  window.clearInterval(ready)
  ;(window as unknown as { __nativeSidebarReady: boolean }).__nativeSidebarReady = true
}, 10)
