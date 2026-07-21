import React from 'react'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import type { CostShellProps } from './types'

// Shared shell for Cost & Usage list routes. Child-route navigation lives in
// the expandable sidebar group, so this shell owns only auth and page chrome.
export function CostShell({ children }: CostShellProps) {
  return (
    <AuthGate>
      <DashboardLayout>
        <div className="cu-cost-layout">{children}</div>
      </DashboardLayout>
    </AuthGate>
  )
}
