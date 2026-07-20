'use client'

import { useEffect, useMemo, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { GfsPermissionDropdown } from '@components/GfsPermissionDropdown'
import { GfsSubjectPicker } from '@components/GfsSubjectPicker'
import type { SelectionDropdownOption } from '@components/SelectionDropdown/types'
import { useToast } from '@components/Toast'
import { Button, CheckboxField } from '@components/ui'
import {
  type AdminUser,
  type HostResource,
  type TeamListItem,
  type WorkflowRecipeResource,
  getAdminTeams,
  getAdminUsers,
  getHosts,
  getRecipes,
  putGfsGrant,
} from '@lib/api'
import type { GfsGrantPanelProps, GfsGrantSubjectType } from './GfsGrantPanel.types'
import { buildGfsGrantSubjectOptions, toGfsSubjectInput } from './gfsGrantSubjectOptions'

/**
 * P4-S07 — Operator delegation panel for the Global File System. The operator
 * (Control UI / Admin-JWT plane) seeds Layer-1/2 grants on a selected resource.
 * Reuses the existing grant write API (PUT /api/v1/gfs/grants) — no new
 * authority. The no-escalation / authority engine runs server-side; this panel
 * surfaces the machine error code (e.g. escalation_rejected) on rejection.
 * Composes the shared `components/ui` primitives per the control-ui frontend
 * rules.
 */

const PERMISSION_BITS = ['read', 'write', 'delete', 'manage_acl', 'share'] as const
const DRIVE = 'main'

type GrantSubjectSelection = {
  option: SelectionDropdownOption & { id: string; badge: string }
  subjectType: GfsGrantSubjectType
}

export function GfsGrantPanel({ resource }: GfsGrantPanelProps): React.JSX.Element {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [recipes, setRecipes] = useState<WorkflowRecipeResource[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState('')
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

  const subjectSelections = useMemo<GrantSubjectSelection[]>(() => {
    const selections: GrantSubjectSelection[] = []
    const addOptions = (subjectType: GfsGrantSubjectType) => {
      const options = buildGfsGrantSubjectOptions({
        subjectType,
        users,
        teams,
        hosts,
        recipes,
      })
      selections.push(...options.map(option => ({ option, subjectType })))
    }

    addOptions('user')
    addOptions('team')
    addOptions('firstPartyAgent')
    addOptions('workflowPlugin')
    selections.push({
      subjectType: 'operator',
      option: {
        value: 'operator',
        id: '',
        label: 'Operator',
        description: 'Intrinsic cluster operator',
        badge: 'Operator',
      },
    })
    return selections
  }, [hosts, recipes, teams, users])
  const subjectOptions = subjectSelections.map(selection => selection.option)
  const selectedSelection =
    subjectSelections.find(selection => selection.option.value === subjectValue) ?? null
  const canSubmit = selectedSelection !== null && bits.length > 0 && !busy

  function subjectLabel(): string {
    if (!selectedSelection) return 'the selected subject'
    if (selectedSelection.subjectType === 'operator') return 'operator'
    return `${selectedSelection.option.badge.toLowerCase()} ${selectedSelection.option.label}`
  }

  async function submit() {
    setError('')
    if (!selectedSelection || bits.length === 0) {
      setError('subject_and_permissions_required')
      return
    }
    const grantSelection = selectedSelection
    const confirmed = await confirm({
      title: 'Grant access?',
      message: `Give ${subjectLabel()} [${bits.join(', ')}] on "${resource.name}"?`,
      confirmLabel: 'Grant',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const body = {
        drive: DRIVE,
        resourceId: resource.resourceId,
        subject: toGfsSubjectInput(grantSelection.subjectType, grantSelection.option),
        permissions: bits,
      }
      await putGfsGrant({ ...body, inherit: includeDescendants })
      showToast('Grant saved.', { tone: 'success' })
      // Reset the whole form — leaving the subject populated risks a mis-targeted
      // second grant on the next click.
      setBits([])
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
    <div className="cu-gfs-grant-panel">
      <div className="cu-gfs-grant__composer">
        <GfsSubjectPicker
          disabled={busy}
          loading={directoryLoading}
          onChange={setSubjectValue}
          options={subjectOptions}
          value={subjectValue}
        />
        <GfsPermissionDropdown
          disabled={busy}
          onChange={setBits}
          permissions={PERMISSION_BITS}
          value={bits}
        />
      </div>
      {directoryError ? (
        <p role="alert" className="cu-field__error">
          {directoryError}
        </p>
      ) : null}
      {canIncludeDescendants ? (
        <CheckboxField
          className="cu-gfs-grant__scope"
          label="Include descendants"
          description="Apply this grant or share to the full folder tree."
          checked={includeDescendants}
          onChange={() => setIncludeDescendants(current => !current)}
          disabled={busy}
        />
      ) : null}
      <div className="cu-gfs-grant__actions">
        <Button variant="primary" disabled={!canSubmit} onClick={() => submit()}>
          Grant access
        </Button>
      </div>
      {error ? (
        <p role="alert" className="cu-field__error">
          {error}
        </p>
      ) : null}
      {confirmDialog}
    </div>
  )
}
