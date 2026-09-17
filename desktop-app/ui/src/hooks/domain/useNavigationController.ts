import { useCallback, useMemo, useRef, useState } from 'react'
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
  const focusChatSection = useCallback(() => {
    setAppsPickerActive(false)
    setWorkspaceTabs(current => {
      const active = activeWorkspaceTab(current)
      if (active?.kind === 'chat') return current
      const lastChat = [...current.tabs].reverse().find(tab => tab.kind === 'chat')
      if (lastChat) return { ...current, activeTabId: lastChat.id }
      return newChatTab(current, nextWorkspaceTabId(), null)
    })
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

  const openFilesSection = useCallback(() => {
    setAppsPickerActive(false)
    setWorkspaceTabs(current => openFilesTab(current, { id: nextWorkspaceTabId() }))
  }, [nextWorkspaceTabId])

  // Base section navigation: every legacy `handleNavSelect(route)` call-site
  // routes here and becomes an open/focus tab action (the single writer). For
  // `chat`/`agents` it also clears `selectedAgent` exactly as before.
  const handleNavSelect = useCallback(
    (item: NavItem) => {
      if (item === DESKTOP_ROUTES.chat) {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
        focusChatSection()
        return
      }
      if (item === DESKTOP_ROUTES.apps) {
        showAppsPicker()
        return
      }
      if (item === DESKTOP_ROUTES.files) {
        openFilesSection()
        return
      }
      const section = settingsSectionForRoute(item)
      if (!section) return
      if (section === 'agents') {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
      }
      openSettingsSection(section)
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
    // Agent/chat selection state (stays here through this slice; §4).
    selectedAgent,
    selectedAgentRoute,
    setSelectedAgent,
    setSelectedAgentRoute,
    handleNavSelect,
    handleBackToAgents,
  }
}
