'use client'

import { useEffect, useMemo, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { useToast } from '@components/Toast'
import { Button, CheckboxField, Field, FormSection, SelectInput } from '@components/ui'
import { GFS_GRANT_SUBJECT_TYPE_OPTIONS } from '@constants/gfsGrantSubjects'
import {
  type AdminUser,
  type HostResource,
  type TeamListItem,
  type WorkflowRecipeResource,
  getAdminTeams,
  getAdminUsers,
  getHosts,
  getRecipes,
  postGfsShare,
  putGfsGrant,
} from '@lib/api'
import type { GfsGrantPanelProps, GfsGrantSubjectType } from './GfsGrantPanel.types'
import {
  buildGfsGrantSubjectOptions,
  gfsGrantSubjectFieldLabel,
  gfsGrantSubjectPlaceholder,
  gfsGrantSubjectSearchPlaceholder,
  toGfsSubjectInput,
} from './gfsGrantSubjectOptions'

/**
 * P4-S07 — Operator delegation panel for the Global File System. The operator
 * (Control UI / Admin-JWT plane) seeds Layer-1/2 grants and creates URI shares
 * on a selected resource. Reuses the existing grant/share write API (PUT
 * /api/v1/gfs/grants, POST /api/v1/gfs/shares) — no new authority. The
 * no-escalation / authority engine runs server-side; this panel surfaces the
 * machine error code (e.g. escalation_rejected) on rejection. Composes the
 * shared `components/ui` primitives per the control-ui frontend rules.
 */

const PERMISSION_BITS = ['read', 'write', 'delete', 'manage_acl', 'share'] as const
const DRIVE = 'main'

export function GfsGrantPanel({ resource, onClose }: GfsGrantPanelProps): React.JSX.Element {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [recipes, setRecipes] = useState<WorkflowRecipeResource[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState('')
  const [subjectType, setSubjectType] = useState<GfsGrantSubjectType>('user')
  const [subjectValue, setSubjectValue] = useState('')
  const [bits, setBits] = useState<string[]>([])
  const [includeDescendants, setIncludeDescendants] = useState(resource.kind === 'directory')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canIncludeDescendants = resource.kind === 'directory'

  useEffect(() => {
    let active = true

    async function loadDirectory() {
      setDirectoryLoading(true)
      setDirectoryError('')
      try {
        const [userResult, teamResult, hostResult, recipeResult] = await Promise.allSettled([
          getAdminUsers(''),
          getAdminTeams(),
          getHosts(),
          getRecipes(),
        ])
        if (!active) return
        const failed: string[] = []
        if (userResult.status === 'fulfilled') setUsers(userResult.value.items ?? [])
        else failed.push('users')
        if (teamResult.status === 'fulfilled') setTeams(teamResult.value.items ?? [])
        else failed.push('teams')
        if (hostResult.status === 'fulfilled') setHosts(hostResult.value.items ?? [])
        else failed.push('agents')
        if (recipeResult.status === 'fulfilled') setRecipes(recipeResult.value.items ?? [])
        else failed.push('workflows')
        if (failed.length === 4) {
          setDirectoryError('Failed to load grant subjects')
        } else if (failed.length > 0) {
          setDirectoryError(`Some grant subjects could not be loaded: ${failed.join(', ')}`)
        }
      } catch (e) {
        if (!active) return
        setDirectoryError(e instanceof Error ? e.message : 'Failed to load grant subjects')
      } finally {
        if (active) setDirectoryLoading(false)
      }
    }

    void loadDirectory()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setIncludeDescendants(resource.kind === 'directory')
  }, [resource.kind, resource.resourceId])

  const subjectOptions = useMemo(
    () => buildGfsGrantSubjectOptions({ subjectType, users, teams, hosts, recipes }),
    [hosts, recipes, subjectType, teams, users]
  )
  const selectedSubject = subjectOptions.find(option => option.value === subjectValue) ?? null
  const subjectValid = subjectType === 'operator' || selectedSubject !== null
  const canCreateShare = subjectType !== 'firstPartyAgent' && subjectType !== 'workflowPlugin'
  const canSubmit = subjectValid && bits.length > 0 && !busy

  const toggleBit = (bit: string) =>
    setBits(prev => (prev.includes(bit) ? prev.filter(b => b !== bit) : [...prev, bit]))

  function changeSubjectType(nextType: GfsGrantSubjectType) {
    setSubjectType(nextType)
    setSubjectValue('')
  }

  function subjectLabel(): string {
    if (subjectType === 'operator') return 'operator'
    if (!selectedSubject) return 'the selected subject'
    return `${selectedSubject.badge.toLowerCase()} ${selectedSubject.label}`
  }

  async function submit(kind: 'grant' | 'share') {
    setError('')
    const confirmed = await confirm({
      title: kind === 'grant' ? 'Grant access?' : 'Create share?',
      message: `Give ${subjectLabel()} [${bits.join(', ')}] on "${resource.name}"?`,
      confirmLabel: kind === 'grant' ? 'Grant' : 'Create share',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const body = {
        drive: DRIVE,
        resourceId: resource.resourceId,
        subject: toGfsSubjectInput(subjectType, selectedSubject),
        permissions: bits,
      }
      if (kind === 'grant') await putGfsGrant({ ...body, inherit: includeDescendants })
      else await postGfsShare({ ...body, includeDescendants })
      showToast(kind === 'grant' ? 'Grant saved.' : 'Share created.', { tone: 'success' })
      // Reset the whole form — leaving the subject populated risks a mis-targeted
      // second grant on the next click.
      setBits([])
      setSubjectType('user')
      setSubjectValue('')
      setIncludeDescendants(resource.kind === 'directory')
    } catch (e) {
      // Surface the machine code (e.g. escalation_rejected, resource_invalid)
      // so the operator sees the precise verdict — never swallow it.
      const code = (e as { code?: string }).code
      setError(code || (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormSection title={`Manage access — ${resource.name}`} description={resource.gfsUri}>
      <Field
        label="Subject type"
        htmlFor="gfs-grant-subject-type"
        description="Choose the subject category before selecting the exact grant target."
      >
        <SelectInput
          id="gfs-grant-subject-type"
          value={subjectType}
          onChange={event => changeSubjectType(event.target.value as GfsGrantSubjectType)}
          disabled={busy}
        >
          {GFS_GRANT_SUBJECT_TYPE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      {subjectType === 'operator' ? (
        <Field
          label="Subject"
          description="The intrinsic cluster operator subject will receive the selected permissions."
        >
          <div className="cu-field__readonly">Operator</div>
        </Field>
      ) : (
        <Field
          label={gfsGrantSubjectFieldLabel(subjectType)}
          htmlFor="gfs-grant-subject"
          description={`Choose the ${gfsGrantSubjectFieldLabel(subjectType).toLowerCase()} that will receive access.`}
        >
          <SelectionDropdown
            id="gfs-grant-subject"
            multiple={false}
            showSelectedChips={false}
            value={subjectValue ? [subjectValue] : []}
            onChange={next => setSubjectValue(next[0] ?? '')}
            options={subjectOptions}
            placeholder={gfsGrantSubjectPlaceholder(subjectType, directoryLoading)}
            searchPlaceholder={gfsGrantSubjectSearchPlaceholder(subjectType)}
            selectionLabel="Selected subject"
            emptyLabel={`No matching ${gfsGrantSubjectFieldLabel(subjectType).toLowerCase()} options.`}
            disabled={busy || directoryLoading}
          />
        </Field>
      )}
      {directoryError ? (
        <p role="alert" className="cu-field__error">
          {directoryError}
        </p>
      ) : null}
      {canIncludeDescendants ? (
        <Field label="Scope">
          <CheckboxField
            label="Include descendants"
            description="Apply this grant or share to the full folder tree."
            checked={includeDescendants}
            onChange={() => setIncludeDescendants(current => !current)}
            disabled={busy}
          />
        </Field>
      ) : null}
      <Field label="Permissions">
        <div className="cu-gfs-grant__bits">
          {PERMISSION_BITS.map(bit => (
            <CheckboxField
              key={bit}
              label={bit}
              checked={bits.includes(bit)}
              onChange={() => toggleBit(bit)}
            />
          ))}
        </div>
      </Field>
      <div className="cu-gfs-grant__actions">
        <Button variant="primary" disabled={!canSubmit} onClick={() => submit('grant')}>
          Grant
        </Button>
        <Button disabled={!canSubmit || !canCreateShare} onClick={() => submit('share')}>
          Create share
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {error ? (
        <p role="alert" className="cu-field__error">
          {error}
        </p>
      ) : null}
      {confirmDialog}
    </FormSection>
  )
}
