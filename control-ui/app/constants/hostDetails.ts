export const HOST_DEFAULT_TAB = 'details'

// Spec §6.5's refusal for a save with no version to send. The older saves
// (Overview, Model & credentials, guardrails) send the version the form was
// built from; without one the page never loaded the Host, so nothing is sent
// (spec R16). The approval saves (lib/hostApprovalSave) send their own read's
// version and refuse the same way when that read carried none.
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
