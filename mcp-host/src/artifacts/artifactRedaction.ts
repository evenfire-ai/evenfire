/**
 * Best-effort substring redaction for artifacts streamed through mcp-host.
 *
 * The shell output sanitizer covers stdout/stderr, but an approved shell step
 * can still write secret-bearing env output to disk. Runtime downloads must
 * apply the same ConfigStore secret-entry boundary before bytes leave mcp-host.
 */
export type ArtifactSecretEntry = {
  name: string
  value: string
}

export function redactArtifactBuffer(
  buf: Buffer,
  entries: ArtifactSecretEntry[]
): { buffer: Buffer; redactedCount: number } {
  if (entries.length === 0) return { buffer: buf, redactedCount: 0 }

  let text = buf.toString('latin1')
  let redactedCount = 0

  const sortedEntries = [...entries].sort((a, b) => b.value.length - a.value.length)
  for (const entry of sortedEntries) {
    if (!entry.value || entry.value.length < 4) continue
    const valueAsLatin1 = Buffer.from(entry.value, 'utf-8').toString('latin1')
    if (!text.includes(valueAsLatin1)) continue

    const before = text
    text = text.split(valueAsLatin1).join(`[REDACTED:${entry.name}]`)
    if (text !== before) redactedCount += 1
  }

  if (redactedCount === 0) return { buffer: buf, redactedCount: 0 }
  return { buffer: Buffer.from(text, 'latin1'), redactedCount }
}
