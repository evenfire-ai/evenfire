'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { GfsBrowser } from '@components/GfsBrowser'

/**
 * Operator Global File System browser + delegation. Canonical App Router path
 * (/global-file-system) — no ?tab= or ad-hoc query keys for routing (project UI rule).
 * Auth-gated like every other operator route section.
 */
export default function GfsPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <GfsBrowser />
      </DashboardLayout>
    </AuthGate>
  )
}
