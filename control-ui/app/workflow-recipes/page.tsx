'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { DashboardLayout } from '@components/DashboardLayout'
import { RecipesTab } from '@components/RecipesTab'
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

  return (
    <DashboardLayout>
      <RecipesTab
        items={recipes}
        loading={loading}
        error={surfaceError}
        onInstall={() => router.push(CONTROL_ROUTES.marketplace.orgEntries)}
        onRefresh={refresh}
      />
    </DashboardLayout>
  )
}
