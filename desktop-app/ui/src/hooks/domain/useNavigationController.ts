import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../constants/navigation'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openSettingsTab,
} from '../../lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../lib/workspaceTabs.types'
import { mapKindToRoute, settingsSectionForRoute } from '../../lib/workspaceTabsRoute'
import type { AgentWorkspaceRoute, NavItem } from '../../uiTypes'

/**
 * Owner of the universal tab store (mini-spec 03 §3/§4/§6). The store lives here
 * — upstream of `useAgentChatController`, which reads `navItem` in its effect
 * deps — so `navItem` is a SAME-COMMIT derived projection of the active tab
 * (`mapKindToRoute`), never a second writer. Activating a tab flips `navItem` in
 * the same render as the `activeTabId` change, which preserves the
 * `handleSelectChatAgent` fast-path (`nav.navItem === chat`) with no
 * session-blank frame (§4/§9).
 *
 * The instance-less Apps picker (Apps route, no app launched) is the one
 * residual (§ decision B, directive 3): a bounded `navItem === 'sandbox-ui'`
 * flag with NO store tab and NO fabricated placeholder `appRef`. It is
 * single-sourced and cleared the instant any tab is (re)activated, so a derived
 * `navItem` and the residual can never both be live in one commit.
 */
export function useNavigationController() {
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTabsState>(() =>
    createWorkspaceTabsState('chat-tab-1')
  )
  // Residual: the Apps route shown with no launched app (the picker). Launching
  // an app creates a store app tab and clears this.
  const [appsPickerActive, setAppsPickerActive] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<AgentWorkspaceRoute>(
    AGENT_WORKSPACE_ROUTES.connectors
  )

  const workspaceTabsRef = useRef(workspaceTabs)
  workspaceTabsRef.current = workspaceTabs
  const tabSequenceRef = useRef(2)
  const nextWorkspaceTabId = useCallback(() => `ws-tab-${tabSequenceRef.current++}`, [])

  const activeTab = useMemo(() => activeWorkspaceTab(workspaceTabs), [workspaceTabs])
  const navItem: NavItem = appsPickerActive ? DESKTOP_ROUTES.apps : mapKindToRoute(activeTab)

  // The last chat tab that was active — the "chat to return to" when the drawer
  // is reopened over a non-chat tab (mini-spec 06 §1). It is NOT cleared by
  // navigating to files/app/settings (that is the whole point: the drawer
  // restores it); it is forgotten only when that tab is closed. Derived from the
  // single store, so every writer (nav, reveal, reconcile) updates it uniformly.
  const [lastActiveChatTabId, setLastActiveChatTabId] = useState<string | null>(null)
  useEffect(() => {
    setLastActiveChatTabId(prev => {
      if (activeTab?.kind === 'chat') return activeTab.id
      if (prev !== null && !workspaceTabs.tabs.some(tab => tab.id === prev)) return null
      return prev
    })
  }, [activeTab, workspaceTabs])

  const clearAppsPicker = useCallback(() => setAppsPickerActive(false), [])

  // Apps route with no launched app → the picker residual. Redundant (and thus
  // skipped) when an app tab is already active, since that already derives to
  // the Apps route.
  const showAppsPicker = useCallback(() => {
    setAppsPickerActive(activeWorkspaceTab(workspaceTabsRef.current)?.kind !== 'app')
  }, [])

  // Ensure a chat tab is active (navItem → chat this commit) without agent
  // logic: keep the active chat tab, else focus the last chat tab, else seed a
  // blank one. Agent selection is layered on by `handleSelectChatAgent`.
  //
  // This precedence is the SINGLE source of "which chat did the nav focus":
  // it RETURNS the focused conversation's identity (`agentRef`/`chatId`) when a
  // real chat is focused, or `null` when it keeps/seeds a blank chat. The caller
  // (`useAppController.handleNavSelect`) loads exactly that value instead of
  // re-deriving the same rule in its own layer, so the loaded chat can never
  // drift from the focused one (D4).
  const focusChatSection = useCallback((): { agentRef: string; chatId: string } | null => {
    setAppsPickerActive(false)
    const current = workspaceTabsRef.current
    const active = activeWorkspaceTab(current)
    const target =
      active?.kind === 'chat'
        ? active
        : [...current.tabs].reverse().find(tab => tab.kind === 'chat')
    if (target) {
      setWorkspaceTabs(state =>
        state.activeTabId === target.id ? state : { ...state, activeTabId: target.id }
      )
      return target.chat?.agentRef && target.chat.chatId
        ? { agentRef: target.chat.agentRef, chatId: target.chat.chatId }
        : null
    }
    setWorkspaceTabs(state => newChatTab(state, nextWorkspaceTabId(), null))
    return null
  }, [nextWorkspaceTabId])

  /**
   * Activate a chat tab so `navItem` derives to `chat` in the same commit as the
   * selection (the replacement for the old `nav.setNavItem(chat)`). Persisted
   * chats dedupe/focus by `chatId`; a blank selection reuses the active blank
   * chat or appends one. Used by `handleSelectChatAgent` on its non-`keepNavItem`
   * paths; the `keepNavItem` (drawer) paths never call it, so the app tab stays
   * active and the route stays on `apps`.
   */
  const activateChatTab = useCallback(
    (agentRef: string | null, chatId: string | null, title?: string) => {
      setAppsPickerActive(false)
      setWorkspaceTabs(current =>
        chatId
          ? openChatTab(current, {
              id: nextWorkspaceTabId(),
              agentRef,
              chatId,
              ...(title ? { title } : {}),
            })
          : newChatTab(current, nextWorkspaceTabId(), agentRef)
      )
    },
    [nextWorkspaceTabId]
  )

  const openSettingsSection = useCallback(
    (section: Parameters<typeof openSettingsTab>[1]['section']) => {
      setAppsPickerActive(false)
      setWorkspaceTabs(current => openSettingsTab(current, { id: nextWorkspaceTabId(), section }))
    },
    [nextWorkspaceTabId]
  )

  // Open/focus a files tab at `path` (a gfsUri, or `null` for the virtual root).
  // Dedupes by path in the store: the sidebar "Files" entry (root) and a plugin
  // deep-link to a specific gfsUri both route here (mini-spec 06 §3).
  const openFilesSection = useCallback(
    (path: string | null = null) => {
      setAppsPickerActive(false)
      setWorkspaceTabs(current => openFilesTab(current, { id: nextWorkspaceTabId(), path }))
    },
    [nextWorkspaceTabId]
  )

  // Base section navigation: every legacy `handleNavSelect(route)` call-site
  // routes here and becomes an open/focus tab action (the single writer). For
  // `chat`/`agents` it also clears `selectedAgent` exactly as before.
  // Returns the chat `focusChatSection` focused (for the chat route) so the
  // coordinator can load exactly that conversation; `null` for every other route
  // and for a blank/seeded chat.
  const handleNavSelect = useCallback(
    (item: NavItem): { agentRef: string; chatId: string } | null => {
      if (item === DESKTOP_ROUTES.chat) {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
        return focusChatSection()
      }
      if (item === DESKTOP_ROUTES.apps) {
        showAppsPicker()
        return null
      }
      if (item === DESKTOP_ROUTES.files) {
        openFilesSection()
        return null
      }
      const section = settingsSectionForRoute(item)
      if (!section) return null
      if (section === 'agents') {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
      }
      openSettingsSection(section)
      return null
    },
    [focusChatSection, openFilesSection, openSettingsSection, showAppsPicker]
  )

  const handleBackToAgents = useCallback(() => {
    setSelectedAgent(null)
    setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
  }, [])

  return {
    // Derived route (single-writer projection of the active tab).
    navItem,
    // Universal tab store.
    workspaceTabs,
    setWorkspaceTabs,
    activeTab,
    nextWorkspaceTabId,
    appsPickerActive,
    showAppsPicker,
    clearAppsPicker,
    activateChatTab,
    lastActiveChatTabId,
    openFilesSection,
    // Agent/chat selection state (stays here through this slice; §4).
    selectedAgent,
    selectedAgentRoute,
    setSelectedAgent,
    setSelectedAgentRoute,
    handleNavSelect,
    handleBackToAgents,
  }
}
