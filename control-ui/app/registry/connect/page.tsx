'use client'

import React from 'react'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import RegistryConnectPanel from '@components/RegistryConnectPanel'

export default function RegistryConnectPage() {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <RegistryConnectPanel />
      </DashboardLayout>
    </AuthGate>
  )
}
