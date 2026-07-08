export function summarizeWorkflowListItemInputs(item: Record<string, unknown>): string {
  const targets = Array.isArray(item.targets)
    ? item.targets.flatMap(target => {
        const record =
          target && typeof target === 'object' && !Array.isArray(target)
            ? (target as Record<string, unknown>)
            : {}
        const label = typeof record.label === 'string' ? record.label.trim() : ''
        return label ? [label] : []
      })
    : []
  const targetLine =
    targets.length > 0
      ? `Targets: ${targets.join(', ')}${item.duplicateLabels === true ? ' (duplicate labels)' : ''}. `
      : ''
  if (Array.isArray(item.inputs)) {
    const inputs = item.inputs.filter(
      (input): input is Record<string, unknown> =>
        !!input && typeof input === 'object' && !Array.isArray(input)
    )
    if (inputs.length === 0) return 'Required business inputs: none.'

    const requiredInputs = inputs
      .filter(input => input.required === true && typeof input.name === 'string')
      .map(input => input.name as string)
    const requiredLine =
      requiredInputs.length > 0
        ? `Required business inputs: ${requiredInputs.join(', ')}.`
        : 'Required business inputs: none.'
    const inputLine = inputs
      .filter(input => typeof input.name === 'string' && input.name.trim())
      .map(input => formatSanitizedWorkflowInput(input))
      .join('; ')
    const inputsLine = inputLine ? `${requiredLine} Business inputs: ${inputLine}.` : requiredLine
    return `${targetLine}${inputsLine}`
  }

  return `${targetLine}${summarizeWorkflowInputContract(item.inputContract)}`
}

function summarizeWorkflowInputContract(contract: unknown): string {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return 'Required business inputs: none.'
  }

  const record = contract as Record<string, unknown>
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((item): item is string => typeof item === 'string')
      : []
  )
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {}
  const propertyNames = Object.keys(properties)

  if (propertyNames.length === 0) {
    return required.size > 0
      ? `Required business inputs: ${Array.from(required).join(', ')}.`
      : 'Required business inputs: none.'
  }

  const requiredLine =
    required.size > 0
      ? `Required business inputs: ${Array.from(required).join(', ')}.`
      : 'Required business inputs: none.'
  const inputLine = propertyNames
    .map(name => formatWorkflowInput(name, properties[name], required.has(name)))
    .join('; ')

  return `${requiredLine} Business inputs: ${inputLine}.`
}

function formatSanitizedWorkflowInput(input: Record<string, unknown>): string {
  const name = String(input.name)
  const details = [input.required === true ? 'required' : 'optional']
  if (Array.isArray(input.options)) {
    const values = input.options
      .filter(value => ['string', 'number', 'boolean'].includes(typeof value))
      .map(String)
    if (values.length > 0) details.push(`allowed: ${values.join(', ')}`)
  }
  if (
    input.default !== undefined &&
    ['string', 'number', 'boolean'].includes(typeof input.default)
  ) {
    details.push(`default: ${String(input.default)}`)
  }
  if (typeof input.description === 'string' && input.description.trim()) {
    details.push(input.description.trim())
  }
  return `${name} (${details.join(', ')})`
}

function formatWorkflowInput(name: string, definition: unknown, isRequired: boolean): string {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return `${name} (${isRequired ? 'required' : 'optional'})`
  }

  const record = definition as Record<string, unknown>
  const details = [isRequired ? 'required' : 'optional']
  if (typeof record.type === 'string' && record.type.trim()) details.push(record.type.trim())
  if (Array.isArray(record.enum)) {
    const values = record.enum
      .filter(value => ['string', 'number', 'boolean'].includes(typeof value))
      .map(String)
    if (values.length > 0) details.push(`allowed: ${values.join(', ')}`)
  }
  if (
    record.default !== undefined &&
    ['string', 'number', 'boolean'].includes(typeof record.default)
  ) {
    details.push(`default: ${String(record.default)}`)
  }
  if (typeof record.description === 'string' && record.description.trim()) {
    details.push(record.description.trim())
  }

  return `${name} (${details.join(', ')})`
}
