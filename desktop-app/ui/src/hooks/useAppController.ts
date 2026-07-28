import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  AccessCatalog,
  PendingWorkflowApproval,
  WorkflowApprovalDecisionResult,
  WorkflowRecipeListResult,
  WorkflowRecipeResource,
  WorkflowRunsResult,
} from '../../../src/types'
import { DESKTOP_ROUTES } from '../constants/navigation'
import { pickLatestAgent } from '../lib/agents'
import { toPrettyJson } from '../lib/format'
import { summarizeWorkflowResource } from '../lib/workflows'
import type {
  AgentApprovalNotificationTarget,
  AgentConversationNotificationTarget,
  AgentWorkspaceRoute,
  AppNotification,
  NavItem,
  Tone,
  WorkflowCompletionNotificationTarget,
} from '../uiTypes'
import {
  type ApprovalDecisionTarget,
  decideApproval as decideApprovalCore,
} from './domain/approvalDecision'
import { desktopQueryKeys } from './domain/queryKeys'
import { useActivityController } from './domain/useActivityController'
import { useAgentChatController } from './domain/useAgentChatController'
import { useAgentsDataController } from './domain/useAgentsDataController'
import { useAuthController } from './domain/useAuthController'
import { useChannelNotificationPreferencesController } from './domain/useChannelNotificationPreferencesController'
import { useContextsDataController } from './domain/useContextsDataController'
import { useDesktopController } from './domain/useDesktopController'
import { useHostPrewarmController } from './domain/useHostPrewarmController'
import { useMcpServerController } from './domain/useMcpServerController'
import { useMcpServersDataController } from './domain/useMcpServersDataController'
import { useNavigationController } from './domain/useNavigationController'
import { useNotificationSettingsController } from './domain/useNotificationSettingsController'
import { useNotificationsController } from './domain/useNotificationsController'
import { useTeamsDataController } from './domain/useTeamsDataController'
import { useToastController } from './domain/useToastController'
import {
  EMPTY_WORKFLOW_SELECTION,
  type WorkflowSelectionState,
  createResetWorkflowSelection,
} from './domain/useWorkflowController.types'
import { scheduleAfterFirstPaint } from './scheduleAfterFirstPaint'

const DENY_REASON_BY_SOURCE: Record<ApprovalDecisionTarget['source'], string> = {
  desktop_notification: 'Denied from desktop notification',
  inapp_bell: 'Denied from notifications panel',
  in_chat: 'User denied',
  placeholder: 'User denied',
}

export async function loadWorkflowRunsWithArtifactsForWorkflowTarget(
  target: Pick<WorkflowCompletionNotificationTarget, 'namespace' | 'name'>
): Promise<WorkflowRunsResult> {
  const raw = (await window.clerum.workflows.runs(
    target.namespace,
    target.name,
    20
  )) as WorkflowRunsResult
  const rows = Array.isArray(raw?.items) ? raw.items : []
  const items = await Promise.all(
    rows.map(async run => {
      if (!run.executionRef) return run
      try {
        const artifacts = await window.clerum.workflows.listRunArtifacts(
          target.namespace,
          target.name,
          run.id
        )
        return { ...run, artifacts: artifacts.artifacts ?? [] }
      } catch {
        return { ...run, artifacts: [] }
      }
    })
  )
  return {
    ...raw,
    items,
    count: typeof raw?.count === 'number' ? raw.count : items.length,
  }
}

export async function loadWorkflowRunsWithArtifactsForApprovalRefresh(
  approval: Pick<PendingWorkflowApproval, 'recipeNamespace' | 'recipeName'>
): Promise<WorkflowRunsResult> {
  return loadWorkflowRunsWithArtifactsForWorkflowTarget({
    namespace: approval.recipeNamespace,
    name: approval.recipeName,
  })
}

interface SessionIdentityRef {
  current: string | null
}

export function scheduleAfterFirstPaintForSession(
  sessionIdentityRef: SessionIdentityRef,
  expectedIdentity: string,
  task: () => Promise<unknown>
): void {
  scheduleAfterFirstPaint(async () => {
    if (sessionIdentityRef.current !== expectedIdentity) return
    await task()
  })
}

export function useAppController() {
  const queryClient = useQueryClient()

  // ─── Toast ───
  const toastCtrl = useToastController()
  const { toasts, pushToast } = toastCtrl

  // ─── Global status state (owned by coordinator, not auth) ───
  const [statusText, setStatusText] = useState('Ready.')
  const [statusTone, setStatusTone] = useState<Tone>('info')
  const [postPaintDataReady, setPostPaintDataReady] = useState(false)

  // Build fullSetStatus using refs to avoid circular dependencies
  const setStatusTextRef = useRef(setStatusText)
  setStatusTextRef.current = setStatusText
  const setStatusToneRef = useRef(setStatusTone)
  setStatusToneRef.current = setStatusTone
  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast

  const fullSetStatus = useCallback(
    (
      message: string,
      tone: Tone = 'info',
      payload?: unknown,
      options: { global?: boolean; toast?: boolean; toastDurationMs?: number } = {}
    ) => {
      const { global: updateGlobal = true, toast = true } = options
      if (updateGlobal) {
        setStatusTextRef.current(payload ? `${message}\n${toPrettyJson(payload)}` : message)
        setStatusToneRef.current(tone)
      }
      if (toast) pushToastRef.current(message, tone, { durationMs: options.toastDurationMs })
    },
    []
  )

  // ─── Navigation ───
  const nav = useNavigationController()

  // Use a ref so the stable onSessionNeedsLoad callback can call the real loadSession
  // without creating a circular dependency (loadSession is defined after auth+session).
  const loadSessionRef = useRef(async (_options?: { preserveNav?: boolean }) => {})
  const activeAuthenticatedSessionIdentityRef = useRef<string | null>(null)
  const authenticatedSessionIdentityRef = useRef<string | null>(null)
  const catalogRefreshPromiseRef = useRef<Promise<AccessCatalog> | null>(null)

  const onSessionNeedsLoad = useCallback(async (options?: { preserveNav?: boolean }) => {
    return loadSessionRef.current(options)
  }, [])

  // ─── Auth ───
  const auth = useAuthController({
    setStatus: fullSetStatus,
    onSessionNeedsLoad,
  })

  // ─── First-screen data contexts ───
  const agentsData = useAgentsDataController()
  const contextsData = useContextsDataController()
  const mcpServersData = useMcpServersDataController()
  const teamsData = useTeamsDataController()
  const currentTeamId = teamsData.currentTeamId || auth.me?.teamId || ''
  const currentTeamName =
    teamsData.teams.find(team => team.id === currentTeamId)?.name || auth.me?.teamName || ''
  const currentTeamIdRef = useRef(currentTeamId)
  currentTeamIdRef.current = currentTeamId
  const notificationTeamContextQueueRef = useRef<Promise<void>>(Promise.resolve())
  const openAgentConversationFromNotificationRef = useRef<
    (target: AgentConversationNotificationTarget) => Promise<void>
  >(async () => {})
  const decideApprovalFromNotificationRef = useRef<
    (target: AgentApprovalNotificationTarget) => Promise<void>
  >(async () => {})
  // §4.7.4: the central approval-decision function is built AFTER the chat
  // controller (it needs its FSM store), but the in-app bell handlers live in
  // `useNotificationsController` (created earlier). This ref bridges the order so
  // all four surfaces funnel through the same `decideApproval`.
  const decideApprovalRef = useRef<(target: ApprovalDecisionTarget) => Promise<void>>(
    async () => {}
  )
  const decideApproval = useCallback(
    (target: ApprovalDecisionTarget) => decideApprovalRef.current(target),
    []
  )
  const openAgentConversationFromNotification = useCallback(
    (target: AgentConversationNotificationTarget) =>
      openAgentConversationFromNotificationRef.current(target),
    []
  )
  const decideApprovalFromNotification = useCallback(
    (target: AgentApprovalNotificationTarget) => decideApprovalFromNotificationRef.current(target),
    []
  )

  const refreshWorkflowRunsAfterApprovalDecision = useCallback(
    async ({
      approval,
      result,
    }: {
      approval: PendingWorkflowApproval
      result: WorkflowApprovalDecisionResult
    }) => {
      if (!result.run) return
      const key = desktopQueryKeys.workflowRuns(approval.recipeNamespace, approval.recipeName, 20)
      try {
        const enriched = await loadWorkflowRunsWithArtifactsForApprovalRefresh(approval)
        queryClient.setQueryData<WorkflowRunsResult>(key, enriched)
      } catch {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
    [queryClient]
  )

  // ─── Notifications ───
  const notificationSettings = useNotificationSettingsController()
  const channelNotificationPreferences = useChannelNotificationPreferencesController({
    isAuthenticated: auth.isAuthenticated,
    pushToast,
  })
  const notif = useNotificationsController({
    isAuthenticated: auth.isAuthenticated,
    notificationSoundVolume: notificationSettings.settings.soundVolume,
    canDeliverChatResponseNotification: notificationSettings.canDeliverChatResponseNotification,
    showDesktopNotification: notificationSettings.showDesktopNotification,
    onWorkflowApprovalDecision: refreshWorkflowRunsAfterApprovalDecision,
    decideApproval,
    pushToast,
    setStatus: fullSetStatus,
  })

  // ─── Agent Chat ───
  const chat = useAgentChatController({
    selectedAgent: nav.selectedAgent,
    agentNames: agentsData.agentNames,
    currentUserId: auth.me?.id,
    currentTeamId,
    currentTeamName,
    isAuthenticated: auth.isAuthenticated,
    loadMenuData: postPaintDataReady,
    navItem: nav.navItem,
    pushToast,
    pushNotification: notif.pushNotification,
    canDeliverChatResponseNotification: notificationSettings.canDeliverChatResponseNotification,
    showDesktopNotification: notificationSettings.showDesktopNotification,
    openAgentConversationFromNotification,
    decideApprovalFromNotification,
  })

  // §4.7.4: the ONE central approval-decision function, bound to the chat
  // controller's FSM store. All four surfaces (desktop notification, in-app bell,
  // in-chat gate, in-flight placeholder) funnel through it so the badge converges
  // the same way from every entry point (closes V8/GAP-N1). Reconcile routes
  // through the single-flight `chat.reconcileChat` gate (§4.3, wired below).
  const decideApprovalImpl = useCallback(
    (target: ApprovalDecisionTarget) =>
      decideApprovalCore(
        {
          fsm: chat.sessionFsmStore,
          approve: t =>
            window.clerum.rpc.approveToolCall(t.agentRef, t.taskId, t.requestId, [t.agentRef], {
              teamId: t.teamId ?? undefined,
            }),
          deny: t =>
            window.clerum.rpc.denyToolCall(
              t.agentRef,
              t.taskId,
              t.requestId,
              DENY_REASON_BY_SOURCE[t.source],
              [t.agentRef],
              { teamId: t.teamId ?? undefined }
            ),
          reconcile: (chatKey, reason, taskId) => {
            // §4.3: every approval-decision convergence path goes through the
            // single-flight reconcileChat gate — including a decision made from the
            // in-app bell on a NON-active chat (which previously did nothing until
            // the chat was reopened). `taskId` drives the idle durable fallback
            // (GAP-H1). Single-flight + backoff live in the gate.
            void chat.reconcileChat(chatKey, { reason, taskIdHint: taskId })
          },
          resolveApprovalNotification: notif.resolveApprovalNotification,
          pushToast,
        },
        target
      ),
    [chat.sessionFsmStore, chat.reconcileChat, notif.resolveApprovalNotification, pushToast]
  )
  decideApprovalRef.current = decideApprovalImpl

  // ─── MCP Server ───
  const mcpServer = useMcpServerController({
    selectedAgent: nav.selectedAgent,
    navItem: nav.navItem,
    isAuthenticated: auth.isAuthenticated,
    agentProviderByName: agentsData.agentProviderByName,
  })

  // ─── Host pre-warm (authenticated catalog only — see the hook's anti-flapping doc) ───
  useHostPrewarmController({
    agentNames: agentsData.agentNames,
    isAuthenticated: auth.isAuthenticated && postPaintDataReady,
  })

  // ─── Desktop ───
  const desktop = useDesktopController({
    selectedAgent: nav.selectedAgent,
    pushToast,
  })

  // ─── Activity ───
  const activity = useActivityController({
    selectedAgent: nav.selectedAgent,
    isAuthenticated: auth.isAuthenticated,
    loadMenuData: postPaintDataReady,
    chatList: chat.chatList,
    progressByAgentMessage: chat.progressByAgentMessage,
    agentNames: agentsData.agentNames,
  })

  const getCatalogRefreshPromise = useCallback(() => {
    if (!catalogRefreshPromiseRef.current) {
      catalogRefreshPromiseRef.current = window.clerum.access.refreshCatalog().finally(() => {
        catalogRefreshPromiseRef.current = null
      })
    }
    return catalogRefreshPromiseRef.current
  }, [])

  const refreshAgentsData = useCallback(async () => {
    await agentsData.refreshWithCatalog(getCatalogRefreshPromise())
  }, [agentsData.refreshWithCatalog, getCatalogRefreshPromise])

  const refreshContextsData = useCallback(async () => {
    await contextsData.refreshWithCatalog(getCatalogRefreshPromise())
  }, [contextsData.refreshWithCatalog, getCatalogRefreshPromise])

  const refreshMcpServersData = useCallback(async () => {
    await mcpServersData.refreshWithCatalog(getCatalogRefreshPromise())
  }, [getCatalogRefreshPromise, mcpServersData.refreshWithCatalog])

  const refreshWorkflowsData = useCallback(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.workflows,
        queryFn: () => window.clerum.workflows.list() as Promise<WorkflowRecipeListResult>,
        staleTime: 0,
      })
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient])

  const resetWorkflowsData = useCallback(() => {
    queryClient.setQueryData<WorkflowSelectionState>(
      desktopQueryKeys.workflowSelection,
      createResetWorkflowSelection
    )
    queryClient.removeQueries({ queryKey: desktopQueryKeys.workflows })
    queryClient.removeQueries({ queryKey: ['desktop-app', 'workflow-detail'] })
    queryClient.removeQueries({ queryKey: ['desktop-app', 'workflow-runs'] })
  }, [queryClient])

  const refreshAuthenticatedData = useCallback(
    async (options: { initialLoad?: boolean; sessionIdentity?: string } = {}) => {
      const refreshTeams = options.initialLoad
        ? teamsData.refreshInitialDirectory
        : teamsData.refresh
      if (options.initialLoad) {
        const scheduledIdentity = options.sessionIdentity
        if (!scheduledIdentity) return false
        let agentsLoaded = false
        try {
          await refreshAgentsData()
          agentsLoaded = true
        } catch (error) {
          console.warn('[startup] failed to load the initial agent catalog', error)
        } finally {
          scheduleAfterFirstPaintForSession(
            activeAuthenticatedSessionIdentityRef,
            scheduledIdentity,
            async () => {
              setPostPaintDataReady(true)
              await Promise.all([
                refreshContextsData(),
                refreshMcpServersData(),
                refreshTeams(),
                refreshWorkflowsData(),
                notif.handleRefreshPendingApprovals({ silent: true }),
              ])
            }
          )
        }
        return agentsLoaded
      }
      return Promise.all([
        refreshAgentsData(),
        refreshContextsData(),
        refreshMcpServersData(),
        refreshTeams(),
        refreshWorkflowsData(),
        notif.handleRefreshPendingApprovals({ silent: true }),
      ])
    },
    [
      notif.handleRefreshPendingApprovals,
      refreshAgentsData,
      refreshContextsData,
      refreshMcpServersData,
      refreshWorkflowsData,
      setPostPaintDataReady,
      teamsData.refresh,
      teamsData.refreshInitialDirectory,
    ]
  )

  const refreshWorkspaceDataForRoute = useCallback(
    async (route: NavItem) => {
      let cycleCatalogPromise: Promise<AccessCatalog> | null = null
      const getCycleCatalogPromise = () => {
        if (!cycleCatalogPromise) {
          cycleCatalogPromise = getCatalogRefreshPromise()
        }
        return cycleCatalogPromise
      }

      const refreshers = [
        {
          route: DESKTOP_ROUTES.agents,
          refresh: () => agentsData.refreshWithCatalog(getCycleCatalogPromise()),
        },
        {
          route: DESKTOP_ROUTES.contexts,
          refresh: () => contextsData.refreshWithCatalog(getCycleCatalogPromise()),
        },
        {
          route: DESKTOP_ROUTES.connectors,
          refresh: () => mcpServersData.refreshWithCatalog(getCycleCatalogPromise()),
        },
        { route: DESKTOP_ROUTES.teams, refresh: teamsData.refresh },
        { route: DESKTOP_ROUTES.plugins, refresh: refreshWorkflowsData },
      ] as const

      const activeRoute =
        route === DESKTOP_ROUTES.contextDetails
          ? DESKTOP_ROUTES.contexts
          : route === DESKTOP_ROUTES.teamDetails
            ? DESKTOP_ROUTES.teams
            : route
      const current = refreshers.find(entry => entry.route === activeRoute)

      if (current) await current.refresh()
    },
    [
      agentsData.refreshWithCatalog,
      contextsData.refreshWithCatalog,
      getCatalogRefreshPromise,
      mcpServersData.refreshWithCatalog,
      refreshWorkflowsData,
      teamsData.refresh,
    ]
  )

  useEffect(() => {
    if (!auth.isAuthenticated) return
    if (agentsData.accessCatalog && nav.selectedAgent) {
      if (!agentsData.agentNames.includes(nav.selectedAgent)) {
        nav.setSelectedAgent(null)
      }
    }
  }, [
    agentsData.accessCatalog,
    agentsData.agentNames,
    auth.isAuthenticated,
    nav.selectedAgent,
    nav.setSelectedAgent,
  ])

  useEffect(() => {
    if (!auth.isAuthenticated) return
    if (contextsData.accessCatalog && nav.selectedContext) {
      if (!contextsData.contextIds.includes(nav.selectedContext)) {
        nav.setSelectedContext(null)
      }
    }
  }, [
    auth.isAuthenticated,
    contextsData.accessCatalog,
    contextsData.contextIds,
    nav.selectedContext,
    nav.setSelectedContext,
  ])

  useEffect(() => {
    if (!auth.isAuthenticated) return
    if (teamsData.teamDirectoryHydrated && nav.selectedTeam) {
      const available = teamsData.teams.map(team => team.id)
      if (!available.includes(nav.selectedTeam)) {
        nav.setSelectedTeam(null)
      }
    }
  }, [
    auth.isAuthenticated,
    nav.selectedTeam,
    nav.setSelectedTeam,
    teamsData.teamDirectoryHydrated,
    teamsData.teams,
  ])

  const switchTeamForWorkspace = useCallback(
    async (teamId: string, options: { announce?: boolean } = {}) => {
      const { announce = true } = options
      auth.setBusy(true)
      try {
        if (!teamId) throw new Error('Select a team')
        const sessionState = await window.clerum.team.switch(teamId)
        if (!sessionState.authenticated || !sessionState.me) {
          throw new Error('Team switch ended without an authenticated session')
        }
        // GAP-N4 (spec §4.5-3): the renderer half of a team switch. `clearActiveChat`
        // only deselects — the previous team's tracker entries and FSM projection
        // survive, so a late terminal from an old-team task could run side effects
        // and stale badges leak across teams. Tear down the renderer chat state
        // (tracker.releaseAll + fsm.reset via resetChat) exactly like logout, once
        // the switch is CONFIRMED (before `refreshAuthenticatedData` repopulates) —
        // doing it before the RPC would wipe the view on a failed switch. The old
        // team's tasks stay alive server-side and converge on return via reconcile.
        // Main-process stream teardown is Fase 4.
        chat.resetChat()
        auth.setIsAuthenticated(true)
        auth.setMe(sessionState.me)
        auth.setEmail(sessionState.me.email || '')
        currentTeamIdRef.current = sessionState.me.teamId || teamId
        const switchedIdentity = `${sessionState.me.id}:${sessionState.me.email}:${sessionState.me.teamId || ''}`
        activeAuthenticatedSessionIdentityRef.current = switchedIdentity
        authenticatedSessionIdentityRef.current = switchedIdentity
        await refreshAuthenticatedData()
        if (announce) {
          const teamName =
            teamsData.teams.find(team => team.id === teamId)?.name ||
            sessionState.me.teamName ||
            teamId
          fullSetStatus(`Switched team to ${teamName}.`, 'success')
        }
      } finally {
        auth.setBusy(false)
      }
    },
    [
      auth.setBusy,
      auth.setEmail,
      auth.setIsAuthenticated,
      auth.setMe,
      chat.resetChat,
      fullSetStatus,
      refreshAuthenticatedData,
      teamsData.teams,
    ]
  )

  const ensureNotificationTeamContext = useCallback(
    async (target: { teamId?: string }) => {
      const targetTeamId = String(target.teamId || '').trim()
      if (!targetTeamId) return

      const queuedSwitch = notificationTeamContextQueueRef.current.then(async () => {
        const activeTeamId = currentTeamIdRef.current
        if (targetTeamId === activeTeamId) return

        chat.clearActiveChat()
        await switchTeamForWorkspace(targetTeamId, { announce: false })
      })
      notificationTeamContextQueueRef.current = queuedSwitch.catch(() => undefined)
      await queuedSwitch
    },
    [chat.clearActiveChat, switchTeamForWorkspace]
  )

  const decideApprovalNotificationTarget = useCallback(
    async (target: AgentApprovalNotificationTarget) => {
      const targetAgent = String(target.agentName || '').trim()
      const chatId = String(target.chatId || '').trim()
      const taskId = String(target.taskId || '').trim()
      const requestId = String(target.requestId || '').trim()
      if (!targetAgent || !taskId || !requestId) return
      // Surface (a): the desktop-notification Approve/Deny action funnels through
      // the central decider (§4.7.4). Navigation/focus stay in
      // openAgentConversationTarget; this only decides.
      await decideApproval({
        agentRef: targetAgent,
        chatId,
        teamId: target.teamId,
        taskId,
        requestId,
        decision: target.decision,
        source: 'desktop_notification',
      })
    },
    [decideApproval]
  )

  decideApprovalFromNotificationRef.current = decideApprovalNotificationTarget

  // ─── Cross-domain: loadSession ───
  const loadSession = useCallback(
    async (options: { preserveNav?: boolean } = {}) => {
      const { preserveNav = false } = options
      try {
        const health = await window.clerum.auth.getDependenciesHealth()
        auth.setDependencyHealth(health)
        const sessionState = await window.clerum.auth.getSessionState()
        const authenticated = Boolean(sessionState.authenticated && sessionState.me)
        auth.setIsAuthenticated(authenticated)
        auth.setMe(sessionState.me)

        if (!authenticated || !sessionState.me) {
          setPostPaintDataReady(false)
          auth.setDesktopReleaseStatus(null)
          await chat.stopAllActivityStreams()
          agentsData.reset()
          contextsData.reset()
          mcpServersData.reset()
          teamsData.reset()
          resetWorkflowsData()
          queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
          chat.resetChat()
          notif.resetNotifications()
          activeAuthenticatedSessionIdentityRef.current = null
          authenticatedSessionIdentityRef.current = null
          if (!preserveNav) nav.handleNavSelect(DESKTOP_ROUTES.chat)
          return
        }

        auth.setPassword('')
        auth.setEmail(sessionState.me.email || '')
        void auth.refreshDesktopReleaseStatus()
        const sessionIdentity = `${sessionState.me.id}:${sessionState.me.email}:${sessionState.me.teamId || ''}`
        activeAuthenticatedSessionIdentityRef.current = sessionIdentity
        if (authenticatedSessionIdentityRef.current !== sessionIdentity) {
          setPostPaintDataReady(false)
          const loaded = await refreshAuthenticatedData({
            initialLoad: true,
            sessionIdentity,
          })
          if (loaded && activeAuthenticatedSessionIdentityRef.current === sessionIdentity) {
            authenticatedSessionIdentityRef.current = sessionIdentity
          }
        }
        if (!preserveNav) {
          nav.handleNavSelect(DESKTOP_ROUTES.chat)
        }
      } finally {
        auth.refreshRuntimeConfigState().catch(() => undefined)
        auth.setBooting(false)
      }
    },
    [
      agentsData.reset,
      auth.refreshRuntimeConfigState,
      auth.setBooting,
      auth.setDependencyHealth,
      auth.setDesktopReleaseStatus,
      auth.setEmail,
      auth.setIsAuthenticated,
      auth.setMe,
      auth.setPassword,
      auth.refreshDesktopReleaseStatus,
      chat.resetChat,
      chat.stopAllActivityStreams,
      contextsData.reset,
      mcpServersData.reset,
      nav.handleNavSelect,
      notif.resetNotifications,
      queryClient,
      refreshAuthenticatedData,
      resetWorkflowsData,
      setPostPaintDataReady,
      teamsData.reset,
    ]
  )

  // Wire loadSession into the ref so auth's boot effect calls the real one
  loadSessionRef.current = loadSession

  // ─── Cross-domain: handleLogout ───
  const handleLogout = useCallback(async () => {
    try {
      auth.setBusy(true)
      await chat.stopAllActivityStreams()
      catalogRefreshPromiseRef.current = null
      agentsData.reset()
      contextsData.reset()
      mcpServersData.reset()
      teamsData.reset()
      resetWorkflowsData()
      queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
      // Drop ALL cached queries on logout (spec §5.2 P1): the singleton
      // desktopQueryClient uses staleTime:Infinity, so any env-scoped data left
      // in cache would otherwise bleed into the next login (possibly a different
      // environment, since the env is chosen pre-login).
      queryClient.clear()
      activeAuthenticatedSessionIdentityRef.current = null
      authenticatedSessionIdentityRef.current = null
      await window.clerum.auth.logout()
      chat.resetChat()
      notif.resetNotifications()
      fullSetStatus('Logged out.', 'success')
      await loadSession()
    } catch (error) {
      fullSetStatus(
        `Logout failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    } finally {
      auth.setBusy(false)
    }
  }, [
    agentsData.reset,
    auth.setBusy,
    chat.resetChat,
    chat.stopAllActivityStreams,
    contextsData.reset,
    fullSetStatus,
    loadSession,
    mcpServersData.reset,
    notif.resetNotifications,
    queryClient,
    resetWorkflowsData,
    teamsData.reset,
  ])

  // ─── Cross-domain: handleOpenAgentWorkspace ───
  const handleOpenAgentWorkspace = useCallback(
    (agentName: string, route: AgentWorkspaceRoute = 'details') => {
      if (!agentName) return
      chat.setPendingChatSelection(agentName, null)
      chat.clearActiveChat()
      nav.setSelectedAgentRoute(route)
      nav.setSelectedAgent(agentName)
      nav.setNavItem(DESKTOP_ROUTES.agents)
    },
    [
      chat.clearActiveChat,
      chat.setPendingChatSelection,
      nav.setNavItem,
      nav.setSelectedAgent,
      nav.setSelectedAgentRoute,
    ]
  )

  // ─── Cross-domain: handleSelectChatAgent (Chat page agent picker) ───
  const handleSelectChatAgent = useCallback(
    (
      agentName: string,
      options: { selectLatest?: boolean; chatId?: string; isRemote?: boolean; title?: string } = {}
    ) => {
      if (!agentName) return
      const targetChatId = String(options.chatId || '').trim()
      if (targetChatId && nav.selectedAgent === agentName) {
        // D.4: switchToChat is now a single unified path (no isRemote) — the
        // server is the source of truth and hydrates server-only chats itself.
        void chat.switchToChat(agentName, targetChatId)
        nav.setSelectedAgentRoute('details')
        nav.setNavItem(DESKTOP_ROUTES.chat)
        return
      }
      const shouldSelectLatest = targetChatId ? false : options.selectLatest !== false
      const pendingSelectionOptions: {
        selectLatest: boolean
        suppressAutoSelect: boolean
        title?: string
        isRemote?: boolean
      } = {
        selectLatest: shouldSelectLatest,
        suppressAutoSelect: !shouldSelectLatest && !targetChatId,
      }
      if (options.title) pendingSelectionOptions.title = options.title
      if (options.isRemote !== undefined) pendingSelectionOptions.isRemote = options.isRemote
      chat.setPendingChatSelection(agentName, targetChatId || null, pendingSelectionOptions)
      if (!targetChatId) {
        chat.clearActiveChat()
      }
      nav.setSelectedAgentRoute('details')
      nav.setSelectedAgent(agentName)
      nav.setNavItem(DESKTOP_ROUTES.chat)
    },
    [
      chat.clearActiveChat,
      chat.setPendingChatSelection,
      chat.switchToChat,
      nav.selectedAgent,
      nav.setNavItem,
      nav.setSelectedAgent,
      nav.setSelectedAgentRoute,
    ]
  )

  // ─── Cross-domain: handleNavSelect (extended) ───
  const handleNavSelect = useCallback(
    (item: NavItem) => {
      nav.handleNavSelect(item)
      if (item === DESKTOP_ROUTES.chat) {
        const latestAgent = pickLatestAgent(agentsData.agentNames, activity.agentLastActiveByAgent)
        if (latestAgent) {
          handleSelectChatAgent(latestAgent, { selectLatest: false })
        }
      }
    },
    [
      activity.agentLastActiveByAgent,
      agentsData.agentNames,
      handleSelectChatAgent,
      nav.handleNavSelect,
    ]
  )

  const openAgentConversationTarget = useCallback(
    async (target: AgentConversationNotificationTarget) => {
      const targetAgent = String(target.agentName || '').trim()
      if (!targetAgent) return
      const targetChatId = String(target.chatId || '').trim()
      const targetTeamId = String(target.teamId || '').trim()
      const activeTeamId = currentTeamIdRef.current
      const requiresTeamSwitch = Boolean(targetTeamId && targetTeamId !== activeTeamId)

      try {
        if (requiresTeamSwitch) {
          await ensureNotificationTeamContext({ teamId: targetTeamId })
        }

        if (targetChatId && !requiresTeamSwitch && nav.selectedAgent === targetAgent) {
          try {
            await chat.switchToChat(targetAgent, targetChatId)
            nav.setNavItem(DESKTOP_ROUTES.chat)
            return
          } catch {
            // Fall through to pending selection so the normal agent load path can retry.
          }
        }

        chat.setPendingChatSelection(targetAgent, targetChatId || null)
        nav.setSelectedAgent(targetAgent)
        nav.setNavItem(DESKTOP_ROUTES.chat)
      } catch (error) {
        fullSetStatus(
          `Could not open notification: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      }
    },
    [
      chat.setPendingChatSelection,
      chat.switchToChat,
      ensureNotificationTeamContext,
      fullSetStatus,
      nav.selectedAgent,
      nav.setNavItem,
      nav.setSelectedAgent,
    ]
  )

  openAgentConversationFromNotificationRef.current = openAgentConversationTarget

  const openWorkflowCompletionTarget = useCallback(
    async (notification: AppNotification) => {
      const target = notification.workflow
      if (!target) return
      try {
        await ensureNotificationTeamContext({ teamId: notification.teamId })
        nav.setNavItem(DESKTOP_ROUTES.plugins)

        const fallbackWorkflow = {
          namespace: target.namespace,
          name: target.name,
          triggerableByUser: false,
        }
        queryClient.setQueryData<WorkflowSelectionState>(
          desktopQueryKeys.workflowSelection,
          current => ({
            ...(current ?? EMPTY_WORKFLOW_SELECTION),
            selectedWorkflow: fallbackWorkflow,
            workflowInputValues: EMPTY_WORKFLOW_SELECTION.workflowInputValues,
            workflowTriggerLoading: false,
            selectionVersion:
              (current?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion) + 1,
          })
        )

        const detail = (await window.clerum.workflows.read(
          target.namespace,
          target.name
        )) as WorkflowRecipeResource
        const selectedWorkflow = summarizeWorkflowResource(detail)
        queryClient.setQueryData(
          desktopQueryKeys.workflowDetail(target.namespace, target.name),
          detail
        )
        queryClient.setQueryData<WorkflowSelectionState>(
          desktopQueryKeys.workflowSelection,
          current => ({
            ...(current ?? EMPTY_WORKFLOW_SELECTION),
            selectedWorkflow,
            workflowInputValues: EMPTY_WORKFLOW_SELECTION.workflowInputValues,
            workflowTriggerLoading: false,
          })
        )

        const runs = await loadWorkflowRunsWithArtifactsForWorkflowTarget(target)
        queryClient.setQueryData<WorkflowRunsResult>(
          desktopQueryKeys.workflowRuns(target.namespace, target.name, 20),
          runs
        )
        fullSetStatus('Workflow ' + target.name + ' results refreshed.', 'success', undefined, {
          global: false,
          toast: true,
        })
      } catch (error) {
        void queryClient.invalidateQueries({
          queryKey: desktopQueryKeys.workflowDetail(target.namespace, target.name),
        })
        void queryClient.invalidateQueries({
          queryKey: desktopQueryKeys.workflowRuns(target.namespace, target.name, 20),
        })
        fullSetStatus(
          'Could not refresh workflow results: ' +
            (error instanceof Error ? error.message : String(error)),
          'error'
        )
      }
    },
    [ensureNotificationTeamContext, fullSetStatus, nav.setNavItem, queryClient]
  )

  const openSdkNotificationTarget = useCallback(
    async (notification: AppNotification) => {
      const target = notification.sdk
      if (!target) return
      try {
        // SDK notifications are user-addressed and do not carry one canonical
        // team. Recipe reads use the current user session and its effective
        // direct access instead of inventing a team switch.
        nav.setNavItem(DESKTOP_ROUTES.plugins)

        const fallbackWorkflow = {
          namespace: target.recipeNamespace,
          name: target.recipeName,
          triggerableByUser: false,
        }
        queryClient.setQueryData<WorkflowSelectionState>(
          desktopQueryKeys.workflowSelection,
          current => ({
            ...(current ?? EMPTY_WORKFLOW_SELECTION),
            selectedWorkflow: fallbackWorkflow,
            workflowInputValues: EMPTY_WORKFLOW_SELECTION.workflowInputValues,
            workflowTriggerLoading: false,
            selectionVersion:
              (current?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion) + 1,
          })
        )

        const detail = (await window.clerum.workflows.read(
          target.recipeNamespace,
          target.recipeName
        )) as WorkflowRecipeResource
        const selectedWorkflow = summarizeWorkflowResource(detail)
        queryClient.setQueryData(
          desktopQueryKeys.workflowDetail(target.recipeNamespace, target.recipeName),
          detail
        )
        queryClient.setQueryData<WorkflowSelectionState>(
          desktopQueryKeys.workflowSelection,
          current => ({
            ...(current ?? EMPTY_WORKFLOW_SELECTION),
            selectedWorkflow,
            workflowInputValues: EMPTY_WORKFLOW_SELECTION.workflowInputValues,
            workflowTriggerLoading: false,
            selectionVersion:
              (current?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion) + 1,
          })
        )
      } catch (error) {
        void queryClient.invalidateQueries({
          queryKey: desktopQueryKeys.workflowDetail(target.recipeNamespace, target.recipeName),
        })
        fullSetStatus(
          'Could not open SDK notification: ' +
            (error instanceof Error ? error.message : String(error)),
          'error'
        )
      }
    },
    [fullSetStatus, nav.setNavItem, queryClient]
  )

  // ─── Cross-domain: handleOpenNotification ───
  const handleOpenNotification = useCallback(
    async (notification: AppNotification) => {
      notif.markNotificationRead(notification.id)
      if (notification.kind === 'workflow_completed') {
        await openWorkflowCompletionTarget(notification)
        return
      }
      if (notification.kind === 'sdk_notification') {
        await openSdkNotificationTarget(notification)
        return
      }
      await openAgentConversationTarget(notification)
    },
    [
      notif.markNotificationRead,
      openAgentConversationTarget,
      openSdkNotificationTarget,
      openWorkflowCompletionTarget,
    ]
  )

  // ─── Cross-domain: handleRefreshMcpHealth ───
  const handleRefreshMcpHealth = useCallback(async () => {
    mcpServer.setMcpHealthRefreshing(true)
    try {
      await refreshMcpServersData()
      mcpServer.bumpReconnectNonce()
    } finally {
      mcpServer.setMcpHealthRefreshing(false)
    }
  }, [mcpServer.bumpReconnectNonce, mcpServer.setMcpHealthRefreshing, refreshMcpServersData])

  // Guard effects for nav item guards (team-details/context-details without selection)
  // These were in useWorkspaceController — in the new world we handle them in the coordinator
  // by extending handleNavSelect, but we also need the reactive guard.
  // We add them here:
  // Note: useEffect cannot be used here conditionally. We use the hooks pattern inline.
  // These guards are handled by useNavigationController's state + the coordinator logic.
  // We replicate the original behavior by watching nav state changes.

  return {
    // Auth
    booting: auth.booting,
    initialExperienceLoading:
      auth.isAuthenticated &&
      !auth.hasDependencyOutage &&
      agentsData.loading &&
      !agentsData.accessCatalog,
    busy: auth.busy,
    statusText,
    statusTone,
    isAuthenticated: auth.isAuthenticated,
    me: auth.me,
    email: auth.email,
    password: auth.password,
    desktopSetupAuthorizationToken: auth.desktopSetupAuthorizationToken,
    desktopSetupStarted: auth.desktopSetupStarted,
    runtimeConfigSetupName: auth.runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl: auth.runtimeConfigSetupExternalRestApiBaseUrl,
    runtimeConfigSetupRpcProxyBaseUrl: auth.runtimeConfigSetupRpcProxyBaseUrl,
    authTransitioning: auth.authTransitioning,
    runtimeConfigState: auth.runtimeConfigState,
    runtimeConfigMissing: auth.runtimeConfigMissing,
    desktopReleaseStatus: auth.desktopReleaseStatus,
    desktopEnvironmentSetupComplete: auth.desktopEnvironmentSetupComplete,
    pendingDesktopEnvironmentSetup: auth.pendingDesktopEnvironmentSetup,
    showRuntimeConfigSelector: auth.showRuntimeConfigSelector,
    dependencyHealth: auth.dependencyHealth,
    hasDependencyOutage: auth.hasDependencyOutage,
    setBooting: auth.setBooting,
    setEmail: auth.setEmail,
    setPassword: auth.setPassword,
    setDesktopSetupAuthorizationToken: auth.setDesktopSetupAuthorizationToken,
    setRuntimeConfigSetupName: auth.setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl: auth.setRuntimeConfigSetupExternalRestApiBaseUrl,
    setRuntimeConfigSetupRpcProxyBaseUrl: auth.setRuntimeConfigSetupRpcProxyBaseUrl,
    setPendingDesktopEnvironmentSetup: auth.setPendingDesktopEnvironmentSetup,
    setStatus: fullSetStatus,
    loadSession,
    handlePasswordLogin: auth.handlePasswordLogin,
    handleStartDesktopSetup: auth.handleStartDesktopSetup,
    handleCompleteDesktopSetup: auth.handleCompleteDesktopSetup,
    handleSaveRuntimeConfig: auth.handleSaveRuntimeConfig,
    handleDeleteRuntimeConfig: auth.handleDeleteRuntimeConfig,
    handleSelectRuntimeConfig: auth.handleSelectRuntimeConfig,
    handleClearRuntimeConfigSelection: auth.handleClearRuntimeConfigSelection,
    handleCancelDesktopEnvironmentSetup: auth.handleCancelDesktopEnvironmentSetup,
    handleConfirmDesktopEnvironmentSetup: auth.handleConfirmDesktopEnvironmentSetup,
    handleOpenDesktopRelease: auth.handleOpenDesktopRelease,
    setDesktopEnvironmentSetupComplete: auth.setDesktopEnvironmentSetupComplete,
    handleLogout,

    // Navigation
    navItem: nav.navItem,
    selectedAgent: nav.selectedAgent,
    selectedAgentRoute: nav.selectedAgentRoute,
    selectedContext: nav.selectedContext,
    selectedTeam: nav.selectedTeam,
    setSelectedAgent: nav.setSelectedAgent,
    setSelectedContext: nav.setSelectedContext,
    setSelectedTeam: nav.setSelectedTeam,
    handleNavSelect,
    handleOpenAgentWorkspace,
    handleSelectChatAgent,
    handleBackToAgents: nav.handleBackToAgents,
    handleOpenContextDetails: nav.handleOpenContextDetails,
    handleBackToContexts: nav.handleBackToContexts,
    handleOpenTeamDetails: nav.handleOpenTeamDetails,
    handleBackToTeams: nav.handleBackToTeams,
    handleRefreshWorkspaceData: refreshWorkspaceDataForRoute,

    // Notifications
    notifications: notif.notifications,
    notificationActionById: notif.notificationActionById,
    pendingApprovals: notif.pendingApprovals,
    pendingApprovalsLoading: notif.pendingApprovalsLoading,
    pendingApprovalActionId: notif.pendingApprovalActionId,
    unreadNotificationCount: notif.unreadNotificationCount,
    toasts,
    pushToast,
    markNotificationsRead: notif.markNotificationsRead,
    clearNotifications: notif.clearNotifications,
    removeNotification: notif.removeNotification,
    resolveApprovalNotification: notif.resolveApprovalNotification,
    decideApproval,
    handleOpenNotification,
    handleApproveNotification: notif.handleApproveNotification,
    handleDenyNotification: notif.handleDenyNotification,
    handleRefreshPendingApprovals: notif.handleRefreshPendingApprovals,
    handleDecidePendingApproval: notif.handleDecidePendingApproval,
    notificationSettings: notificationSettings.settings,
    desktopNotificationPermission: notificationSettings.desktopNotificationPermission,
    saveNotificationSettings: notificationSettings.saveNotificationSettings,
    setNotificationSoundVolume: notificationSettings.setNotificationSoundVolume,
    playNotificationSoundPreview: notif.playNotificationSound,
    channelNotificationPreferences: channelNotificationPreferences.channelNotificationPreferences,
    channelNotificationPreferencesLoading:
      channelNotificationPreferences.channelNotificationPreferencesLoading,
    channelNotificationPreferencesSaving:
      channelNotificationPreferences.channelNotificationPreferencesSaving,
    saveChannelNotificationPreferences:
      channelNotificationPreferences.saveChannelNotificationPreferences,

    // Chat
    activeChatId: chat.activeChatId,
    chatList: chat.chatList,
    sessionStateByChatId: chat.sessionStateByChatId,
    sessionStateByChatKey: chat.sessionStateByChatKey,
    chatListLoading: chat.chatListLoading,
    chatListMoreLoading: chat.chatListMoreLoading,
    chatListHasMoreRemoteSessions: chat.chatListHasMoreRemoteSessions,
    latestChatSessions: chat.latestChatSessions,
    latestChatSessionsLoading: chat.latestChatSessionsLoading,
    chatMessages: chat.chatMessages,
    chatMessagesLoading: chat.chatMessagesLoading,
    hasOlderMessages: chat.hasOlderMessages,
    olderMessagesLoading: chat.olderMessagesLoading,
    composerImageAttachments: chat.composerImageAttachments,
    composerReferenceAttachments: chat.composerReferenceAttachments,
    agentSending: chat.agentSending,
    agentError: chat.agentError,
    failedAgentSend: chat.failedAgentSend,
    chatEndRef: chat.chatEndRef,
    activeMessages: chat.chatMessages,
    activityByMessageId: chat.activityByMessageId,
    progressByMessageId: chat.progressByMessageId,
    groupedMessages: chat.groupedMessages,
    handleCreateChat: chat.handleCreateChat,
    handleRenameChat: chat.handleRenameChat,
    handleRenameChatForAgent: chat.handleRenameChatForAgent,
    handleDeleteChat: chat.handleDeleteChat,
    handleDeleteChatForAgent: chat.handleDeleteChatForAgent,
    handleSelectChat: chat.handleSelectChat,
    handleLoadOlderMessages: chat.handleLoadOlderMessages,
    loadMoreChatSessions: chat.loadMoreChatSessions,
    handleSendAgentMessage: chat.handleSendAgentMessage,
    handleRetryFailedAgentSend: chat.handleRetryFailedAgentSend,
    clearComposerSendError: chat.clearComposerSendError,
    handleAddComposerImageAttachments: chat.handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment: chat.handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment: chat.handleRemoveComposerImageAttachment,
    handleAddComposerReferenceAttachments: chat.handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment: chat.handleRemoveComposerReferenceAttachment,
    cancelTask: chat.cancelTask,

    // MCP Server
    hostRuntimeStatus: mcpServer.hostRuntimeStatus,
    hostRuntimeLoading: mcpServer.hostRuntimeLoading,
    hostRuntimeError: mcpServer.hostRuntimeError,
    hostRuntimeLastUpdatedAt: mcpServer.hostRuntimeLastUpdatedAt,
    hostRuntimeIsStale: mcpServer.hostRuntimeIsStale,
    activeLlmModel: mcpServer.activeLlmModel,
    activeLlmProvider: mcpServer.activeLlmProvider,
    mcpHealthRefreshing: mcpServer.mcpHealthRefreshing,
    handleRefreshMcpHealth,

    // Desktop
    desktopStatus: desktop.desktopStatus,
    desktopError: desktop.desktopError,
    desktopAvailable: desktop.desktopAvailable,
    handleOpenDesktop: desktop.handleOpenDesktop,

    // Activity
    agentLastActiveByAgent: activity.agentLastActiveByAgent,
    selectedAgentActivitySummary: activity.selectedAgentActivitySummary,
  }
}
