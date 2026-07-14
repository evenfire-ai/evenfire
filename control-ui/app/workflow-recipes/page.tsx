'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { RecipeEditor } from '@components/RecipeEditor'
import { RecipesTab } from '@components/RecipesTab'
import { IconWorkflow } from '@components/Sidebar/icons'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { isSilentApiError } from '@lib/api'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '@lib/authRedirect'
import { useRecipePolling } from '@lib/hooks/useRecipePolling'

export const dynamic = 'force-dynamic'

export default function WorkflowRecipesPage() {
  return (
    <Suspense
      fallback={
        <div className="cu-app-layout">
          <main className="cu-main">
            <div className="cu-card">
              <div className="cu-card__body">Loading…</div>
            </div>
          </main>
        </div>
      }
    >
      <WorkflowRecipesPageContent />
    </Suspense>
  )
}

function WorkflowRecipesPageContent() {
  const { authState } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [pageError, setPageError] = useState('')
  const [installerOpen, setInstallerOpen] = useState(false)
  const [installerStarting, setInstallerStarting] = useState(false)
  const installerTimerRef = useRef<number | null>(null)
  const { recipes, loading, error, refresh } = useRecipePolling({
    enabled: authState.isLoggedIn && !authState.isLoading,
    onError: fetchError => {
      if (!isSilentApiError(fetchError)) return
      setPageError('')
    },
  })
  const surfaceError = pageError || error

  // Legacy registry deep links now route through the registry install preview
  // so operators can review default-deny/public-web/exact-host egress first.
  useEffect(() => {
    if (!authState.isLoggedIn) return
    const entry = searchParams.get('registry')
    const version = searchParams.get('version')
    if (!entry || !version) return
    const params = new URLSearchParams()
    params.set('entry', entry)
    params.set('version', version)
    router.replace(`/registry/install?${params.toString()}`)
  }, [authState.isLoggedIn, searchParams, router])

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  useEffect(() => {
    if (!installerStarting) return
    // Keep the skeleton visible briefly so the install drawer transition can settle
    // before the heavier installer content renders, avoiding a one-frame layout flash.
    installerTimerRef.current = window.setTimeout(() => {
      setInstallerOpen(true)
      setInstallerStarting(false)
      installerTimerRef.current = null
    }, 120)
    return () => {
      if (installerTimerRef.current !== null) {
        window.clearTimeout(installerTimerRef.current)
        installerTimerRef.current = null
      }
    }
  }, [installerStarting])

  if (authState.isLoading) {
    return (
      <div className="cu-app-layout">
        <main className="cu-main">
          <div className="cu-card">
            <div className="cu-card__body">Loading…</div>
          </div>
        </main>
      </div>
    )
  }

  if (!authState.isLoggedIn) {
    return null
  }

  return (
    <DashboardLayout isDetailPage={installerOpen || installerStarting}>
      {installerStarting ? (
        <CreateFlowSkeleton
          {...CREATE_FLOW_LOADING.installPlugin}
          onBack={() => {
            setPageError('')
            setInstallerStarting(false)
          }}
          backDisabled={false}
        />
      ) : installerOpen ? (
        <RecipeEditor
          onSaved={() => {
            setPageError('')
            setInstallerOpen(false)
            void refresh()
          }}
          onCancel={() => {
            setPageError('')
            setInstallerOpen(false)
          }}
          pageHeader={
            <CreatePageHeader
              icon={<IconWorkflow />}
              title="Install Plugin"
              subtitle="Prepare a plugin manifest, validate policy, and deploy it."
              backLabel="Back to plugins"
              onBack={() => {
                setPageError('')
                setInstallerOpen(false)
              }}
            />
          }
        />
      ) : (
        <RecipesTab
          items={recipes}
          loading={loading}
          error={surfaceError}
          onInstall={() => {
            setPageError('')
            setInstallerStarting(true)
          }}
          onRefresh={refresh}
        />
      )}
    </DashboardLayout>
  )
}
