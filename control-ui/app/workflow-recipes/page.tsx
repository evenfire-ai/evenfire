'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { RecipeEditor } from '@components/RecipeEditor'
import { RecipesTab } from '@components/RecipesTab'
import { IconWorkflow } from '@components/Sidebar/icons'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import { isSilentApiError } from '@lib/api'
import { useRecipePolling } from '@lib/hooks/useRecipePolling'

export const dynamic = 'force-dynamic'

export default function WorkflowRecipesPage() {
  return (
    <Suspense fallback={<WorkflowRecipesLoading />}>
      <WorkflowRecipesPageContent />
    </Suspense>
  )
}

function WorkflowRecipesLoading() {
  return (
    <DashboardLayout>
      <RecipesTab
        items={[]}
        loading
        error=""
        onInstall={() => undefined}
        onRefresh={() => undefined}
      />
    </DashboardLayout>
  )
}

function WorkflowRecipesPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [pageError, setPageError] = useState('')
  const [installerOpen, setInstallerOpen] = useState(false)
  const [installerStarting, setInstallerStarting] = useState(false)
  const installerTimerRef = useRef<number | null>(null)
  const { recipes, loading, error, refresh } = useRecipePolling({
    enabled: true,
    onError: fetchError => {
      if (!isSilentApiError(fetchError)) return
      setPageError('')
    },
  })
  const surfaceError = pageError || error

  // Legacy registry deep links now route through the registry install preview
  // so operators can review default-deny/public-web/exact-host egress first.
  useEffect(() => {
    const entry = searchParams.get('registry')
    const version = searchParams.get('version')
    if (!entry || !version) return
    const params = new URLSearchParams()
    params.set('entry', entry)
    params.set('version', version)
    router.replace(CONTROL_ROUTES.marketplace.install(Object.fromEntries(params)))
  }, [searchParams, router])

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
