'use client'

import React, { useState } from 'react'
import { HostApprovalSection } from '@components/HostApprovalSection'
import { HostEnvTable } from '@components/HostEnvTable'
import { TabBar } from '@components/TabBar'
import type { AdvancedSubTab, HostAdvancedTabProps } from './types'

const ADVANCED_SUB_TABS: { key: AdvancedSubTab; label: string }[] = [
  { key: 'approvals', label: 'Per-tool approval' },
  { key: 'env', label: 'Env vars' },
]

export function HostAdvancedTab({
  busy,
  hostName,
  initialLoading,
  initialTools,
  onSaveApprovalTools,
}: HostAdvancedTabProps) {
  const [subTab, setSubTab] = useState<AdvancedSubTab>('approvals')

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
        {subTab === 'approvals' ? (
          initialLoading ? null : (
            <HostApprovalSection
              busy={busy}
              canWrite
              defaultEditing
              initialTools={initialTools}
              onSave={onSaveApprovalTools}
            />
          )
        ) : (
          <HostEnvTable hostRef={hostName} />
        )}
      </div>
    </section>
  )
}
