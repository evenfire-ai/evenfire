'use client'

import { useParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { InfrastructureEventDetail } from '@components/GovernedTraceSurface/InfrastructureEventDetail'

export default function InfrastructureEventDetailPage() {
  const params = useParams<{ eventId: string }>()
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <InfrastructureEventDetail eventId={decodeURIComponent(params.eventId)} />
      </DashboardLayout>
    </AuthGate>
  )
}
