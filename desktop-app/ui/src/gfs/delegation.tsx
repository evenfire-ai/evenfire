import { useState } from 'react'
import { Button, Field, SelectInput, SelectableOption, StatusBanner } from '@components/Common'

/**
 * P4-S07 — Desktop gfs delegation panel (renderer). A folder owner delegates
 * Layer-2/3 grants within its subtree. Presentational + affordance-driven: it
 * only SHOWS controls the caller can exercise (computed by delegationAffordances
 * in the main process and passed in). Enforcement is ALWAYS server-side
 * (control-api/gfsc) — hiding a control is usability, never the security boundary.
 *
 * Composes the shared Common primitives (Field/TextInput/SelectableOption/Button/
 * StatusBanner) per the desktop-app/ui frontend rules — no raw inputs/buttons.
 */

export interface DelegationAffordances {
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

export type GfsDelegationSubjectType = 'user' | 'team'

export interface GfsDelegationSubjectOption {
  type: GfsDelegationSubjectType
  id: string
  label: string
  description?: string
}

export interface GfsDelegationPanelProps {
  affordances: DelegationAffordances
  subjectOptions: GfsDelegationSubjectOption[]
  subjectOptionsLoading?: boolean
  subjectOptionsError?: string | null
  /** Grant the selected bits to a user/team subject within the caller's subtree. */
  onGrant: (subjectKey: string, bits: string[]) => Promise<void>
  /** Create a URI share for a user/team subject (shown only when canCreateShare). */
  onCreateShare?: (subjectKey: string) => Promise<void>
}

export function GfsDelegationPanel({
  affordances,
  subjectOptions,
  subjectOptionsLoading = false,
  subjectOptionsError = null,
  onGrant,
  onCreateShare,
}: GfsDelegationPanelProps) {
  const [subjectType, setSubjectType] = useState<GfsDelegationSubjectType>('user')
  const [subjectId, setSubjectId] = useState('')
  const [bits, setBits] = useState<string[]>([])
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

  const toggle = (bit: string) =>
    setBits(prev => (prev.includes(bit) ? prev.filter(b => b !== bit) : [...prev, bit]))

  async function run(action: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      setSubjectId('')
      setBits([])
    } catch (e) {
      // Surface the server's verdict (e.g. escalation_rejected) — never swallow.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const visibleSubjects = subjectOptions.filter(subject => subject.type === subjectType)
  const subjectValid = subjectId.trim().length > 0
  const subjectKey = `${subjectType}:${subjectId}`

  return (
    <div className="da-gfs-delegation">
      <div className="da-gfs-delegation__summary" role="note">
        <strong>Grantable permissions</strong>
        <span>{affordances.grantableBits.join(', ')}</span>
      </div>
      <Field label="Subject type" htmlFor="gfs-delegation-subject-type">
        <SelectInput
          id="gfs-delegation-subject-type"
          value={subjectType}
          onChange={event => {
            setSubjectType(event.target.value as GfsDelegationSubjectType)
            setSubjectId('')
          }}
          disabled={busy}
        >
          <option value="user">User</option>
          <option value="team">Team</option>
        </SelectInput>
      </Field>
      <Field
        label={subjectType === 'user' ? 'User' : 'Team'}
        htmlFor="gfs-delegation-subject"
        hint={`Choose the ${subjectType} that will receive access.`}
      >
        <SelectInput
          id="gfs-delegation-subject"
          aria-label="subject"
          value={subjectId}
          onChange={event => setSubjectId(event.target.value)}
          disabled={busy || subjectOptionsLoading || visibleSubjects.length === 0}
        >
          <option value="">
            {subjectOptionsLoading
              ? `Loading ${subjectType === 'user' ? 'users' : 'teams'}...`
              : `Choose a ${subjectType}`}
          </option>
          {visibleSubjects.map(subject => (
            <option key={`${subject.type}:${subject.id}`} value={subject.id}>
              {subject.description ? `${subject.label} (${subject.description})` : subject.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      {subjectOptionsError ? <StatusBanner tone="error" text={subjectOptionsError} /> : null}
      <Field label="Permissions">
        {/* Only bits the caller itself holds are offered (no escalation). */}
        <div className="da-gfs-delegation__bits" role="group" aria-label="permissions">
          {affordances.grantableBits.map(bit => (
            <SelectableOption
              key={bit}
              type="button"
              size="sm"
              selected={bits.includes(bit)}
              aria-pressed={bits.includes(bit)}
              onClick={() => toggle(bit)}
            >
              {bit}
            </SelectableOption>
          ))}
        </div>
      </Field>
      <div className="da-gfs-delegation__actions">
        <Button
          type="button"
          loading={busy}
          disabled={busy || !subjectValid || bits.length === 0}
          onClick={() => run(() => onGrant(subjectKey, bits))}
        >
          Grant
        </Button>
        {affordances.canCreateShare && onCreateShare && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || !subjectValid}
            onClick={() => run(() => onCreateShare(subjectKey))}
          >
            Create share
          </Button>
        )}
      </div>
      {error !== null && <StatusBanner tone="error" text={error} />}
    </div>
  )
}
