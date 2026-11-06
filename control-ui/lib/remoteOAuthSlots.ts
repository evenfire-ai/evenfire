import type {
  RegistryInstalledState,
  RegistryManualRemoteOAuthServer,
  RegistryRemoteOAuthGrantScope,
} from './api'
import { getRemoteOAuthSlots } from './oauthInstall'
import type { RemoteOAuthCatalogView } from './oauthInstall.types'
import type {
  RemoteOAuthSlotRow,
  RemoteOAuthSlotStatus,
  RemoteOAuthVerificationKind,
} from './remoteOAuthSlots.types'

type ValidRemoteOAuthView = Extract<RemoteOAuthCatalogView, { valid: true }>

export const REMOTE_OAUTH_SLOT_LABELS: Record<RegistryRemoteOAuthGrantScope, string> = {
  user: 'Per user',
  context: 'Per context',
}

/**
 * The form control-api compares remote base URLs in: lowercase scheme and host (the
 * URL parser does both), no default port, no trailing slash, null for anything that
 * does not parse or carries credentials. It must stay identical to the server's
 * `normalizeRemoteBaseUrl`; the UI test checks it against that function's output.
 */
export function normalizeRemoteBaseUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username !== '' || parsed.password !== '') return null
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`
}

function slotStatus(
  state: NonNullable<ReturnType<typeof getRemoteOAuthSlots>>[RegistryRemoteOAuthGrantScope]
): RemoteOAuthSlotStatus {
  if (!state) return { kind: 'free' }
  if (state.kind === 'foreign') return { kind: 'occupied', serverName: state.serverName }
  if (state.terminating) return { kind: 'uninstalling', serverName: state.serverName }
  return {
    kind: 'installed',
    serverName: state.serverName,
    version: state.version,
    canonical: state.canonical,
  }
}

/**
 * One row per grant scope the entry allows, in the entry's order. The state comes from
 * `installed.remoteOAuthSlots` only: control-api keeps these instances out of
 * `catalogKeys`, and a name match would not tell the two slots apart.
 */
export function remoteOAuthSlotRows(
  view: ValidRemoteOAuthView,
  entryName: string,
  installed: Pick<RegistryInstalledState, 'remoteOAuthSlots' | 'manualRemoteOAuth'> | null
): RemoteOAuthSlotRow[] {
  const slots = getRemoteOAuthSlots(installed, entryName)
  const entryUrl = normalizeRemoteBaseUrl(view.url)
  const manual: RegistryManualRemoteOAuthServer[] = installed?.manualRemoteOAuth ?? []
  return view.block.allowedGrantScopes.map(scope => ({
    scope,
    label: REMOTE_OAUTH_SLOT_LABELS[scope],
    status: slotStatus(slots?.[scope]),
    manualMatches:
      entryUrl === null
        ? []
        : manual.filter(
            server =>
              server.grantScope === scope && normalizeRemoteBaseUrl(server.baseUrl) === entryUrl
          ),
  }))
}

export function canInstallRemoteOAuthSlot(row: RemoteOAuthSlotRow): boolean {
  return row.status.kind === 'free'
}

/** The verification bucket a valid entry falls in; a non-curator entry is never verified. */
export function remoteOAuthVerificationKind(
  view: Pick<ValidRemoteOAuthView, 'trusted' | 'block'>
): RemoteOAuthVerificationKind {
  if (!view.trusted) return 'third-party'
  const status = view.block.verification?.status
  if (status === 'verified' || status === 'known-issue') return status
  return 'untested'
}

/** The one-line state of a slot as the Marketplace shows it. */
export function remoteOAuthSlotStatusText(status: RemoteOAuthSlotStatus): string {
  switch (status.kind) {
    case 'free':
      return 'Not installed'
    case 'installed':
      return status.canonical
        ? `Installed · v${status.version} · ${status.serverName}`
        : `Occupied by ${status.serverName} · v${status.version}`
    case 'uninstalling':
      return `Uninstalling ${status.serverName}…`
    case 'occupied':
      return `Occupied by ${status.serverName}`
  }
}

/** Why a slot cannot take an install although it may look empty, or null. */
export function remoteOAuthSlotNotice(status: RemoteOAuthSlotStatus): string | null {
  if (status.kind === 'installed' && !status.canonical) {
    return `${status.serverName} carries this entry under a name other than the slot's, so the slot counts as installed.`
  }
  if (status.kind === 'occupied') {
    return `${status.serverName} was not installed from this entry but uses the name this slot installs under.`
  }
  return null
}

/** The manual-install notice of a slot: a connector installed by URL already serves it. */
export function remoteOAuthManualNotice(row: RemoteOAuthSlotRow): string | null {
  if (row.manualMatches.length === 0) return null
  const names = row.manualMatches.map(server => `'${server.serverName}'`).join(', ')
  return `Manual instance with this URL: ${names} (${row.label.toLowerCase()})`
}
