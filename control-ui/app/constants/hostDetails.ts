export const HOST_DEFAULT_TAB = 'details'

// The older saves (Overview, Model & credentials, guardrails) send the version
// the form was built from. Without one the page never loaded the Host, so
// nothing is sent (spec R16).
export const HOST_RELOAD_TO_SAVE_MESSAGE = 'Reload the page to save'

// Header line when the page's own read of the Host failed; the failure's
// message follows it.
export const HOST_LOAD_ERROR_PREFIX = "Could not load this agent's details:"

export const HOST_TABS = [
  'details',
  'identity',
  'model',
  'connectors',
  'access',
  'approvals',
  'advanced',
] as const

export type HostTab = (typeof HOST_TABS)[number]
