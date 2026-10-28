import { Checkbox, Flex, Form, Input, Select, Typography } from 'antd'
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
    <Flex vertical>
      <Typography.Title level={4}>Inputs</Typography.Title>
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
            <Form.Item key={key} htmlFor={fieldId} label={label} help={property.description}>
              <Checkbox
                id={fieldId}
                checked={checked}
                disabled={disabled}
                onChange={event => onChange({ ...values, [key]: event.target.checked })}
              />
            </Form.Item>
          )
        }

        const rawValue = renderValue(current ?? property.default)

        if (property.enum && property.enum.length > 0) {
          return (
            <Form.Item key={key} htmlFor={fieldId} label={label} help={property.description}>
              <Select
                id={fieldId}
                size="small"
                value={rawValue}
                disabled={disabled}
                onChange={value => onChange({ ...values, [key]: value })}
                options={property.enum.map(option => ({ value: option, label: option }))}
              />
            </Form.Item>
          )
        }

        const isNumeric = property.type === 'integer' || property.type === 'number'
        const inputType = isNumeric ? 'number' : 'text'

        return (
          <Form.Item key={key} htmlFor={fieldId} label={label} help={property.description}>
            <Input
              id={fieldId}
              type={inputType}
              size="small"
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
          </Form.Item>
        )
      })}
    </Flex>
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
