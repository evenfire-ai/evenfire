import type { CredentialDraftRow, RegistryCredentialKey } from './registryCredentialDraft.types'

export function reconcileCredentialRows(
  currentRows: CredentialDraftRow[],
  schemaKeys: RegistryCredentialKey[]
): CredentialDraftRow[] {
  const schemaNames = new Set(schemaKeys.map(key => key.name))
  const unboundRow = currentRows.find(row => !row.secretKey.trim() && row.value.trim())
  let usedUnboundRow = false

  const schemaRows = schemaKeys.map((key, index) => {
    const matchingRow = currentRows.find(row => row.secretKey.trim() === key.name)
    const existingRow = matchingRow ?? (!usedUnboundRow && unboundRow ? unboundRow : undefined)
    if (existingRow === unboundRow) usedUnboundRow = true
    return {
      id: existingRow?.id ?? `mcp-schema-row-${index}`,
      secretKey: key.name,
      value: existingRow?.value ?? '',
      label: key.label || key.name,
    }
  })

  const extraRows = currentRows.filter(row => {
    if (row === unboundRow && usedUnboundRow) return false
    return (
      !schemaNames.has(row.secretKey.trim()) && Boolean(row.secretKey.trim() || row.value.trim())
    )
  })
  return [...schemaRows, ...extraRows]
}

export function areRequiredCredentialRowsComplete(
  rows: CredentialDraftRow[],
  schemaKeys: RegistryCredentialKey[]
): boolean {
  return schemaKeys.every(key =>
    rows.some(row => row.secretKey.trim() === key.name && row.value.trim().length > 0)
  )
}
