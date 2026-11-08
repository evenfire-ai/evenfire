import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../constants/navigation'
import type { GfsPreviewResource } from '../../lib/gfsPreview'
import {
  type GfsResourceNavigationContext,
  type GfsResourceNavigationRequest,
  assignGfsResourceNavigationOwner,
  canCompleteGfsResourceNavigation,
  isGfsResourceNavigationActivationCurrent,
  isGfsResourceNavigationOwnerPresent,
} from '../../lib/gfsResourceNavigationIntent'
import {
  activeWorkspaceTab,
  createFilesTab,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTab,
  setFilesTabPath,
  setFilesTabUnavailable,
} from '../../lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../lib/workspaceTabs.types'
import type { WorkspaceTab } from '../../lib/workspaceTabs.types'
import { mapKindToRoute, settingsSectionForRoute } from '../../lib/workspaceTabsRoute'
import type { AgentWorkspaceRoute, NavItem } from '../../uiTypes'

export interface WorkspaceNavigationSnapshot {
  workspaceTabs: WorkspaceTabsState
  selectedAgent: string | null
  selectedAgentRoute: AgentWorkspaceRoute
  appsPickerActive: boolean
  lastActiveChatTabId: string | null
}

export interface GfsConvergenceLocationEntry {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: 'file' | 'directory'
  version: number
}

export type GfsConvergenceLocationResult =
  | {
      available: true
      location: GfsConvergenceLocationEntry
      breadcrumbs: GfsConvergenceLocationEntry[]
    }
  | { available: false }

interface FilesPathOwner {
  path: string | null
  pathRevision: number
  intentSequence: number
  intentMutationEpoch: number
  intentPending: boolean
  mutationEpoch: number
  pendingEpoch: number | null
  inFlight: boolean
  inFlightSessionGeneration: number | null
  latestSessionGeneration: number | null
  rerunAfterFlight: boolean
}

export interface FilesPathIntentReceipt {
  tabId: string
  sequence: number
  path: string | null
  pathRevision: number
  mutationEpoch: number
}

export type ResolveFilesConvergenceLocation = (
  uri: string,
  sessionGeneration: number,
  options?: { signal?: AbortSignal }
) => Promise<GfsConvergenceLocationResult>

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
  const [workspaceTabs, setWorkspaceTabsState] = useState<WorkspaceTabsState>(() =>
    createWorkspaceTabsState('chat-tab-1')
  )
  const workspaceTabsRef = useRef(workspaceTabs)
  const setWorkspaceTabs = useCallback((action: SetStateAction<WorkspaceTabsState>) => {
    const current = workspaceTabsRef.current
    const next = typeof action === 'function' ? action(current) : action
    if (next === current) return
    workspaceTabsRef.current = next
    setWorkspaceTabsState(next)
  }, [])
  const filesPathOwnersRef = useRef(new Map<string, FilesPathOwner>())
  const filesMutationEpochRef = useRef(0)
  const [filesMutationEpoch, setFilesMutationEpoch] = useState(0)
  const filesPathOwnerFor = useCallback((tabId: string): FilesPathOwner | null => {
    const tab = workspaceTabsRef.current.tabs.find(
      (candidate): candidate is WorkspaceTab & { kind: 'files' } =>
        candidate.id === tabId && candidate.kind === 'files'
    )
    if (!tab) return null
    let owner = filesPathOwnersRef.current.get(tabId)
    const path = tab.files?.path ?? null
    if (!owner) {
      owner = {
        path,
        pathRevision: 0,
        intentSequence: 0,
        intentMutationEpoch: 0,
        intentPending: false,
        mutationEpoch: filesMutationEpochRef.current,
        pendingEpoch: null,
        inFlight: false,
        inFlightSessionGeneration: null,
        latestSessionGeneration: null,
        rerunAfterFlight: false,
      }
      filesPathOwnersRef.current.set(tabId, owner)
    } else if (!owner.intentPending && owner.path !== path && !owner.inFlight) {
      owner.path = path
      owner.pathRevision += 1
    }
    return owner
  }, [])
  const beginFilesPathIntent = useCallback(
    (tabId: string): FilesPathIntentReceipt | null => {
      const owner = filesPathOwnerFor(tabId)
      if (!owner) return null
      setWorkspaceTabs(state => setFilesTabUnavailable(state, tabId, false))
      owner.intentSequence += 1
      owner.intentPending = true
      owner.intentMutationEpoch = filesMutationEpochRef.current
      return {
        tabId,
        sequence: owner.intentSequence,
        path: owner.path,
        pathRevision: owner.pathRevision,
        mutationEpoch: owner.intentMutationEpoch,
      }
    },
    [filesPathOwnerFor, setWorkspaceTabs]
  )
  const commitFilesPathIntent = useCallback(
    (receipt: FilesPathIntentReceipt, path: string | null, name: string | null): boolean => {
      const owner = filesPathOwnersRef.current.get(receipt.tabId)
      if (!owner || owner.intentSequence !== receipt.sequence || !owner.intentPending) return false
      const mutationArrivedDuringIntent = filesMutationEpochRef.current > receipt.mutationEpoch
      owner.intentPending = false
      owner.path = path
      owner.pathRevision += 1
      setWorkspaceTabs(state =>
        setFilesTabPath(
          state,
          receipt.tabId,
          path,
          mutationArrivedDuringIntent ? undefined : (name ?? undefined)
        )
      )
      if (mutationArrivedDuringIntent) {
        owner.pendingEpoch = filesMutationEpochRef.current
      }
      return true
    },
    [setWorkspaceTabs]
  )
  const failFilesPathIntent = useCallback((receipt: FilesPathIntentReceipt): boolean => {
    const owner = filesPathOwnersRef.current.get(receipt.tabId)
    if (!owner || owner.intentSequence !== receipt.sequence || !owner.intentPending) return false
    owner.intentPending = false
    if (
      owner.pathRevision === receipt.pathRevision &&
      owner.path === receipt.path &&
      filesMutationEpochRef.current > receipt.mutationEpoch
    ) {
      owner.pendingEpoch = filesMutationEpochRef.current
    }
    return true
  }, [])
  const recordFilesMutation = useCallback((): number => {
    const epoch = ++filesMutationEpochRef.current
    setFilesMutationEpoch(epoch)
    for (const tab of workspaceTabsRef.current.tabs) {
      if (tab.kind !== 'files') continue
      const owner = filesPathOwnerFor(tab.id)
      if (!owner) continue
      owner.mutationEpoch = epoch
      owner.pendingEpoch = epoch
      if (owner.inFlight) owner.rerunAfterFlight = true
    }
    return epoch
  }, [filesPathOwnerFor])
  const markFilesPathsUnavailable = useCallback(() => {
    for (const tab of workspaceTabsRef.current.tabs) {
      if (tab.kind === 'files' && tab.files?.path) {
        setWorkspaceTabs(state => setFilesTabUnavailable(state, tab.id, true))
      }
    }
  }, [setWorkspaceTabs])
  const runFilesConvergence = useCallback(
    async (
      tabId: string,
      sessionGeneration: number,
      resolve: ResolveFilesConvergenceLocation
    ): Promise<void> => {
      const owner = filesPathOwnerFor(tabId)
      if (!owner) {
        filesPathOwnersRef.current.delete(tabId)
        return
      }
      owner.latestSessionGeneration = sessionGeneration
      const tab = workspaceTabsRef.current.tabs.find(candidate => candidate.id === tabId)
      const savedPath = tab?.kind === 'files' ? (tab.files?.path ?? null) : null
      if (!savedPath) {
        owner.pendingEpoch = null
        return
      }
      if (owner.intentPending) return
      if (owner.inFlight) {
        if (owner.inFlightSessionGeneration !== sessionGeneration) {
          owner.pendingEpoch ??= filesMutationEpochRef.current
          owner.rerunAfterFlight = true
        }
        return
      }
      const captured = {
        path: savedPath,
        pathRevision: owner.pathRevision,
        mutationEpoch: owner.pendingEpoch ?? filesMutationEpochRef.current,
        intentSequence: owner.intentSequence,
        sessionGeneration,
      }
      owner.pendingEpoch = null
      owner.inFlight = true
      owner.inFlightSessionGeneration = sessionGeneration
      try {
        const result = await resolve(savedPath, sessionGeneration)
        const latest = filesPathOwnerFor(tabId)
        if (!latest) return
        const latestTab = workspaceTabsRef.current.tabs.find(candidate => candidate.id === tabId)
        const sameSavedPath =
          latestTab?.kind === 'files' &&
          (latestTab.files?.path ?? null) === captured.path &&
          latest.pathRevision === captured.pathRevision
        const intentUnchanged =
          latest.intentSequence === captured.intentSequence && !latest.intentPending
        const epochUnchanged = filesMutationEpochRef.current === captured.mutationEpoch
        const sessionGenerationUnchanged =
          latest.latestSessionGeneration === captured.sessionGeneration
        if (sameSavedPath && intentUnchanged && epochUnchanged && sessionGenerationUnchanged) {
          if (result.available) {
            setWorkspaceTabs(state =>
              setFilesTabPath(state, tabId, result.location.gfsUri, result.location.name)
            )
            latest.path = result.location.gfsUri
            latest.pathRevision += 1
            setWorkspaceTabs(state => setFilesTabUnavailable(state, tabId, false))
          } else {
            setWorkspaceTabs(state => setFilesTabUnavailable(state, tabId, true))
          }
        } else if (
          filesMutationEpochRef.current > captured.mutationEpoch ||
          !sessionGenerationUnchanged
        ) {
          latest.pendingEpoch = filesMutationEpochRef.current
          latest.rerunAfterFlight = true
        }
      } catch {
        const latest = filesPathOwnersRef.current.get(tabId)
        const latestTab = workspaceTabsRef.current.tabs.find(candidate => candidate.id === tabId)
        if (
          latest &&
          latestTab?.kind === 'files' &&
          (latestTab.files?.path ?? null) === captured.path &&
          latest.pathRevision === captured.pathRevision &&
          latest.intentSequence === captured.intentSequence &&
          filesMutationEpochRef.current === captured.mutationEpoch &&
          latest.latestSessionGeneration === captured.sessionGeneration
        ) {
          setWorkspaceTabs(state => setFilesTabUnavailable(state, tabId, true))
        }
      } finally {
        const latest = filesPathOwnersRef.current.get(tabId)
        if (!latest) return
        latest.inFlight = false
        latest.inFlightSessionGeneration = null
        const shouldRerun = latest.rerunAfterFlight || latest.pendingEpoch !== null
        latest.rerunAfterFlight = false
        if (shouldRerun && !latest.intentPending && latest.pendingEpoch !== null) {
          const nextGeneration = latest.latestSessionGeneration ?? sessionGeneration
          void runFilesConvergenceRef.current?.(tabId, nextGeneration, resolve)
        }
      }
    },
    [filesPathOwnerFor, setWorkspaceTabs]
  )
  const runFilesConvergenceRef = useRef(runFilesConvergence)
  runFilesConvergenceRef.current = runFilesConvergence
  const reconcileFilesConvergence = useCallback(
    async (sessionGeneration: number, resolve: ResolveFilesConvergenceLocation) => {
      for (const tab of workspaceTabsRef.current.tabs) {
        if (tab.kind !== 'files') continue
        const owner = filesPathOwnerFor(tab.id)
        if (owner) owner.latestSessionGeneration = sessionGeneration
        if (owner?.inFlight && owner.inFlightSessionGeneration !== sessionGeneration) {
          owner.pendingEpoch ??= filesMutationEpochRef.current
          owner.rerunAfterFlight = true
        }
        if (owner?.pendingEpoch !== null && owner?.pendingEpoch !== undefined) {
          void runFilesConvergence(tab.id, sessionGeneration, resolve)
        }
      }
    },
    [filesPathOwnerFor, runFilesConvergence]
  )
  const [navigationIntentSequence, setNavigationIntentSequence] = useState(0)
  const navigationIntentSequenceRef = useRef(0)
  const userNavigationGenerationRef = useRef<number | null>(null)
  const userNavigationGenerationUnavailableRef = useRef(false)
  const currentUserNavigationGeneration = useCallback((): number | null => {
    if (userNavigationGenerationUnavailableRef.current) return null
    if (userNavigationGenerationRef.current !== null) return userNavigationGenerationRef.current
    try {
      const generation =
        typeof window === 'undefined'
          ? undefined
          : window.clerum?.gfs?.getUserNavigationGeneration?.()
      if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) {
        userNavigationGenerationRef.current = generation
      }
    } catch {
      return null
    }
    return userNavigationGenerationRef.current
  }, [])
  const beginNavigationIntent = useCallback(() => {
    const next = navigationIntentSequenceRef.current + 1
    navigationIntentSequenceRef.current = next
    setNavigationIntentSequence(next)
    return next
  }, [])
  const beginUserNavigationIntent = useCallback(() => {
    const advance =
      typeof window === 'undefined'
        ? undefined
        : window.clerum?.gfs?.advanceUserNavigationGeneration
    try {
      if (!advance) throw new Error('The main process GFS navigation generation is unavailable')
      const nextGeneration = advance()
      if (
        typeof nextGeneration !== 'number' ||
        !Number.isSafeInteger(nextGeneration) ||
        nextGeneration < 0
      ) {
        throw new Error('The main process returned an invalid GFS navigation generation')
      }
      userNavigationGenerationRef.current = nextGeneration
      userNavigationGenerationUnavailableRef.current = false
    } catch {
      // Keep local navigation responsive, but do not let an old main value
      // make links eligible after an explicit action we could not order.
      userNavigationGenerationRef.current = null
      userNavigationGenerationUnavailableRef.current = true
    }
    return beginNavigationIntent()
  }, [beginNavigationIntent])
  const isNavigationIntentCurrent = useCallback(
    (sequence: number) => navigationIntentSequenceRef.current === sequence,
    []
  )
  // Residual: the Apps route shown with no launched app (the picker). Launching
  // an app creates a store app tab and clears this.
  const [appsPickerActive, setAppsPickerActive] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<AgentWorkspaceRoute>(
    AGENT_WORKSPACE_ROUTES.connectors
  )

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
  // Mirror of `lastActiveChatTabId` for the synchronous read in `focusChatSection`
  // (it runs against `workspaceTabsRef.current`, not the render's snapshot).
  const lastActiveChatTabIdRef = useRef(lastActiveChatTabId)
  lastActiveChatTabIdRef.current = lastActiveChatTabId

  const clearAppsPicker = useCallback(() => setAppsPickerActive(false), [])

  // Session identity owns the workspace contents. Tear navigation down before a
  // different principal is published, and give the new session one fresh blank
  // Chat tab. Advancing the local intent sequence fences pending continuations;
  // this is not a user selection and does not advance the main-process link
  // generation.
  const resetSessionNavigation = useCallback(() => {
    beginNavigationIntent()
    setSelectedAgent(null)
    setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
    setAppsPickerActive(false)
    const chatTabId = nextWorkspaceTabId()
    setWorkspaceTabs(createWorkspaceTabsState(chatTabId))
    lastActiveChatTabIdRef.current = chatTabId
    setLastActiveChatTabId(chatTabId)
  }, [beginNavigationIntent, nextWorkspaceTabId, setWorkspaceTabs])

  const captureWorkspaceNavigation = useCallback(
    (): WorkspaceNavigationSnapshot => ({
      workspaceTabs: workspaceTabsRef.current,
      selectedAgent,
      selectedAgentRoute,
      appsPickerActive,
      lastActiveChatTabId: lastActiveChatTabIdRef.current,
    }),
    [appsPickerActive, selectedAgent, selectedAgentRoute]
  )

  const restoreWorkspaceNavigation = useCallback(
    (snapshot: WorkspaceNavigationSnapshot, expectedIntentSequence: number): number | null => {
      if (!isNavigationIntentCurrent(expectedIntentSequence)) return null
      const restoredIntentSequence = beginNavigationIntent()
      setWorkspaceTabs(snapshot.workspaceTabs)
      setSelectedAgent(snapshot.selectedAgent)
      setSelectedAgentRoute(snapshot.selectedAgentRoute)
      setAppsPickerActive(snapshot.appsPickerActive)
      lastActiveChatTabIdRef.current = snapshot.lastActiveChatTabId
      setLastActiveChatTabId(snapshot.lastActiveChatTabId)
      return restoredIntentSequence
    },
    [beginNavigationIntent, isNavigationIntentCurrent, setWorkspaceTabs]
  )

  // Apps route with no launched app → the picker residual. Redundant (and thus
  // skipped) when an app tab is already active, since that already derives to
  // the Apps route.
  const showAppsPicker = useCallback(() => {
    beginUserNavigationIntent()
    setAppsPickerActive(activeWorkspaceTab(workspaceTabsRef.current)?.kind !== 'app')
  }, [beginUserNavigationIntent])

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
  const focusChatSection = useCallback(
    (
      source: 'explicit' | 'programmatic' = 'explicit',
      navigationIntentAlreadyStarted = false
    ): { agentRef: string; chatId: string } | null => {
      if (source === 'explicit') {
        if (!navigationIntentAlreadyStarted) beginUserNavigationIntent()
      } else if (navigationIntentSequenceRef.current > 0) {
        // Bootstrap must not replace a tab selected while authentication loads.
        return null
      }
      const current = workspaceTabsRef.current
      const active = activeWorkspaceTab(current)
      setAppsPickerActive(false)
      const lastActiveId = lastActiveChatTabIdRef.current
      const resumeTarget =
        lastActiveId !== null
          ? current.tabs.find(tab => tab.id === lastActiveId && tab.kind === 'chat')
          : undefined
      const target =
        active?.kind === 'chat'
          ? active
          : (resumeTarget ?? [...current.tabs].reverse().find(tab => tab.kind === 'chat'))
      if (target) {
        setWorkspaceTabs(state =>
          state.activeTabId === target.id ? state : { ...state, activeTabId: target.id }
        )
        return target.chat?.agentRef && target.chat.chatId
          ? { agentRef: target.chat.agentRef, chatId: target.chat.chatId }
          : null
      }
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(state => newChatTab(state, id, null))
      return null
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  /**
   * Activate a chat tab so `navItem` derives to `chat` in the same commit as the
   * selection (the replacement for the old `nav.setNavItem(chat)`). Persisted
   * chats dedupe/focus by `chatId`; a blank selection reuses the active blank
   * chat or appends one. Used by `handleSelectChatAgent` on its non-`keepNavItem`
   * paths; the `keepNavItem` (drawer) paths never call it, so the app tab stays
   * active and the route stays on `apps`.
   */
  const activateChatTab = useCallback(
    (
      agentRef: string | null,
      chatId: string | null,
      title?: string,
      navigationIntentAlreadyStarted = false
    ) => {
      if (!navigationIntentAlreadyStarted) beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current =>
        chatId
          ? openChatTab(current, {
              id,
              agentRef,
              chatId,
              ...(title ? { title } : {}),
            })
          : newChatTab(current, id, agentRef)
      )
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  const openSettingsSection = useCallback(
    (
      section: Parameters<typeof openSettingsTab>[1]['section'],
      navigationIntentAlreadyStarted = false
    ) => {
      if (!navigationIntentAlreadyStarted) beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current => openSettingsTab(current, { id, section }))
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  // Open/focus a files tab at `path` (a gfsUri, or `null` for the virtual root).
  // Dedupes by path in the store: the sidebar "Files" entry (root) and a plugin
  // deep-link to a specific gfsUri both route here (mini-spec 06 §3).
  const openFilesSection = useCallback(
    (path: string | null = null) => {
      const intentSequence = beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      const next = openFilesTab(workspaceTabsRef.current, { id, path })
      const ownerTabId = next.activeTabId
      if (!ownerTabId) return null
      setWorkspaceTabs(next)
      return { ownerTabId, intentSequence }
    },
    [beginUserNavigationIntent, nextWorkspaceTabId, setWorkspaceTabs]
  )

  // Open/focus a preview tab for a previewable file (spec 18 §3.B.1). Dedupes by
  // gfsUri in the store: opening the same file twice focuses its existing tab
  // instead of stacking duplicates. A direct clone of `openFilesSection`.
  const openPreviewSection = useCallback(
    (preview: GfsPreviewResource, sessionScope?: string) => {
      beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current =>
        openPreviewTab(current, {
          id,
          title: preview.name,
          gfsUri: preview.gfsUri,
          ...(sessionScope !== undefined ? { sessionScope } : {}),
          fileKind: preview.kind,
          byteLength: preview.bytes,
          ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
          ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
        })
      )
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  const beginGfsResourceNavigation = useCallback(
    (
      id: number,
      uri: string,
      principalGeneration: number,
      userNavigationGenerationAtActivation: number
    ): GfsResourceNavigationRequest | null => {
      const currentGeneration = currentUserNavigationGeneration()
      if (
        currentGeneration === null ||
        !isGfsResourceNavigationActivationCurrent(
          userNavigationGenerationAtActivation,
          currentGeneration
        )
      ) {
        return null
      }
      const intentSequence = beginNavigationIntent()
      const state = workspaceTabsRef.current
      const owner = assignGfsResourceNavigationOwner(state, uri)
      return {
        id,
        uri,
        ownerTabId: owner.createDestination ? nextWorkspaceTabId() : owner.ownerTabId,
        createDestination: owner.createDestination,
        intentSequence,
        principalGeneration,
        userNavigationGenerationAtActivation,
      }
    },
    [beginNavigationIntent, currentUserNavigationGeneration, nextWorkspaceTabId]
  )

  const isGfsResourceNavigationCurrent = useCallback(
    (request: GfsResourceNavigationRequest, principalGeneration: number): boolean => {
      const userNavigationGeneration = currentUserNavigationGeneration()
      if (userNavigationGeneration === null) return false
      const state = workspaceTabsRef.current
      const context: GfsResourceNavigationContext = {
        intentSequence: navigationIntentSequenceRef.current,
        principalGeneration,
        userNavigationGeneration,
        activeTabId: state.activeTabId,
        tabs: state.tabs,
      }
      return canCompleteGfsResourceNavigation(request, context)
    },
    [currentUserNavigationGeneration]
  )

  const activateGfsResourceNavigation = useCallback(
    (request: GfsResourceNavigationRequest, principalGeneration: number): boolean => {
      if (
        !isNavigationIntentCurrent(request.intentSequence) ||
        request.principalGeneration !== principalGeneration ||
        currentUserNavigationGeneration() !== request.userNavigationGenerationAtActivation
      ) {
        return false
      }
      const state = workspaceTabsRef.current
      let next: WorkspaceTabsState
      if (request.createDestination) {
        if (state.tabs.some(tab => tab.id === request.ownerTabId)) return false
        next = createFilesTab(state, { id: request.ownerTabId, path: null })
      } else {
        if (!isGfsResourceNavigationOwnerPresent(request, state.tabs)) return false
        next = selectWorkspaceTab(state, request.ownerTabId)
      }
      if (next.activeTabId !== request.ownerTabId) return false
      setAppsPickerActive(false)
      setWorkspaceTabs(next)
      return true
    },
    [currentUserNavigationGeneration, isNavigationIntentCurrent, setWorkspaceTabs]
  )

  const completeGfsResourceNavigationPreview = useCallback(
    (
      request: GfsResourceNavigationRequest,
      preview: GfsPreviewResource,
      principalGeneration: number,
      returnLocation: { gfsUri: string | null; name: string | null },
      sessionScope?: string
    ): boolean => {
      if (!isGfsResourceNavigationCurrent(request, principalGeneration)) return false
      const id = nextWorkspaceTabId()
      const ownerWithRestoredLocation = setFilesTabPath(
        workspaceTabsRef.current,
        request.ownerTabId,
        returnLocation.gfsUri,
        returnLocation.name ?? undefined
      )
      const next = openPreviewTab(ownerWithRestoredLocation, {
        id,
        title: preview.name,
        gfsUri: preview.gfsUri,
        ...(sessionScope !== undefined ? { sessionScope } : {}),
        fileKind: preview.kind,
        byteLength: preview.bytes,
        ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
        ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
      })
      setAppsPickerActive(false)
      setWorkspaceTabs(next)
      return next.activeTabId !== request.ownerTabId
    },
    [isGfsResourceNavigationCurrent, nextWorkspaceTabId, setWorkspaceTabs]
  )

  const selectWorkspaceTabById = useCallback(
    (id: string): boolean => {
      const tab = workspaceTabsRef.current.tabs.find(candidate => candidate.id === id)
      if (!tab) return false
      beginUserNavigationIntent()
      setAppsPickerActive(false)
      setWorkspaceTabs(state => selectWorkspaceTab(state, id))
      return true
    },
    [beginUserNavigationIntent, setWorkspaceTabs]
  )

  // Base section navigation: every legacy `handleNavSelect(route)` call-site
  // routes here and becomes an open/focus tab action (the single writer). For
  // `chat`/`agents` it also clears `selectedAgent` exactly as before.
  // Returns the chat `focusChatSection` focused (for the chat route) so the
  // coordinator can load exactly that conversation; `null` for every other route
  // and for a blank/seeded chat.
  const handleNavSelect = useCallback(
    (
      item: NavItem,
      options: {
        source?: 'explicit' | 'programmatic'
        navigationIntentAlreadyStarted?: boolean
      } = {}
    ): { agentRef: string; chatId: string } | null => {
      const source = options.source ?? 'explicit'
      if (source === 'programmatic' && navigationIntentSequenceRef.current > 0) return null
      if (item === DESKTOP_ROUTES.chat) {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
        return focusChatSection(source, options.navigationIntentAlreadyStarted)
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
      openSettingsSection(section, options.navigationIntentAlreadyStarted)
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
    navigationIntentSequence,
    filesMutationEpoch,
    beginUserNavigationIntent,
    beginFilesPathIntent,
    commitFilesPathIntent,
    failFilesPathIntent,
    recordFilesMutation,
    markFilesPathsUnavailable,
    reconcileFilesConvergence,
    isNavigationIntentCurrent,
    beginGfsResourceNavigation,
    isGfsResourceNavigationCurrent,
    activateGfsResourceNavigation,
    completeGfsResourceNavigationPreview,
    selectWorkspaceTabById,
    activeTab,
    nextWorkspaceTabId,
    appsPickerActive,
    showAppsPicker,
    clearAppsPicker,
    resetSessionNavigation,
    captureWorkspaceNavigation,
    restoreWorkspaceNavigation,
    activateChatTab,
    lastActiveChatTabId,
    openFilesSection,
    openPreviewSection,
    // Agent/chat selection state (stays here through this slice; §4).
    selectedAgent,
    selectedAgentRoute,
    setSelectedAgent,
    setSelectedAgentRoute,
    handleNavSelect,
    handleBackToAgents,
  }
}
