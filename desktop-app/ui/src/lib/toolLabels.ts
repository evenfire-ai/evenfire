function compactLabel(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function providerNameFromToolName(toolName: string): string {
  const separatorIndex = toolName.indexOf('__')
  if (separatorIndex <= 0) return ''
  return toolName.slice(0, separatorIndex).replace(/[_-]+/g, ' ').trim()
}

function toolFunctionName(toolName: string): string {
  const separatorIndex = toolName.indexOf('__')
  if (separatorIndex <= 0) return ''
  return toolName.slice(separatorIndex + 2).trim()
}

export function formatToolApprovalLabel({
  displayName,
  toolName,
  fallback = 'Tool',
}: {
  displayName?: string
  toolName?: string
  fallback?: string
}): string {
  const display = compactLabel(displayName)
  const rawToolName = compactLabel(toolName)
  if (!rawToolName) return display || fallback

  const fnName = toolFunctionName(rawToolName)
  if (!fnName) return display || rawToolName || fallback

  const provider = providerNameFromToolName(rawToolName)
  const displayMatchesProvider =
    Boolean(display && provider) && display.toLowerCase() === provider.toLowerCase()

  if (!display || displayMatchesProvider) {
    return `${display || provider || fallback} ${fnName}`.trim()
  }

  return display
}
