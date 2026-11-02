import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Select } from 'antd'
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
 * Ant Design owns this panel's controls while these local state and callbacks
 * continue to own the grant behavior.
 */

export function GfsDelegationPanel({
  affordances,
  subjectOptions,
  subjectOptionsLoading = false,
  subjectOptionsError = null,
  permissionPending = false,
  permissionError = null,
  permissionCheckPending = false,
  permissionCheckFailed = false,
  isDirectory,
  onGrant,
  onDetailViewChange,
}: GfsDelegationPanelProps) {
  const [subjectKeys, setSubjectKeys] = useState<string[]>([])
  const [role, setRole] = useState<AccessRole | null>('read')
  const [roleNeedsSelection, setRoleNeedsSelection] = useState(false)
  const [inherit, setInherit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grantableBits = affordances.grantableBits
  const hasHost = subjectKeys.some(key => key.startsWith(HOST_SUBJECT_KEY_PREFIX))
  // Hosts cap the WHOLE bulk grant to read/write (the server enforces this per
  // host subject; the bulk request is atomic, so the cap applies to all). Also
  // keep the cap within the bits the caller actually holds.
  const bits = role === null ? [] : permissionsForRole(role, hasHost, grantableBits)
  const canOfferEditor = (hasHost ? ['write'] : ['write', 'delete', 'manage_acl']).some(bit =>
    grantableBits.includes(bit)
  )
  const checkPending = permissionPending || permissionCheckPending
  const checkFailed = Boolean(permissionError) || permissionCheckFailed
  const permissionUnavailable = checkPending || checkFailed || !affordances.canDelegate
  const roleOptions =
    canOfferEditor || ((checkPending || checkFailed) && role === 'editor')
      ? ROLE_OPTIONS
      : ROLE_OPTIONS.slice(0, 1)
  const permissionMessage = checkPending
    ? 'Checking permissions…'
    : permissionError
      ? `Could not verify sharing permissions: ${permissionError}`
      : permissionCheckFailed
        ? null
        : !affordances.canDelegate && subjectKeys.length > 0
          ? 'Your sharing permission changed. Your edits are preserved, but cannot be submitted.'
          : null

  const permissionDenied = !affordances.canDelegate && !checkPending && !checkFailed
  const draftGenerationRef = useRef(0)
  const wasPermissionDeniedRef = useRef(permissionDenied)

  useLayoutEffect(() => {
    if (permissionDenied && !wasPermissionDeniedRef.current) {
      draftGenerationRef.current += 1
    }
    wasPermissionDeniedRef.current = permissionDenied
  }, [permissionDenied])

  useLayoutEffect(() => {
    const roleStillOffered = role === 'read' || (role === 'editor' && canOfferEditor)
    if (role !== null && !roleStillOffered && !permissionDenied && !checkPending && !checkFailed) {
      // Retire only the unavailable role choice. Keep the recipients and scope
      // inputs, but prevent any in-flight completion from owning this draft.
      draftGenerationRef.current += 1
      setRole(null)
      setRoleNeedsSelection(true)
      setError(null)
    }
  }, [canOfferEditor, checkFailed, checkPending, permissionDenied, role])

  useLayoutEffect(
    () => () => {
      draftGenerationRef.current += 1
    },
    []
  )

  useEffect(() => {
    if (permissionDenied) {
      if (subjectKeys.length > 0) {
        setSubjectKeys([])
      }
      setRole('read')
      setRoleNeedsSelection(false)
      setInherit(true)
      setError(null)
      onDetailViewChange?.(false)
      return
    }
    onDetailViewChange?.(subjectKeys.length > 0)
  }, [onDetailViewChange, permissionDenied, subjectKeys.length])

  function changeSubjects(nextKeys: string[]) {
    setSubjectKeys(nextKeys)
  }

  async function run(action: (isDraftCurrent: () => boolean) => Promise<void>) {
    const generation = draftGenerationRef.current
    const isDraftCurrent = () => draftGenerationRef.current === generation
    setError(null)
    setBusy(true)
    try {
      await action(isDraftCurrent)
      if (isDraftCurrent()) {
        setSubjectKeys([])
        setRole('read')
        setRoleNeedsSelection(false)
      }
    } catch (e) {
      // The bulk grant is atomic — a failure means NONE of the subjects landed,
      // so keep the whole selection for a retry. Surface the server's
      // verdict (escalation_rejected, subjects_invalid with 1-based positions, a
      // rate-limit retry, …) via the shared presentation map — never swallow it.
      // A settled authority denial retires this draft, so its old failure cannot
      // overwrite the read-only state or a later fresh form.
      if (isDraftCurrent()) setError(describeGfsGrantError(e).message)
    } finally {
      // Busy belongs to the real request, not the draft. Keep duplicate-submit
      // protection until this operation settles even if authority retired it.
      setBusy(false)
    }
  }

  // A Leader without manage_acl (canDelegate=false) sees no controls.
  if (permissionDenied) {
    return (
      <Alert
        role="note"
        showIcon
        title="Read-only access"
        description="You do not have delegation rights on this folder."
        type="info"
      />
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
          <Select
            aria-label="Access role for selected recipients"
            disabled={busy}
            onChange={value => {
              setRole(value as AccessRole)
              setRoleNeedsSelection(false)
            }}
            options={roleOptions}
            placeholder="Role"
            size="small"
            value={role ?? ''}
          />
        ) : null}
      </div>
      {roleNeedsSelection && subjectKeys.length > 0 ? (
        <p className="muted" role="status" aria-live="polite">
          Choose an available role before sharing.
        </p>
      ) : null}
      {subjectKeys.length > 0 && hasHost ? (
        <p className="da-gfs-delegation__hint muted">
          Agents, workflows, and plugins use read/write access only.
        </p>
      ) : null}
      {subjectOptionsError ? (
        <Alert role="alert" showIcon type="error" title={subjectOptionsError} />
      ) : null}
      {checkPending ? (
        <Alert role="status" showIcon type="info" title={permissionMessage} />
      ) : permissionMessage ? (
        <Alert role="alert" showIcon type="error" title={permissionMessage} />
      ) : null}
      {subjectKeys.length > 0 ? (
        <div className="da-gfs-delegation__scope-actions">
          {isDirectory ? (
            <Checkbox
              checked={inherit}
              disabled={busy}
              onChange={event => setInherit(event.target.checked)}
            >
              Include contents of this folder
            </Checkbox>
          ) : null}
          <div className="da-gfs-delegation__actions">
            <Button
              disabled={busy}
              onClick={() => {
                setSubjectKeys([])
                setRole('read')
                setRoleNeedsSelection(false)
              }}
              htmlType="button"
              type="default"
              variant="text"
            >
              Back
            </Button>
            <Button
              htmlType="button"
              loading={busy}
              disabled={
                busy ||
                permissionUnavailable ||
                role === null ||
                !roleOptions.some(option => option.value === role) ||
                bits.length === 0
              }
              onClick={() => {
                if (role === null || !roleOptions.some(option => option.value === role)) return
                void run(isDraftCurrent =>
                  onGrant(subjectKeys, bits, isDirectory ? inherit : false, isDraftCurrent)
                )
              }}
            >
              Share
            </Button>
          </div>
        </div>
      ) : null}
      {error !== null ? <Alert role="alert" showIcon type="error" title={error} /> : null}
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
