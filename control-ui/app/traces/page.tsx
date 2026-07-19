'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { SessionReplay } from '@components/GovernedTraceSurface/SessionReplay'

export default function TracesPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <SessionReplay />
      </DashboardLayout>
    </AuthGate>
  )
}
