import { AuthContext } from '@contexts/AuthContext'
import type { AuthContextValue } from '@contexts/AuthContext.types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import '@styles/tokens.css'
import '../src/styles.css'

const fixture = JSON.parse(new URL(window.location.href).searchParams.get('fixture') ?? 'null') as {
  accessiblePage: Awaited<ReturnType<typeof window.clerum.gfs.listAccessible>>
  affordances: Awaited<ReturnType<typeof window.clerum.gfs.affordances>>
} | null
if (!fixture) throw new Error('Native sidebar test requires producer-backed GFS data')

const bridge = {
  auth: { getSessionGeneration: async () => 7 },
  gfs: {
    listAccessible: async () => fixture.accessiblePage,
    listChildren: async () => ({ items: [], nextCursor: null }),
    affordances: async () => fixture.affordances,
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
            onResourceAction={() => {}}
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
