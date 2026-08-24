'use client'

import React, { useState } from 'react'
import { HostApprovalSection } from '@components/HostApprovalSection'
import { HostEnvTable } from '@components/HostEnvTable'
import { HostGuardrailsSection } from '@components/HostGuardrailsSection'
import { TabBar } from '@components/TabBar'
import type { AdvancedSubTab, HostAdvancedTabProps } from './types'

const ADVANCED_SUB_TABS: { key: AdvancedSubTab; label: string }[] = [
  { key: 'hooks', label: 'Hooks' },
  { key: 'approvals', label: 'Per-tool approval' },
  { key: 'env', label: 'Env vars' },
]

const DEFAULT_SUB_TAB: AdvancedSubTab = 'hooks'

export function HostAdvancedTab({
  busy,
  hostName,
  initialGuardrails,
  initialLoading,
  initialTools,
  onSaveApprovalTools,
  onSaveGuardrails,
}: HostAdvancedTabProps) {
  const [subTab, setSubTab] = useState<AdvancedSubTab>(DEFAULT_SUB_TAB)

  return (
    <section className="cu-advanced-tab" aria-label="Advanced">
      <TabBar<AdvancedSubTab>
        activeValue={subTab}
        ariaLabel="Advanced settings"
        className="cu-tabs--compact cu-advanced-tabs"
        onChange={setSubTab}
        options={ADVANCED_SUB_TABS.map(tab => ({ label: tab.label, value: tab.key }))}
      />

      <div className="cu-advanced-section">
        {subTab === 'hooks' &&
          (initialLoading ? (
            <div className="cu-empty" role="status" aria-label="Loading guardrail hooks">
              Loading…
            </div>
          ) : (
            <HostGuardrailsSection
              busy={busy}
              canWrite={
                true /* TODO: wire to actual host:write check if/when per-field RBAC lands */
              }
              initialGuardrails={initialGuardrails}
              onSave={onSaveGuardrails}
            />
          ))}

        {subTab === 'approvals' &&
          (initialLoading ? (
            <ApprovalToolsSkeleton />
          ) : (
            <HostApprovalSection
              busy={busy}
              canWrite
              defaultEditing
              initialTools={initialTools}
              onSave={onSaveApprovalTools}
            />
          ))}

        {subTab === 'env' && <HostEnvTable hostRef={hostName} />}
      </div>
    </section>
  )
}

function ApprovalToolsSkeleton() {
  return (
    <div className="cu-table-wrap" role="status" aria-label="Loading approval tools">
      <table className="cu-table cu-table--header-band cu-table--static-rows">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Default</th>
            <th className="cu-table__col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4].map(i => (
            <tr key={i}>
              <td>
                <div className="cu-skeleton cu-skeleton--cell" style={{ width: '8rem' }} />
              </td>
              <td>
                <div className="cu-skeleton cu-skeleton--cell" style={{ width: '6rem' }} />
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
