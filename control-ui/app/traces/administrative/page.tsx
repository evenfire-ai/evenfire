'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { GovernedEventExplorer } from '@components/GovernedTraceSurface/GovernedEventExplorer'

export default function AdministrativeTracesPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <GovernedEventExplorer
          family="administrative"
          subtitle="Operator actions, permission changes, approval targets, and affected users."
          title="Administrative events"
        />
      </DashboardLayout>
    </AuthGate>
  )
}
