// Registry `entry_type` values, as sent on the wire. Shared by the surfaces
// that link into a type-filtered entries list and the list that reads the
// filter back off the URL, so the two never drift apart.
export const GUARDRAIL_ENTRY_TYPE = 'llm-hook'

// Human labels for the active-filter notice on the entries list. Only types
// that something links to with `?type=` need an entry here.
export const MARKETPLACE_ENTRY_TYPE_LABELS: Record<string, string> = {
  'llm-hook': 'Guardrail hooks',
  'mcp-server': 'Connectors',
  recipe: 'Plugins',
}
