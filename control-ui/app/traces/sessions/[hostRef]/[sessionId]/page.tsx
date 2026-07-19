'use client'

import { useParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { SessionReplayDetail } from '@components/GovernedTraceSurface/SessionReplayDetail'

export default function SessionReplayDetailPage() {
  const params = useParams<{ hostRef: string; sessionId: string }>()
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <SessionReplayDetail
          hostRef={decodeURIComponent(params.hostRef)}
          sessionId={decodeURIComponent(params.sessionId)}
        />
      </DashboardLayout>
    </AuthGate>
  )
}
