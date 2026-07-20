'use client'

import { useParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { GovernedTraceSurface } from '@components/GovernedTraceSurface'
import { WorkflowApprovalHistory } from '@components/GovernedTraceSurface/WorkflowApprovalHistory'

export default function WorkflowTraceReplayPage() {
  const params = useParams<{ namespace: string; name: string; runId: string }>()
  const namespace = decodeURIComponent(params.namespace)
  const name = decodeURIComponent(params.name)
  const runId = decodeURIComponent(params.runId)

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <GovernedTraceSurface
          detail
          detailAddon={<WorkflowApprovalHistory namespace={namespace} name={name} runId={runId} />}
          family="agent_run"
          readPath={`/api/v1/admin/tracing/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}`}
          subtitle={`Workflow ${namespace}/${name} · run ${runId}`}
          title="Workflow run replay"
        />
      </DashboardLayout>
    </AuthGate>
  )
}
