'use client'

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataTable } from '@clerum/frontend-table-system'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { GUARDRAIL_ENTRY_TYPE } from '@constants/marketplaceEntryTypes'
import { CONTROL_ROUTES } from '@constants/routes'
import { GUARDRAIL_PHASES, GUARDRAIL_PHASE_LABELS } from './constants'
import type { GuardrailHookRow, HostGuardrails, HostGuardrailsSectionProps } from './types'

// Add hook lands on the org marketplace entries list, narrowed to guardrail
// hooks — the unfiltered list mixes in every connector and plugin the org has
// published, which is not what someone adding a hook is looking for.
const ADD_HOOK_ROUTE = CONTROL_ROUTES.marketplace.orgEntriesFiltered({
  type: GUARDRAIL_ENTRY_TYPE,
})

// Every field this section does not edit rides along untouched — dropping
// `builtins` or `limits` here would silently wipe them from the Host spec.
function withHooks(
  source: HostGuardrails | undefined,
  hooks: HostGuardrails['hooks']
): HostGuardrails {
  return { ...source, hooks }
}

export function HostGuardrailsSection({
  initialGuardrails,
  onSave,
  busy,
  canWrite,
}: HostGuardrailsSectionProps) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const mountedRef = useRef(true)

  const [saving, setSaving] = useState(false)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const rows = useMemo<GuardrailHookRow[]>(() => {
    const hooks = initialGuardrails?.hooks ?? {}
    return GUARDRAIL_PHASES.flatMap(phase => (hooks[phase] ?? []).map(ref => ({ phase, ref })))
  }, [initialGuardrails])

  const persist = useCallback(
    async (nextHooks: HostGuardrails['hooks'], successMessage: string) => {
      setSaving(true)
      try {
        await onSave(withHooks(initialGuardrails, nextHooks))
        if (mountedRef.current) showToast(successMessage, { tone: 'success' })
      } catch {
        // The parent already surfaced the error/conflict banner.
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [initialGuardrails, onSave, showToast]
  )

  async function removeHook(row: GuardrailHookRow) {
    const shouldRemove = await confirm({
      title: 'Remove guardrail hook',
      message: `Remove ${row.ref.id} from ${GUARDRAIL_PHASE_LABELS[row.phase]} on this agent? The hook stays installed on the cluster.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!shouldRemove) return

    const currentRefs = initialGuardrails?.hooks?.[row.phase] ?? []
    const nextRefs = currentRefs.filter(ref => ref.id !== row.ref.id)
    const nextHooks: HostGuardrails['hooks'] = { ...(initialGuardrails?.hooks ?? {}) }
    if (nextRefs.length > 0) nextHooks[row.phase] = nextRefs
    else delete nextHooks[row.phase]

    await persist(nextHooks, `${row.ref.id} removed from this agent.`)
  }

  const disabled = busy || saving

  return (
    <section aria-label="Hooks">
      <div className="cu-access-section">
        <div className="cu-access-section__header">
          <p className="cu-muted cu-access-section__description">
            Guardrail hooks installed on the cluster and referenced by this agent.
          </p>
          {canWrite ? (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => router.push(ADD_HOOK_ROUTE)}
              disabled={disabled}
            >
              Add hook
            </button>
          ) : null}
        </div>

        <div className="eft-table-viewport cu-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band">
            <thead>
              <tr>
                <th>Hook</th>
                <th>Phase</th>
                <th className="cu-table__col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="cu-empty">
                    No guardrail hooks on this agent yet.
                  </td>
                </tr>
              ) : (
                rows.map(row => (
                  <tr key={`${row.phase}:${row.ref.id}`}>
                    <td>
                      <button
                        type="button"
                        className="cu-link"
                        title={row.ref.digest ? `digest ${row.ref.digest}` : undefined}
                        onClick={() => router.push(CONTROL_ROUTES.guardrails.detail(row.ref.id))}
                      >
                        {row.ref.id}
                      </button>
                    </td>
                    <td>{GUARDRAIL_PHASE_LABELS[row.phase]}</td>
                    <td className="cu-table__cell-actions">
                      <div className="cu-row-actions">
                        {canWrite ? (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => void removeHook(row)}
                            disabled={disabled}
                            title="Remove"
                            aria-label={`Remove hook ${row.ref.id} from ${GUARDRAIL_PHASE_LABELS[row.phase]}`}
                          >
                            <IconX width={16} height={16} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </div>

      {confirmDialog}
    </section>
  )
}
