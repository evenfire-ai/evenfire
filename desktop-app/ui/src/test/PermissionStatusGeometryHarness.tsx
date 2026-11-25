import { useEffect, useMemo } from 'react'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
import { desktopQueryDefaults } from '@lib/queryClient'
import { FilePreviewPage } from '@pages/FilePreviewPage'
import { FilesPage } from '@pages/FilesPage'
import '../styles.css'
import '../styles/tokens.css'

type PermissionMode = 'success' | 'pending' | 'error'
type GeometryHarness = {
  filesClient: QueryClient
  previewClient: QueryClient
  setPermissionMode: (resourceId: string, mode: PermissionMode) => void
  startAffordanceRefetch: (surface: 'files' | 'preview', resourceId: string) => boolean
  settlePermission: (resourceId: string, result: 'success' | 'error') => void
}
type PermissionStatusFixtures = {
  setPermissionMode: (resourceId: string, mode: PermissionMode) => void
  settlePermission: (resourceId: string, result: 'success' | 'error') => void
}

declare global {
  interface Window {
    __permissionStatusGeometry?: GeometryHarness
    __permissionStatusFixtures?: PermissionStatusFixtures
  }
}

const authValue = {
  isAuthenticated: true,
  sessionGeneration: 0,
  me: {
    id: 'geometry-user',
    email: 'geometry@example.test',
    name: 'Geometry User',
    picture: null,
    teamId: 'geometry-team',
    teamName: 'Geometry Team',
    role: 'member',
  },
  runtimeConfigState: { envKey: 'permission-geometry-test' },
} as unknown as AuthContextValue

function PermissionStatusGeometryHarness() {
  useWindowFocusBridge()
  const query = new URLSearchParams(window.location.search)
  const surface = query.get('surface') === 'preview' ? 'preview' : 'files'
  const pendingGfsUri = query.get('gfsUri')
  const pendingFileDeepLink =
    query.get('deepLink') === '1' && pendingGfsUri ? { id: 1, uri: pendingGfsUri } : null
  const filesClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          ...desktopQueryDefaults,
          queries: { ...desktopQueryDefaults.queries, retry: false },
        },
      }),
    []
  )
  const previewClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          ...desktopQueryDefaults,
          queries: { ...desktopQueryDefaults.queries, retry: false },
        },
      }),
    []
  )

  useEffect(() => {
    const geometry = window.__permissionStatusFixtures
    if (!geometry) throw new Error('Permission geometry fixtures were not installed')
    window.__permissionStatusGeometry = {
      filesClient,
      previewClient,
      setPermissionMode: geometry.setPermissionMode,
      startAffordanceRefetch: (page, resourceId) => {
        const client = page === 'files' ? filesClient : previewClient
        const query = client
          .getQueryCache()
          .findAll()
          .find(
            candidate =>
              candidate.queryKey.includes('affordances') && candidate.queryKey.includes(resourceId)
          )
        if (!query) return false
        void client.refetchQueries({ exact: true, queryKey: query.queryKey })
        return true
      },
      settlePermission: geometry.settlePermission,
    }
    return () => {
      delete window.__permissionStatusGeometry
      filesClient.clear()
      previewClient.clear()
    }
  }, [filesClient, previewClient])

  return (
    <AuthContext.Provider value={authValue}>
      {surface === 'files' ? (
        <QueryClientProvider client={filesClient}>
          <FilesPage
            pendingGfsUri={pendingFileDeepLink ? null : pendingGfsUri}
            pendingGfsDeepLink={pendingFileDeepLink}
            isPendingGfsDeepLinkCurrent={() => true}
            onPendingGfsDeepLinkOutcome={() => undefined}
            onOpenPendingGfsPreview={() => true}
          />
        </QueryClientProvider>
      ) : (
        <QueryClientProvider client={previewClient}>
          <FilePreviewPage
            gfsUri="gfs://main/preview-file"
            fileName="diagram.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
        </QueryClientProvider>
      )}
    </AuthContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(<PermissionStatusGeometryHarness />)
