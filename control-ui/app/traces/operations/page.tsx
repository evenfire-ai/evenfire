'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { TracingOperations } from '@components/GovernedTraceSurface/TracingOperations'

export default function TracingOperationsPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <TracingOperations />
      </DashboardLayout>
    </AuthGate>
  )
}
