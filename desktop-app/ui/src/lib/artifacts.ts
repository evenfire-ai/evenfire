const ARTIFACT_FILENAME_PATTERN =
  /\b([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:pdf|md|docx|xlsx|pptx|png|txt|csv|json|html?))\b/gi

export function extractArtifactNames(content: string): string[] {
  const found = content.match(ARTIFACT_FILENAME_PATTERN) || []
  const unique = new Set<string>()
  for (const name of found) {
    const trimmed = name.trim()
    if (!trimmed) continue
    unique.add(trimmed)
  }
  return [...unique]
}
