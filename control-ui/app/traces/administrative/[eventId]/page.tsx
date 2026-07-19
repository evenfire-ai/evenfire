'use client'

import { useParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { AdministrativeEventDetail } from '@components/GovernedTraceSurface/AdministrativeEventDetail'

export default function AdministrativeEventDetailPage() {
  const params = useParams<{ eventId: string }>()
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <AdministrativeEventDetail eventId={decodeURIComponent(params.eventId)} />
      </DashboardLayout>
    </AuthGate>
  )
}
