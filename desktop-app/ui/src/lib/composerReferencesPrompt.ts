import type { ComposerReferenceAttachment } from '../uiTypes'

function normalizeComposerReferenceName(value: string): string {
  return value.trim()
}

function formatAgentFileReference(
  reference: Extract<ComposerReferenceAttachment, { type: 'agent_file' }>
): string {
  const filesystemName = normalizeComposerReferenceName(reference.filesystemName)
  const path = normalizeComposerReferenceName(reference.path)
  if (!filesystemName || !path) return ''
  return `${filesystemName}${path.startsWith('/') ? path : `/${path}`}`
}

export function buildComposerReferencesPromptSection(
  references: ComposerReferenceAttachment[]
): string | null {
  if (!references.length) return null

  const plugins = references
    .filter(
      (reference): reference is Extract<ComposerReferenceAttachment, { type: 'plugin' }> =>
        reference.type === 'plugin'
    )
    .map(reference => {
      const namespace = normalizeComposerReferenceName(reference.namespace)
      const name = normalizeComposerReferenceName(reference.name)
      return namespace && name ? `${namespace}/${name}` : ''
    })
    .filter(Boolean)

  const connectors = references
    .filter(
      (reference): reference is Extract<ComposerReferenceAttachment, { type: 'connector' }> =>
        reference.type === 'connector'
    )
    .map(reference => normalizeComposerReferenceName(reference.name))
    .filter(Boolean)

  const agentFiles = references
    .filter(
      (reference): reference is Extract<ComposerReferenceAttachment, { type: 'agent_file' }> =>
        reference.type === 'agent_file'
    )
    .map(formatAgentFileReference)
    .filter(Boolean)

  if (!plugins.length && !connectors.length && !agentFiles.length) return null

  const lines = [
    'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message. Prefer them when they are relevant to the request.',
  ]

  if (plugins.length) {
    lines.push(
      `Plugins: ${plugins.join(', ')}. Use workflow tools for these plugin names when the user asks to run or use a plugin.`
    )
  }

  if (connectors.length) {
    lines.push(
      `Connectors: ${connectors.join(', ')}. Use MCP tools whose prefix before "__" exactly matches one of these connector names.`
    )
  }

  if (agentFiles.length) {
    lines.push(
      `Agent Files: ${agentFiles.join(', ')}. Use clerum__context_files_list and clerum__context_files_read to inspect these paths before relying on their contents.`
    )
  }

  return lines.join('\n')
}

export function buildComposerRequestContent(
  content: string,
  references: ComposerReferenceAttachment[]
): string {
  const referencesPrompt = buildComposerReferencesPromptSection(references)
  return [content, referencesPrompt].filter(Boolean).join('\n\n')
}
