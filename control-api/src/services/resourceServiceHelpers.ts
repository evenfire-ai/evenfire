import type { ClerumResourceType } from '../types.js'

export function extractK8sStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as {
    statusCode?: number
    code?: number
    response?: { statusCode?: number; status?: number }
  }
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (maybe.response && typeof maybe.response.statusCode === 'number') {
    return maybe.response.statusCode
  }
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  return null
}

export function kindFromPlural(plural: ClerumResourceType): string {
  switch (plural) {
    case 'hosts':
      return 'Host'
    case 'contexts':
      return 'Context'
    case 'communicationchannels':
      return 'CommunicationChannel'
    case 'mcpservers':
      return 'McpServer'
    case 'workflowrecipes':
      return 'WorkflowRecipe'
    case 'workflowrecipepolicies':
      return 'WorkflowRecipePolicy'
    case 'sharedfilesystems':
      return 'SharedFileSystem'
    default:
      return 'Unknown'
  }
}

/** Add non-empty namespace value(s) to a Set. Handles string | string[]. */
export function addNonEmpty(set: Set<string>, value: string | string[] | undefined): void {
  if (Array.isArray(value)) {
    for (const n of value) {
      const trimmed = n.trim()
      if (trimmed) set.add(trimmed)
    }
  } else if (value) {
    const trimmed = value.trim()
    if (trimmed) set.add(trimmed)
  }
}
