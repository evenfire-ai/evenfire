// Registry `entry_type` values, as sent on the wire. Shared by the surfaces
// that link into a type-filtered entries list and the list that reads the
// filter back off the URL, so the two never drift apart.
export const GUARDRAIL_ENTRY_TYPE = 'llm-hook'

// Human labels for the active-filter notice on the entries list. Only types
// that something links to with `?type=` need an entry here.
//
// Null-prototype on purpose: the keys are indexed with an untrusted `?type=`
// value off the URL, so an inherited key (`toString`, `constructor`, …) would
// otherwise resolve to a function and be treated as a real label.
export const MARKETPLACE_ENTRY_TYPE_LABELS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    'llm-hook': 'Guardrail hooks',
    'mcp-server': 'Connectors',
    recipe: 'Plugins',
  }
)
