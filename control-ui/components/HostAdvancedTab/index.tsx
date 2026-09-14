'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataTable, TableViewport } from '@clerum/frontend-components'
import { HostApprovalSection } from '@components/HostApprovalSection'
import { HostEnvTable } from '@components/HostEnvTable'
import { HostGuardrailsSection } from '@components/HostGuardrailsSection'
import { TabBar } from '@components/TabBar'
import { GUARDRAIL_ENTRY_TYPE } from '@constants/marketplaceEntryTypes'
import { CONTROL_ROUTES } from '@constants/routes'
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
  onActionsChange,
}: HostAdvancedTabProps) {
  const router = useRouter()
  const [subTab, setSubTab] = useState<AdvancedSubTab>(DEFAULT_SUB_TAB)

  useEffect(() => {
    if (!onActionsChange || subTab !== 'hooks') return
    onActionsChange(
      <button
        type="button"
        className="cu-btn cu-btn--primary cu-btn--sm"
        onClick={() =>
          router.push(CONTROL_ROUTES.marketplace.orgEntriesFiltered({ type: GUARDRAIL_ENTRY_TYPE }))
        }
        disabled={busy}
      >
        Add hook
      </button>
    )
    return () => onActionsChange(null)
  }, [busy, onActionsChange, router, subTab])

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
              showAddAction={false}
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

        {subTab === 'env' && <HostEnvTable hostRef={hostName} onActionsChange={onActionsChange} />}
      </div>
    </section>
  )
}

function ApprovalToolsSkeleton() {
  return (
    <TableViewport className="cu-table-wrap" role="status" aria-label="Loading approval tools">
      <DataTable className="eft-table cu-table cu-table--header-band cu-table--static-rows">
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
      </DataTable>
    </TableViewport>
  )
}
