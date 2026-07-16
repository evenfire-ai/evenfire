import { useState } from 'react'
import { Button, DropdownSelect, Field, SelectableOption, StatusBanner } from '@components/Common'
import type { GfsDelegationPanelProps, GfsDelegationSubjectType } from './delegation.types'

/**
 * P4-S07 — Desktop gfs delegation panel (renderer). A folder owner delegates
 * Layer-2/3 grants within its subtree. Presentational + affordance-driven: it
 * only SHOWS controls the caller can exercise (computed by delegationAffordances
 * in the main process and passed in). Enforcement is ALWAYS server-side
 * (control-api/gfsc) — hiding a control is usability, never the security boundary.
 *
 * Composes the shared Common primitives (Field/DropdownSelect/SelectableOption/
 * Button/StatusBanner) per the desktop-app/ui frontend rules — no raw inputs/buttons.
 */

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
      <div className="da-gfs-delegation__subject-grid">
        <Field label="Subject type" htmlFor="gfs-delegation-subject-type">
          <DropdownSelect
            ariaLabel="Subject type"
            id="gfs-delegation-subject-type"
            value={subjectType}
            onChange={value => {
              setSubjectType(value as GfsDelegationSubjectType)
              setSubjectId('')
            }}
            disabled={busy}
            options={[
              { value: 'user', label: 'User' },
              { value: 'team', label: 'Team' },
            ]}
            placeholder="Choose a subject type"
          />
        </Field>
        <Field
          label={subjectType === 'user' ? 'User' : 'Team'}
          htmlFor="gfs-delegation-subject"
          hint={`Choose the ${subjectType} that will receive access.`}
        >
          <DropdownSelect
            ariaLabel="subject"
            id="gfs-delegation-subject"
            value={subjectId}
            onChange={setSubjectId}
            disabled={busy || subjectOptionsLoading || visibleSubjects.length === 0}
            options={visibleSubjects.map(subject => ({
              value: subject.id,
              label: subject.description
                ? `${subject.label} (${subject.description})`
                : subject.label,
            }))}
            placeholder={
              subjectOptionsLoading
                ? `Loading ${subjectType === 'user' ? 'users' : 'teams'}...`
                : `Choose a ${subjectType}`
            }
          />
        </Field>
      </div>
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

export type {
  DelegationAffordances,
  GfsDelegationPanelProps,
  GfsDelegationSubjectOption,
  GfsDelegationSubjectType,
} from './delegation.types'
