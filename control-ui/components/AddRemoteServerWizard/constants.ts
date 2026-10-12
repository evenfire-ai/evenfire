import type { RemoteDiscoverRegistrationMode } from '../../lib/remoteMcp.types'
import type { GrantScopeOption } from './types'

export const REMOTE_WIZARD_STEPS = ['Identify', 'Configure', 'Confirm'] as const

export const REMOTE_WIZARD_STEP_DETAILS = [
  {
    description: 'URL, name, and agent context',
    title: 'Identify the remote server',
    subtitle: 'Enter the remote MCP server URL, name it, and pick the context to attach it to.',
  },
  {
    description: 'Detected OAuth configuration',
    title: 'Configure OAuth',
    subtitle: 'Review what discovery detected and provide any credentials the server requires.',
  },
  {
    description: 'Review and install',
    title: 'Confirm and install',
    subtitle: 'Review the pinned configuration, then install the remote connector.',
  },
] as const

export const GRANT_SCOPE_OPTIONS: readonly GrantScopeOption[] = [
  {
    value: 'user',
    label: 'Per user',
    description: 'Each user authorizes and holds their own token (recommended).',
  },
  {
    value: 'context',
    label: 'Per context',
    description: 'One shared token for everyone using this context.',
  },
]

/** Short, operator-facing label for each detected registration mode. */
export const REGISTRATION_MODE_LABEL: Record<RemoteDiscoverRegistrationMode, string> = {
  cimd: 'Client ID Metadata Document (public client)',
  dcr: 'Dynamic Client Registration',
  manual: 'Pre-registered client required',
}

/** One-line explanation shown under the detected mode. */
export const REGISTRATION_MODE_HINT: Record<RemoteDiscoverRegistrationMode, string> = {
  cimd: 'This platform registers as a public client automatically — no credentials needed.',
  dcr: 'This platform registers a client dynamically and manages its credentials for you.',
  manual:
    'The server offers neither CIMD nor dynamic registration, so you must supply a pre-registered client_id and client_secret.',
}
