// A minimal shape of an agent (Host) directory entry: the immutable identifier
// (`metadata.name`) mapped to the editable visible name (`spec.host`). `spec` is
// intentionally a loose record so a full HostResource is assignable here.
type AgentDirectoryHost = {
  metadata?: { name?: string }
  spec?: Record<string, unknown>
}

// Resolve the human-visible name for an agent identifier. When a directory of
// Hosts is provided, the agent's editable display name (`spec.host`) wins;
// otherwise (or when the entry has no display name) it falls back to the slug
// identifier — never a silent empty label.
export function getAgentDisplayName(
  agentName: string,
  directory?: readonly AgentDirectoryHost[]
): string {
  const trimmed = String(agentName || '').trim()
  if (!trimmed) return ''
  if (directory) {
    const match = directory.find(host => String(host?.metadata?.name || '').trim() === trimmed)
    const display = String((match?.spec as { host?: string } | undefined)?.host || '').trim()
    if (display) return display
  }
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.length === 0) return trimmed
  return segments[segments.length - 1]
}
