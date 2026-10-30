/** clerum__generate_markdown: the text, written as given. */
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
  writeArtifact,
} from './artifactOutput'
import type { InternalToolResult } from './types'

/** The file text, or an error saying what content must be; never a stringified array or object. */
function markdownContent(value: unknown): string | { error: string } {
  if (value === undefined || value === null) {
    return { error: 'content is required: pass the markdown text to write.' }
  }
  const lines = Array.isArray(value) ? value : [value]
  if (!lines.every(line => typeof line === 'string')) {
    const received = Array.isArray(value)
      ? 'an array with entries that are not text'
      : `a ${typeof value}`
    return {
      error: `content must be the markdown text as a string, or an array of lines; received ${received}.`,
    }
  }
  const text = lines.join('\n')
  if (!text.trim()) return { error: 'content is empty: pass the markdown text to write.' }
  return text
}

export async function runGenerateMarkdown(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'md', 'output')
    const content = markdownContent(args.content)
    if (typeof content !== 'string') return { success: false, error: content.error }

    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, Buffer.byteLength(content, 'utf-8'), replacedBytes(target))
    writeArtifact(target, content)

    return artifactResult(target, 'md')
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
