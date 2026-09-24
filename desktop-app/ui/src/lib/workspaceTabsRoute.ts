import { DESKTOP_ROUTES } from '@constants/navigation'
import type { NavItem } from '../uiTypes'
import type { SettingsSection, WorkspaceTab } from './workspaceTabs.types'

/**
 * Read-only projection of the universal tab store onto the legacy `navItem`
 * route (spec 01 §4.0/§4.2, mini-spec 03 §6). The store is the single writer;
 * `navItem` is DERIVED from the active tab so `NavigationContext` consumers
 * (`HeaderActions`, desktop commands, the render seam) keep reading a route.
 *
 * Total: an empty workspace (no active tab) maps to `chat`, the neutral default
 * for `desktopCommandContext` (§5). The instance-less Apps picker is represented
 * OUTSIDE this map (a bounded `navItem==='sandbox-ui'` residual owned by the
 * controller), not as a fabricated placeholder app tab.
 */

const SETTINGS_SECTION_TO_ROUTE: Record<SettingsSection, NavItem> = {
  connectors: DESKTOP_ROUTES.connectors,
  agents: DESKTOP_ROUTES.agents,
  plugins: DESKTOP_ROUTES.plugins,
  settings: DESKTOP_ROUTES.settings,
}

const ROUTE_TO_SETTINGS_SECTION: Partial<Record<NavItem, SettingsSection>> = {
  [DESKTOP_ROUTES.connectors]: 'connectors',
  [DESKTOP_ROUTES.agents]: 'agents',
  [DESKTOP_ROUTES.plugins]: 'plugins',
  [DESKTOP_ROUTES.settings]: 'settings',
}

export function mapKindToRoute(tab: WorkspaceTab | undefined): NavItem {
  if (!tab) return DESKTOP_ROUTES.chat
  switch (tab.kind) {
    case 'chat':
      return DESKTOP_ROUTES.chat
    case 'app':
      return DESKTOP_ROUTES.apps
    case 'files':
      return DESKTOP_ROUTES.files
    case 'preview':
      return DESKTOP_ROUTES.preview
    case 'settings':
      return SETTINGS_SECTION_TO_ROUTE[tab.settings?.section ?? 'settings']
  }
}

/**
 * Reverse of `mapKindToRoute` for the `settings`-kind routes only. Returns the
 * `SettingsSection` a sidebar/command navigation to `item` opens, or `null` for
 * routes that are not settings-kind tabs (`chat`, `files`, `apps`) — those are
 * handled by their own store actions.
 */
export function settingsSectionForRoute(item: NavItem): SettingsSection | null {
  return ROUTE_TO_SETTINGS_SECTION[item] ?? null
}
