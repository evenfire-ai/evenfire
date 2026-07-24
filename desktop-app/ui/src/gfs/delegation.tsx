import { useState } from 'react'
import { Button, StatusBanner } from '@components/Common'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import { GfsPermissionDropdown } from '@/gfs/GfsPermissionDropdown'
import { GfsSubjectPicker } from '@/gfs/GfsSubjectPicker'
import type { GfsDelegationPanelProps } from './delegation.types'

/**
 * P4-S07 — Desktop gfs delegation panel (renderer). A folder owner delegates
 * Layer-2/3 grants within its subtree. Presentational + affordance-driven: it
 * only SHOWS controls the caller can exercise (computed by delegationAffordances
 * in the main process and passed in). Enforcement is ALWAYS server-side
 * (control-api/gfsc) — hiding a control is usability, never the security boundary.
 *
 * Composes the shared Common primitives through the GFS picker controls per the
 * desktop-app/ui frontend rules — no raw inputs/buttons.
 */

export function GfsDelegationPanel({
  affordances,
  subjectOptions,
  subjectOptionsLoading = false,
  subjectOptionsError = null,
  onGrant,
  onCreateShare,
}: GfsDelegationPanelProps) {
  const [subjectKeys, setSubjectKeys] = useState<string[]>([])
  const [bits, setBits] = useState<string[]>(() =>
    affordances.grantableBits.includes('read') ? ['read'] : affordances.grantableBits.slice(0, 1)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A Leader without manage_acl (canDelegate=false) sees no controls.
  if (!affordances.canDelegate) {
    return (
      <div className="da-gfs-delegation__empty" role="note">
        <strong>Read-only access</strong>
        <span>You do not have delegation rights on this folder.</span>
      </div>
    )
  }

  async function run(action: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      setSubjectKeys([])
    } catch (e) {
      // The bulk grant/share is atomic — a failure means NONE of the subjects
      // landed, so keep the whole selection for a retry. Surface the server's
      // verdict (escalation_rejected, subjects_invalid with 1-based positions, a
      // rate-limit retry, …) via the shared presentation map — never swallow it.
      setError(describeGfsGrantError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="da-gfs-delegation">
      <div className="da-gfs-delegation__composer">
        <GfsSubjectPicker
          disabled={busy}
          loading={subjectOptionsLoading}
          onChange={setSubjectKeys}
          options={subjectOptions}
          value={subjectKeys}
        />
        <GfsPermissionDropdown
          disabled={busy}
          onChange={setBits}
          permissions={affordances.grantableBits}
          value={bits}
        />
      </div>
      {subjectOptionsError ? <StatusBanner tone="error" text={subjectOptionsError} /> : null}
      <div className="da-gfs-delegation__actions">
        <Button
          type="button"
          loading={busy}
          disabled={busy || subjectKeys.length === 0 || bits.length === 0}
          onClick={() => run(() => onGrant(subjectKeys, bits))}
        >
          Grant access
        </Button>
        {affordances.canCreateShare && onCreateShare && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || subjectKeys.length === 0}
            onClick={() => run(() => onCreateShare(subjectKeys))}
          >
            Create share
          </Button>
        )}
      </div>
      {error !== null && <StatusBanner tone="error" text={error} />}
    </div>
  )
}

export type {
  DelegationAffordances,
  GfsAgentSubjectOption,
  GfsDelegationPanelProps,
  GfsDelegationSubjectOption,
  GfsDelegationSubjectType,
  GfsGrantListItem,
} from './delegation.types'
