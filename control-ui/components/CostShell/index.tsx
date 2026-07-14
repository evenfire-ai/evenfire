'use client'

import React from 'react'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { TabBar } from '@components/TabBar'
import { COST_TABS } from './constants'
import type { CostSegment, CostShellProps } from './types'

// Shared shell for the Cost & Usage section: sidebar + in-page tab navigation
// (Usage / LLM Prices / Token Budgets), driven by the active route segment.
// The section-root list pages render only their content; this shell owns the
// auth gate, dashboard chrome, and tab bar so every tab stays consistent.
export function CostShell({ activeSegment, children }: CostShellProps) {
  return (
    <AuthGate>
      <DashboardLayout>
        <div className="cu-cost-layout">
          <TabBar<CostSegment>
            ariaLabel="Cost and usage sections"
            activeValue={activeSegment}
            className="cu-tabs--flush"
            options={COST_TABS}
          />
          {children}
        </div>
      </DashboardLayout>
    </AuthGate>
  )
}
