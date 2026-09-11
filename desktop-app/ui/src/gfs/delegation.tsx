import { useEffect, useState } from 'react'
import { Button, DropdownSelect, StatusBanner } from '@components/Common'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import { GfsSubjectPicker } from '@/gfs/GfsSubjectPicker'
import type { GfsDelegationPanelProps } from './delegation.types'

/**
 * Managed (`1st:`) agents are server-capped to read/write
 * (`managed_agent_permission_forbidden`) — when the selection contains a host,
 * the dropdown never offers more, and any incompatible held bits are stripped.
 */
const HOST_SUBJECT_KEY_PREFIX = 'host:'
type AccessRole = 'read' | 'editor'

const ROLE_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'editor', label: 'Editor' },
]

function permissionsForRole(
  role: AccessRole,
  hostOnly: boolean,
  grantableBits: string[]
): string[] {
  const requested = hostOnly
    ? role === 'editor'
      ? ['read', 'write']
      : ['read']
    : role === 'editor'
      ? ['read', 'write', 'delete', 'manage_acl', 'share']
      : ['read', 'share']
  return requested.filter(permission => grantableBits.includes(permission))
}

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
 * permission set (read/write) and stripped of anything else.
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
  onDetailViewChange,
}: GfsDelegationPanelProps) {
  const [subjectKeys, setSubjectKeys] = useState<string[]>([])
  const [role, setRole] = useState<AccessRole>('read')
  const [inherit, setInherit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grantableBits = affordances.grantableBits
  const hasHost = subjectKeys.some(key => key.startsWith(HOST_SUBJECT_KEY_PREFIX))
  // Hosts cap the WHOLE bulk grant to read/write (the server enforces this per
  // host subject; the bulk request is atomic, so the cap applies to all). Also
  // keep the cap within the bits the caller actually holds.
  const bits = permissionsForRole(role, hasHost, grantableBits)
  const canOfferEditor = (hasHost ? ['write'] : ['write', 'delete', 'manage_acl']).some(bit =>
    grantableBits.includes(bit)
  )
  const roleOptions = canOfferEditor ? ROLE_OPTIONS : ROLE_OPTIONS.slice(0, 1)

  useEffect(() => {
    onDetailViewChange?.(subjectKeys.length > 0)
  }, [onDetailViewChange, subjectKeys.length])

  function changeSubjects(nextKeys: string[]) {
    setSubjectKeys(nextKeys)
  }

  async function run(action: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      setSubjectKeys([])
      setRole('read')
    } catch (e) {
      // The bulk grant is atomic — a failure means NONE of the subjects landed,
      // so keep the whole selection for a retry. Surface the server's
      // verdict (escalation_rejected, subjects_invalid with 1-based positions, a
      // rate-limit retry, …) via the shared presentation map — never swallow it.
      setError(describeGfsGrantError(e).message)
    } finally {
      setBusy(false)
    }
  }

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
    <div
      className={`da-gfs-delegation${subjectKeys.length > 0 ? ' da-gfs-delegation--details' : ''}`}
    >
      <div className="da-gfs-delegation__composer">
        <GfsSubjectPicker
          disabled={busy}
          loading={subjectOptionsLoading}
          onChange={changeSubjects}
          options={subjectOptions}
          value={subjectKeys}
        />
        {subjectKeys.length > 0 ? (
          <DropdownSelect
            ariaLabel="Access role for selected recipients"
            disabled={busy}
            onChange={value => setRole(value as AccessRole)}
            options={roleOptions}
            placeholder="Role"
            value={role}
          />
        ) : null}
      </div>
      {subjectKeys.length > 0 && hasHost ? (
        <p className="da-gfs-delegation__hint muted">
          Agents, workflows, and plugins use read/write access only.
        </p>
      ) : null}
      {subjectOptionsError ? <StatusBanner tone="error" text={subjectOptionsError} /> : null}
      {subjectKeys.length > 0 ? (
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
              disabled={busy}
              onClick={() => {
                setSubjectKeys([])
                setRole('read')
              }}
              type="button"
              variant="ghost"
            >
              Back
            </Button>
            <Button
              type="button"
              loading={busy}
              disabled={busy || bits.length === 0}
              onClick={() => run(() => onGrant(subjectKeys, bits, isDirectory ? inherit : false))}
            >
              Share
            </Button>
          </div>
        </div>
      ) : null}
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
