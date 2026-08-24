'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { SelectionModal } from '@components/SelectionModal'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { GUARDRAIL_ENTRY_TYPE } from '@constants/marketplaceEntryTypes'
import { CONTROL_ROUTES } from '@constants/routes'
import { type LlmHookResource, getLlmHooks } from '@lib/api'
import { GUARDRAIL_PHASES, GUARDRAIL_PHASE_LABELS } from './constants'
import type {
  GuardrailHookRef,
  GuardrailHookRow,
  GuardrailPhase,
  HostGuardrails,
  HostGuardrailsSectionProps,
} from './types'

// The picker only offers hooks already installed on the cluster, so keep the
// route that installs new ones reachable from the section itself — it is the
// path the old "Add hook" button used to take.
const INSTALL_HOOK_ROUTE = CONTROL_ROUTES.marketplace.orgEntriesFiltered({
  type: GUARDRAIL_ENTRY_TYPE,
})

// The phases an installed hook declares it runs at. A hook is attached to every
// phase it declares, so the operator picks the hook and never the phase.
function hookPhases(hook: LlmHookResource): GuardrailPhase[] {
  const raw = (hook.spec as { lifecyclePoints?: unknown } | undefined)?.lifecyclePoints
  if (!Array.isArray(raw)) return []
  return raw.filter((point): point is GuardrailPhase =>
    GUARDRAIL_PHASES.includes(point as GuardrailPhase)
  )
}

function hookName(hook: LlmHookResource): string {
  return hook.metadata?.name ?? ''
}

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

  const [installedHooks, setInstalledHooks] = useState<LlmHookResource[]>([])
  const [showAddHook, setShowAddHook] = useState(false)
  const [selectedHookNames, setSelectedHookNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The installed LlmHooks are the pool this agent can reference. A load
  // failure only empties the picker — the rows below come from the Host spec
  // and stay readable either way.
  useEffect(() => {
    void (async () => {
      try {
        const result = await getLlmHooks()
        if (!mountedRef.current) return
        setInstalledHooks(Array.isArray(result.items) ? result.items : [])
      } catch {
        if (mountedRef.current) setInstalledHooks([])
      }
    })()
  }, [])

  const rows = useMemo<GuardrailHookRow[]>(() => {
    const hooks = initialGuardrails?.hooks ?? {}
    return GUARDRAIL_PHASES.flatMap(phase => (hooks[phase] ?? []).map(ref => ({ phase, ref })))
  }, [initialGuardrails])

  const referencedIds = useMemo(() => new Set(rows.map(row => row.ref.id)), [rows])

  const addOptions = useMemo(
    () =>
      installedHooks
        .filter(hook => hookName(hook) && !referencedIds.has(hookName(hook)))
        .map(hook => {
          const phases = hookPhases(hook)
          return {
            value: hookName(hook),
            label: hookName(hook),
            description: phases.length
              ? phases.map(phase => GUARDRAIL_PHASE_LABELS[phase]).join(' · ')
              : 'No lifecycle points declared',
          }
        }),
    [installedHooks, referencedIds]
  )

  const persist = useCallback(
    async (nextHooks: HostGuardrails['hooks'], successMessage: string) => {
      setSaving(true)
      try {
        await onSave(withHooks(initialGuardrails, nextHooks))
        if (mountedRef.current) showToast(successMessage, { tone: 'success' })
        return true
      } catch {
        // The parent already surfaced the error/conflict banner.
        return false
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [initialGuardrails, onSave, showToast]
  )

  async function addSelectedHooks() {
    const chosen = installedHooks.filter(hook => selectedHookNames.includes(hookName(hook)))
    const nextHooks: HostGuardrails['hooks'] = { ...(initialGuardrails?.hooks ?? {}) }

    for (const hook of chosen) {
      const id = hookName(hook)
      // Pin the digest the cluster actually reconciled, matching how existing
      // references are stored. An unpinned reference would float across hook
      // image updates.
      const ref: GuardrailHookRef = { id }
      const digest = hook.status?.observedDigest
      if (digest) ref.digest = digest

      for (const phase of hookPhases(hook)) {
        nextHooks[phase] = [...(nextHooks[phase] ?? []), ref]
      }
    }

    const added = chosen.length
    const ok = await persist(
      nextHooks,
      added === 1 ? `${hookName(chosen[0])} added to this agent.` : `${added} hooks added.`
    )
    if (ok && mountedRef.current) {
      setSelectedHookNames([])
      setShowAddHook(false)
    }
  }

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
    <section className="cu-guardrails-tab" aria-label="Hooks">
      <div className="cu-access-section">
        <div className="cu-access-section__header">
          <p className="cu-muted cu-access-section__description">
            Guardrail hooks installed on the cluster and referenced by this agent.{' '}
            <a className="cu-link" href={INSTALL_HOOK_ROUTE}>
              Browse the Marketplace
            </a>{' '}
            to install more.
          </p>
          {canWrite ? (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowAddHook(true)}
              disabled={disabled}
            >
              Add hook
            </button>
          ) : null}
        </div>

        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
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
          </table>
        </div>
      </div>

      {showAddHook ? (
        <SelectionModal
          busy={disabled}
          emptyLabel="No installed guardrail hooks are available."
          id="agent-hook-picker"
          label="Hooks"
          onChange={setSelectedHookNames}
          onClose={() => {
            setSelectedHookNames([])
            setShowAddHook(false)
          }}
          onConfirm={addSelectedHooks}
          options={addOptions}
          placeholder="Select hooks"
          searchPlaceholder="Search hooks..."
          selectionLabel="Selected hooks"
          submitLabel={selectedHookNames.length > 1 ? 'Add hooks' : 'Add hook'}
          title="Add hook"
          titleId="add-hook-title"
          value={selectedHookNames}
        />
      ) : null}

      {confirmDialog}
    </section>
  )
}
