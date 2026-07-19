'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { GovernedEventExplorer } from '@components/GovernedTraceSurface/GovernedEventExplorer'

export default function InfrastructureTracesPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <GovernedEventExplorer
          family="infrastructure_telemetry"
          subtitle="Controller lifecycle, health, reconcile, capacity, and usage facts."
          title="Infrastructure telemetry"
        />
      </DashboardLayout>
    </AuthGate>
  )
}
