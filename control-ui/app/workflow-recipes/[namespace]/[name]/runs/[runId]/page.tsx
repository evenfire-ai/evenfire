'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { BodyLoadingSkeleton } from '@components/BodyLoadingSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { RecipeStatusContent } from '@components/RecipeStatusContent'
import { IconWorkflow } from '@components/Sidebar/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'

export const dynamic = 'force-dynamic'

export default function WorkflowRunDetailPage() {
  return (
    <Suspense
      fallback={
        <BodyLoadingSkeleton
          backLabel="Back to plugin"
          icon={<IconWorkflow />}
          primaryActionLabel="Open governed trace replay"
          sections={3}
          subtitle="Plugin run status, outputs, artifacts, and access."
          title="Plugin run"
        />
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
    router.push(CONTROL_ROUTES.plugins.detail(namespace, name))
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
                href={CONTROL_ROUTES.plugins.root}
                style={{ color: 'var(--cu-text-soft)', textDecoration: 'underline' }}
              >
                Plugins
              </Link>
              {' / '}
              <Link
                href={CONTROL_ROUTES.plugins.detail(namespace, name)}
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
        <div className="cu-workflow-run-trace-link">
          <Link href={CONTROL_ROUTES.traces.workflowRun(namespace, name, runId)}>
            Open governed trace replay
          </Link>
        </div>
        <RecipeStatusContent name={name} namespace={namespace} runId={runId} />
      </DashboardLayout>
    </AuthGate>
  )
}
