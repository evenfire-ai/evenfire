'use client'

import { useParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { GovernedTraceSurface } from '@components/GovernedTraceSurface'

export default function HostTraceReplayPage() {
  const params = useParams<{ hostRef: string; runId: string }>()
  const hostRef = decodeURIComponent(params.hostRef)
  const runId = decodeURIComponent(params.runId)

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <GovernedTraceSurface
          detail
          family="agent_run"
          readPath={`/api/v1/admin/tracing/hosts/${encodeURIComponent(hostRef)}/runs/${encodeURIComponent(runId)}`}
          subtitle={`Host ${hostRef} · run ${runId}`}
          title="Host run replay"
        />
      </DashboardLayout>
    </AuthGate>
  )
}
