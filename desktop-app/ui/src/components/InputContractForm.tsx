import { Field, SelectInput, TextInput } from '@components/Common'
import type {
  WorkflowInputContractProperty,
  WorkflowInputContractSchema,
  WorkflowInputValues,
} from '../../../src/types'

interface InputContractFormProps {
  schema: WorkflowInputContractSchema
  values: WorkflowInputValues
  onChange: (next: WorkflowInputValues) => void
  disabled?: boolean
}

function coerceNumeric(property: WorkflowInputContractProperty, raw: string): string | number {
  const parsed = property.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : raw
}

function renderValue(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

export function InputContractForm({
  schema,
  values,
  onChange,
  disabled = false,
}: InputContractFormProps) {
  const entries = Object.entries(schema.properties ?? {})
  if (entries.length === 0) return null

  const required = new Set(schema.required ?? [])

  return (
    <div className="input-contract-form">
      <h4>Inputs</h4>
      {entries.map(([key, property]) => {
        const current = values[key]
        const fieldId = `input-${key}`
        const label = required.has(key) ? `${key} *` : key

        // Booleans render as native checkboxes. A text input with onChange
        // coercion (`raw === 'true' ? true : false`) would snap every
        // intermediate keystroke to false, making the field uneditable for
        // anything short of a single-shot paste of the literal "true".
        if (property.type === 'boolean') {
          const checked = Boolean(current ?? property.default ?? false)
          return (
            <Field key={key} htmlFor={fieldId} label={label} hint={property.description}>
              <input
                id={fieldId}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={event => onChange({ ...values, [key]: event.target.checked })}
              />
            </Field>
          )
        }

        const rawValue = renderValue(current ?? property.default)

        if (property.enum && property.enum.length > 0) {
          return (
            <Field key={key} htmlFor={fieldId} label={label} hint={property.description}>
              <SelectInput
                id={fieldId}
                value={rawValue}
                disabled={disabled}
                onChange={event => onChange({ ...values, [key]: event.target.value })}
              >
                {property.enum.map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )
        }

        const isNumeric = property.type === 'integer' || property.type === 'number'
        const inputType = isNumeric ? 'number' : 'text'

        return (
          <Field key={key} htmlFor={fieldId} label={label} hint={property.description}>
            <TextInput
              id={fieldId}
              type={inputType}
              value={rawValue}
              disabled={disabled}
              onChange={event =>
                onChange({
                  ...values,
                  [key]: isNumeric
                    ? coerceNumeric(property, event.target.value)
                    : event.target.value,
                })
              }
            />
          </Field>
        )
      })}
    </div>
  )
}

/**
 * Build the initial form state for a recipe's input contract. Returns each
 * property's declared `default` when present, or a zero value for its type.
 * Falls back to an empty object when the recipe has no input contract.
 */
export function buildInitialInputValues(
  schema: WorkflowInputContractSchema | undefined
): WorkflowInputValues {
  const initial: WorkflowInputValues = {}
  const properties = schema?.properties ?? {}
  for (const [key, property] of Object.entries(properties)) {
    if (property.default !== undefined) {
      initial[key] = property.default
      continue
    }
    switch (property.type) {
      case 'integer':
      case 'number':
        initial[key] = 0
        break
      case 'boolean':
        initial[key] = false
        break
      default:
        initial[key] = ''
    }
  }
  return initial
}
