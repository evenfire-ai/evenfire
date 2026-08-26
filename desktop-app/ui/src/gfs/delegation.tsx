import { useEffect, useRef, useState } from 'react'
import { Button, StatusBanner } from '@components/Common'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import { GfsPermissionDropdown } from '@/gfs/GfsPermissionDropdown'
import { GfsSubjectPicker } from '@/gfs/GfsSubjectPicker'
import type { GfsDelegationPanelProps } from './delegation.types'

/**
 * Managed (`1st:`) agents are server-capped to read/write
 * (`managed_agent_permission_forbidden`) — when the selection contains a host,
 * the dropdown never offers more, and any incompatible held bits are stripped.
 */
const HOST_PERMISSION_BITS = ['read', 'write'] as const

const HOST_SUBJECT_KEY_PREFIX = 'host:'

/**
 * P4-S07 — Desktop gfs delegation panel (renderer). A folder owner delegates
 * Layer-2/3 grants within its subtree. Presentational + affordance-driven: it
 * only SHOWS controls the caller can exercise (computed by delegationAffordances
 * in the main process and passed in). Enforcement is ALWAYS server-side
 * (control-api/gfsc) — hiding a control is usability, never the security boundary.
 *
 * Subjects are unified — people, teams, and the caller's own agents appear in a
 * single picker, mirroring Control UI. A bulk grant is atomic (all or none), so
 * when a host is part of the selection the whole grant is capped to the host
 * permission set (read/write) and stripped of anything else. Hosts cannot be
 * share recipients, so Create share is disabled while a host is selected.
 *
 * Composes the shared Common primitives through the GFS picker controls per the
 * desktop-app/ui frontend rules — no raw inputs/buttons.
 */

export function GfsDelegationPanel({
  affordances,
  subjectOptions,
  subjectOptionsLoading = false,
  subjectOptionsError = null,
  isDirectory,
  onGrant,
  onCreateShare,
  onCreateShareActionChange,
}: GfsDelegationPanelProps) {
  const [subjectKeys, setSubjectKeys] = useState<string[]>([])
  const [bits, setBits] = useState<string[]>(() =>
    affordances.grantableBits.includes('read') ? ['read'] : affordances.grantableBits.slice(0, 1)
  )
  const [inherit, setInherit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createShareActionRef = useRef<() => void>(() => undefined)

  const grantableBits = affordances.grantableBits
  const hasHost = subjectKeys.some(key => key.startsWith(HOST_SUBJECT_KEY_PREFIX))
  // Hosts cap the WHOLE bulk grant to read/write (the server enforces this per
  // host subject; the bulk request is atomic, so the cap applies to all). Also
  // keep the cap within the bits the caller actually holds.
  const visiblePermissionBits = hasHost
    ? HOST_PERMISSION_BITS.filter(bit => grantableBits.includes(bit))
    : grantableBits
  const canCreateShare =
    Boolean(onCreateShare && affordances.canCreateShare) &&
    !busy &&
    !hasHost &&
    subjectKeys.length > 0

  function changeSubjects(nextKeys: string[]) {
    setSubjectKeys(nextKeys)
    const nextHasHost = nextKeys.some(key => key.startsWith(HOST_SUBJECT_KEY_PREFIX))
    if (!nextHasHost) return
    // Drop any bit a host subject cannot receive so the bulk grant stays valid.
    const allowed: string[] = HOST_PERMISSION_BITS.filter(bit => grantableBits.includes(bit))
    setBits(current => {
      const filtered = current.filter(bit => allowed.includes(bit))
      return filtered.length === current.length ? current : filtered
    })
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

  createShareActionRef.current = () => {
    if (!onCreateShare || !canCreateShare) return
    void run(() => onCreateShare(subjectKeys))
  }

  useEffect(() => {
    if (!onCreateShareActionChange) return
    onCreateShareActionChange(() => createShareActionRef.current(), !canCreateShare)
    return () => onCreateShareActionChange(null, true)
  }, [canCreateShare, onCreateShareActionChange])

  // A Leader without manage_acl (canDelegate=false) sees no controls.
  if (!affordances.canDelegate) {
    return (
      <div className="da-gfs-delegation__empty" role="note">
        <strong>Read-only access</strong>
        <span>You do not have delegation rights on this folder.</span>
      </div>
    )
  }

  return (
    <div className="da-gfs-delegation">
      <div className="da-gfs-delegation__composer">
        <GfsSubjectPicker
          disabled={busy}
          loading={subjectOptionsLoading}
          onChange={changeSubjects}
          options={subjectOptions}
          value={subjectKeys}
        />
        <GfsPermissionDropdown
          disabled={busy}
          onChange={setBits}
          permissions={visiblePermissionBits}
          value={bits}
        />
      </div>
      {hasHost ? (
        <p className="da-gfs-delegation__hint muted">
          Agent selections are limited to read and write. Incompatible permissions were removed.
        </p>
      ) : null}
      {subjectOptionsError ? <StatusBanner tone="error" text={subjectOptionsError} /> : null}
      <div className="da-gfs-delegation__scope-actions">
        {isDirectory ? (
          <label className="da-gfs-delegation__inherit">
            <input
              checked={inherit}
              disabled={busy}
              onChange={event => setInherit(event.target.checked)}
              type="checkbox"
            />
            <span>Include contents of this folder</span>
          </label>
        ) : null}
        <div className="da-gfs-delegation__actions">
          <Button
            type="button"
            loading={busy}
            disabled={busy || subjectKeys.length === 0 || bits.length === 0}
            onClick={() => run(() => onGrant(subjectKeys, bits, isDirectory ? inherit : false))}
          >
            Grant access
          </Button>
        </div>
      </div>
      {error !== null && <StatusBanner tone="error" text={error} />}
    </div>
  )
}

export type {
  DelegationAffordances,
  GfsCreateShareActionChange,
  GfsAgentSubjectOption,
  GfsDelegationPanelProps,
  GfsDelegationSubjectOption,
  GfsDelegationSubjectType,
  GfsGrantListItem,
} from './delegation.types'
