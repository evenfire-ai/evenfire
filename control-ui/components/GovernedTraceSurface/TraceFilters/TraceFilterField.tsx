'use client'

import { useEffect, useMemo, useState } from 'react'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { CheckboxField, TextInput } from '@components/ui'
import { getAdminUsers, getControlAdmins } from '@lib/api'
import type { AdminUser, ControlAdminListItem } from '@lib/api'
import type { TraceFilterFieldDefinition } from './types'

function displayUser(user: AdminUser): string {
  return user.displayName?.trim() || user.name?.trim() || user.email
}

function mergeUsers(current: readonly AdminUser[], incoming: readonly AdminUser[]): AdminUser[] {
  const byId = new Map(current.map(user => [user.id, user]))
  for (const user of incoming) byId.set(user.id, user)
  return [...byId.values()]
}

function displayControlAdmin(admin: ControlAdminListItem): string {
  return admin.username.trim() || admin.email?.trim() || admin.id
}

function TraceTextFilter({
  definition,
  onChange,
  values,
}: {
  definition: TraceFilterFieldDefinition
  onChange: (values: readonly string[]) => void
  values: readonly string[]
}) {
  const value = values[0] ?? ''
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft.trim() === value) return
    const timeout = window.setTimeout(() => onChange(draft.trim() ? [draft.trim()] : []), 300)
    return () => window.clearTimeout(timeout)
  }, [draft, onChange, value])

  return (
    <label className="cu-trace-filter-field">
      <span>{definition.label}</span>
      <TextInput
        compact
        onChange={event => setDraft(event.target.value)}
        placeholder={definition.placeholder}
        value={draft}
      />
    </label>
  )
}

function TraceEnumFilter({
  definition,
  onChange,
  values,
}: {
  definition: TraceFilterFieldDefinition
  onChange: (values: readonly string[]) => void
  values: readonly string[]
}) {
  const selected = useMemo(() => new Set(values), [values])
  return (
    <fieldset className="cu-trace-filter-fieldset">
      <legend>{definition.label}</legend>
      {definition.options?.map(option => (
        <CheckboxField
          checked={selected.has(option.value)}
          key={option.value}
          label={option.label}
          onChange={() =>
            onChange(
              selected.has(option.value)
                ? values.filter(value => value !== option.value)
                : [...values, option.value]
            )
          }
        />
      ))}
    </fieldset>
  )
}

function TraceIdentityFilter({
  definition,
  onChange,
  values,
}: {
  definition: TraceFilterFieldDefinition
  onChange: (values: readonly string[]) => void
  values: readonly string[]
}) {
  const includeControlAdmins = definition.type === 'operator'
  const [users, setUsers] = useState<AdminUser[]>([])
  const [controlAdmins, setControlAdmins] = useState<ControlAdminListItem[]>([])
  const [userLookupError, setUserLookupError] = useState(false)
  const [adminLookupError, setAdminLookupError] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!includeControlAdmins) return
    let cancelled = false
    void getControlAdmins()
      .then(result => {
        if (!cancelled) setControlAdmins(result.admins ?? [])
      })
      .catch(() => {
        if (!cancelled) setAdminLookupError(true)
      })
    return () => {
      cancelled = true
    }
  }, [includeControlAdmins])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      setUserLookupError(false)
      void getAdminUsers(query.trim())
        .then(result => {
          if (!cancelled) setUsers(current => mergeUsers(current, result.items ?? []))
        })
        .catch(() => {
          if (!cancelled) setUserLookupError(true)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [query])

  const resolvedOptions = [
    ...new Map(
      [
        ...(includeControlAdmins
          ? controlAdmins.map(admin => ({
              value: admin.id,
              label: displayControlAdmin(admin),
              description: admin.email
                ? `Control administrator · ${admin.email}`
                : 'Control administrator',
              badge: admin.id,
            }))
          : []),
        ...users.map(user => ({
          value: user.id,
          label: displayUser(user),
          description: includeControlAdmins ? `Platform user · ${user.email}` : user.email,
          badge: user.id,
        })),
      ].map(option => [option.value, option] as const)
    ).values(),
  ]
  const resolvedIds = new Set(resolvedOptions.map(option => option.value))
  const options = [
    ...values
      .filter(value => !resolvedIds.has(value))
      .map(value => ({
        value,
        label: value,
        description: includeControlAdmins
          ? 'Selected operator identity'
          : 'Selected platform user ID',
        badge: value,
      })),
    ...resolvedOptions,
  ]

  return (
    <div className="cu-trace-filter-field">
      <span>{definition.label}</span>
      <SelectionDropdown
        emptyLabel={
          userLookupError || (includeControlAdmins && adminLookupError)
            ? `${includeControlAdmins ? 'Operator' : 'User'} lookup is temporarily unavailable.`
            : `No matching ${includeControlAdmins ? 'operators' : 'platform users'}.`
        }
        id={`trace-filter-${definition.key}`}
        inline
        multiple
        onChange={onChange}
        onSearchQueryChange={setQuery}
        options={options}
        placeholder={includeControlAdmins ? 'Select operators' : 'Select platform users'}
        searchPlaceholder={
          includeControlAdmins
            ? 'Search platform users or control admins'
            : 'Search authenticated users'
        }
        selectionLabel={includeControlAdmins ? 'Selected operators' : 'Selected users'}
        value={[...values]}
      />
    </div>
  )
}

export function TraceFilterField({
  definition,
  onChange,
  values,
}: {
  definition: TraceFilterFieldDefinition
  onChange: (values: readonly string[]) => void
  values: readonly string[]
}) {
  if (definition.type === 'enum') {
    return <TraceEnumFilter definition={definition} onChange={onChange} values={values} />
  }
  if (definition.type === 'user' || definition.type === 'operator') {
    return <TraceIdentityFilter definition={definition} onChange={onChange} values={values} />
  }
  return <TraceTextFilter definition={definition} onChange={onChange} values={values} />
}
