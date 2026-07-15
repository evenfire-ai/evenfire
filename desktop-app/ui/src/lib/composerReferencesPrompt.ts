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

function formatGlobalFileReference(
  reference: Extract<ComposerReferenceAttachment, { type: 'global_file' }>
): string {
  const label = normalizeComposerReferenceName(reference.label)
  const gfsUri = normalizeComposerReferenceName(reference.gfsUri)
  if (!gfsUri) return ''
  return label ? `${label} (${gfsUri})` : gfsUri
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

  const globalFiles = references
    .filter(
      (reference): reference is Extract<ComposerReferenceAttachment, { type: 'global_file' }> =>
        reference.type === 'global_file'
    )
    .map(formatGlobalFileReference)
    .filter(Boolean)

  if (!plugins.length && !connectors.length && !agentFiles.length && !globalFiles.length) {
    return null
  }

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

  if (globalFiles.length) {
    lines.push(
      `Global Files: ${globalFiles.join(', ')}. These files were explicitly selected by the user. Use clerum__gfs_resolve for each gfs:// URI, then clerum__gfs_read with its drive and resourceId before relying on its contents.`
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
