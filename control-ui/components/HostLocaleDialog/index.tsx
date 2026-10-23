import React from 'react'
import { SimpleEditDialog } from '@clerum/frontend-components'
import { hostLanguageOptions, hostTimeZoneOptions } from '@lib/hostLocale'
import { Field, SelectInput } from '../ui'
import type { HostLocaleDialogProps, HostLocaleValue } from './types'

export function HostLocaleDialog({
  open,
  locale,
  pending,
  error,
  onCancel,
  onSave,
}: HostLocaleDialogProps) {
  const [draft, setDraft] = React.useState<HostLocaleValue>(locale)
  const languages = React.useMemo(() => hostLanguageOptions(locale.language), [locale.language])
  const timeZones = React.useMemo(() => hostTimeZoneOptions(locale.timeZone), [locale.timeZone])

  React.useEffect(() => {
    if (open) setDraft({ language: locale.language, timeZone: locale.timeZone })
  }, [open, locale.language, locale.timeZone])

  const isDirty = draft.language !== locale.language || draft.timeZone !== locale.timeZone

  return (
    <SimpleEditDialog
      open={open}
      title="Edit document language and time zone"
      description="Documents this agent generates use the language for their headings, labels and numbers, and the time zone for their dates."
      pending={pending}
      error={error}
      isDirty={isDirty}
      saveLabel="Save language and time zone"
      onCancel={onCancel}
      onSave={() => onSave(draft)}
    >
      <div className="cu-modal-panel__body">
        <Field
          label="Language"
          htmlFor="host-locale-language"
          description="Not set: labels are in English and the agent writes in the user's language. A regional form also sets numbers and dates: es-MX writes 12,345.5, es writes 12.345,5."
        >
          <SelectInput
            id="host-locale-language"
            value={draft.language}
            onChange={event => {
              const language = event.target.value
              setDraft(current => ({ ...current, language }))
            }}
            disabled={pending}
          >
            <option value="">Not set</option>
            {languages.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label="Time zone"
          htmlFor="host-locale-time-zone"
          description="Not set: dates are in UTC."
        >
          <SelectInput
            id="host-locale-time-zone"
            value={draft.timeZone}
            onChange={event => {
              const timeZone = event.target.value
              setDraft(current => ({ ...current, timeZone }))
            }}
            disabled={pending}
          >
            <option value="">Not set</option>
            {timeZones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>
    </SimpleEditDialog>
  )
}
