'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { DashboardLayout } from '@components/DashboardLayout'
import { LoadingScreen } from '@components/LoadingScreen'
import { RecipesTab } from '@components/RecipesTab'
import { CONTROL_ROUTES } from '@constants/routes'
import { isSilentApiError } from '@lib/api'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '@lib/authRedirect'
import { useRecipePolling } from '@lib/hooks/useRecipePolling'

export const dynamic = 'force-dynamic'

export default function WorkflowRecipesPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <WorkflowRecipesPageContent />
    </Suspense>
  )
}

function WorkflowRecipesPageContent() {
  const { authState } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [pageError, setPageError] = useState('')
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
    router.replace(CONTROL_ROUTES.marketplace.install(Object.fromEntries(params)))
  }, [authState.isLoggedIn, searchParams, router])

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  if (authState.isLoading) {
    return <LoadingScreen />
  }

  if (!authState.isLoggedIn) {
    return null
  }

  return (
    <DashboardLayout>
      <RecipesTab
        items={recipes}
        loading={loading}
        error={surfaceError}
        onInstall={() => router.push(CONTROL_ROUTES.marketplace.org)}
        onRefresh={refresh}
      />
    </DashboardLayout>
  )
}
