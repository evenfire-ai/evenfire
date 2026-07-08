'use client'

import React from 'react'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import RegistryApiKeysPanel from '@components/RegistryApiKeysPanel'

export default function RegistryKeysPage() {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <RegistryApiKeysPanel />
      </DashboardLayout>
    </AuthGate>
  )
}
