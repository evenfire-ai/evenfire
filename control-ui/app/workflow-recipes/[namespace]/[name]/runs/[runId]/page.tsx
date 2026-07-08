'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { RecipeStatusContent } from '@components/RecipeStatusContent'
import { IconWorkflow } from '@components/Sidebar/icons'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'

export const dynamic = 'force-dynamic'

export default function WorkflowRunDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="cu-app-layout">
          <main className="cu-main cu-detail-layout">
            <div className="cu-card">
              <div className="cu-card__body">Loading…</div>
            </div>
          </main>
        </div>
      }
    >
      <WorkflowRunDetailContent />
    </Suspense>
  )
}

function WorkflowRunDetailContent() {
  const router = useRouter()
  const params = useParams<{ namespace: string; name: string; runId: string }>()
  const namespace = decodeURIComponent(params?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE)
  const name = decodeURIComponent(params?.name ?? '')
  const runId = decodeURIComponent(params?.runId ?? '')

  function backToRecipe() {
    router.push(`/workflow-recipes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`)
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreatePageHeader
          icon={<IconWorkflow />}
          title={`Run ${runId.slice(0, 8)}`}
          subtitle={
            <>
              <Link
                href="/workflow-recipes"
                style={{ color: 'var(--cu-text-soft)', textDecoration: 'underline' }}
              >
                Plugins
              </Link>
              {' / '}
              <Link
                href={`/workflow-recipes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`}
                style={{ color: 'var(--cu-text-soft)', textDecoration: 'underline' }}
              >
                {name}
              </Link>
              {' / '}
              <span>Run {runId.slice(0, 8)}</span>
            </>
          }
          backLabel="Back to plugin"
          onBack={backToRecipe}
        />
        <RecipeStatusContent name={name} namespace={namespace} runId={runId} />
      </DashboardLayout>
    </AuthGate>
  )
}
