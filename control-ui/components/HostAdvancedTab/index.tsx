'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { HostEnvTable } from '@components/HostEnvTable'
import { HostGuardrailsSection } from '@components/HostGuardrailsSection'
import { GUARDRAIL_MARKETPLACE_ROUTE } from '@components/HostGuardrailsSection/constants'
import { TabBar } from '@components/TabBar'
import { CONTROL_ROUTES } from '@constants/routes'
import type { AdvancedSubTab, HostAdvancedTabProps } from './types'

const ADVANCED_SUB_TABS: { key: AdvancedSubTab; label: string }[] = [
  { key: 'hooks', label: 'Hooks' },
  { key: 'env', label: 'Env vars' },
]

const DEFAULT_SUB_TAB: AdvancedSubTab = 'hooks'

export function HostAdvancedTab({
  busy,
  hostName,
  initialGuardrails,
  initialLoading,
  onSaveGuardrails,
  onActionsChange,
}: HostAdvancedTabProps) {
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const [subTab, setSubTab] = useState<AdvancedSubTab>(DEFAULT_SUB_TAB)

  useEffect(() => {
    if (!onActionsChange || initialLoading || subTab !== 'hooks') return
    onActionsChange(
      <button
        type="button"
        className="cu-btn cu-btn--primary cu-btn--sm"
        onClick={() => routerRef.current.push(GUARDRAIL_MARKETPLACE_ROUTE)}
        disabled={busy}
      >
        Add hook
      </button>
    )
    return () => onActionsChange(null)
  }, [busy, initialLoading, onActionsChange, subTab])

  return (
    <section className="cu-advanced-tab" aria-label="Advanced">
      <TabBar<AdvancedSubTab>
        activeValue={subTab}
        ariaLabel="Advanced settings"
        className="cu-tabs--compact cu-advanced-tabs"
        onChange={setSubTab}
        options={ADVANCED_SUB_TABS.map(tab => ({ label: tab.label, value: tab.key }))}
      />

      <p className="cu-muted">
        Per-tool approval moved to the{' '}
        <Link href={CONTROL_ROUTES.agents.tab(hostName, 'approval-settings')}>Approvals tab</Link>.
      </p>

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

        {subTab === 'env' && <HostEnvTable hostRef={hostName} onActionsChange={onActionsChange} />}
      </div>
    </section>
  )
}
