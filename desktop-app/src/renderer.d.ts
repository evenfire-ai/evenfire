import {
  AccessCatalog,
  ApprovalDecisionResult,
  ChatIndex,
  ChatMessage,
  ChatMetadata,
  ContextBreakdownResult,
  DesktopAppInfo,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
  DesktopRuntimeConfigState,
  ExternalChannelsSummary,
  HostActivitySnapshot,
  HostActivityStreamEvent,
  HostMessageRequest,
  HostMessageResponse,
  HostModelsResult,
  HostRuntimeStatus,
  HostStatusStreamEvent,
  MessageToolStep,
  PasswordLoginResult,
  PendingApprovalLite,
  PendingWorkflowApproval,
  PrewarmHostResult,
  ProfileSettingsOpenOptions,
  RpcAllowedServersResult,
  SessionLifecycleState,
  SessionState,
  SessionTokensLite,
  SetHostModelResult,
  TaskProgressStreamEvent,
  TeamDirectoryResult,
  TeamMember,
  TeamSummary,
  TokenMetadata,
  WorkflowApprovalDecisionResult,
  WorkflowNotificationStreamEvent,
  WorkflowRecipeListResult,
  WorkflowRunArtifactsResult,
  WorkflowRunsResult,
} from './types.js'

declare global {
  interface Window {
    clerum: {
      auth: {
        getSessionState: () => Promise<SessionState>
        getDependenciesHealth: () => Promise<{
          externalRestApi: { ok: boolean; detail?: string }
          rpcProxy: { ok: boolean; detail?: string }
        }>
        getRuntimeConfigState: () => Promise<DesktopRuntimeConfigState>
        selectRuntimeConfig: (optionId: string) => Promise<DesktopRuntimeConfigState>
        clearRuntimeConfigSelection: () => Promise<DesktopRuntimeConfigState>
        saveRuntimeConfig: (config: DesktopRuntimeConfig) => Promise<DesktopRuntimeConfigState>
        deleteRuntimeConfig: (optionId: string) => Promise<DesktopRuntimeConfigState>
        googleLogin: (idToken: string) => Promise<SessionState>
        passwordLogin: (email: string, password: string) => Promise<PasswordLoginResult>
        startDesktopSetup: (email: string) => Promise<{ profileUiUrl: string; appName: string }>
        openForgotPassword: (email?: string) => Promise<{ profileUiUrl: string }>
        openProfileSettings: (
          email?: string,
          options?: ProfileSettingsOpenOptions
        ) => Promise<{ profileUiUrl: string }>
        completeDesktopSetup: (
          email: string,
          authorizationToken: string
        ) => Promise<DesktopRuntimeConfigState>
        onDesktopSetupToken: (
          callback: (payload: { email: string; authorizationToken: string }) => void
        ) => () => void
        onDesktopEnvironmentSetup: (
          callback: (payload: { externalRestApiBaseUrl: string; appName?: string }) => void
        ) => () => void
        getDesktopReleaseStatus: () => Promise<DesktopReleaseStatus>
        getDesktopAppInfo: () => Promise<DesktopAppInfo>
        openDesktopRelease: (releaseUrl: string) => Promise<{ opened: true }>
        onExternalLogout: (callback: () => void) => () => void
        logout: () => Promise<{ ok: true }>
      }
      team: {
        list: () => Promise<{ currentTeamId: string; items: TeamSummary[] }>
        members: () => Promise<TeamMember[]>
        directory: () => Promise<TeamDirectoryResult>
        initialDirectory: () => Promise<TeamDirectoryResult>
        switch: (teamId: string) => Promise<SessionState>
      }
      gfs: {
        resolve: (uri: string) => Promise<{
          drive: string
          resourceId: string
          parentResourceId: string | null
          rid?: string
          gfsUri: string
          name: string
          kind: string
          pathCache: string | null
          path?: string | null
          version: number
          bytes?: number
        }>
        download: (uri: string) => Promise<{
          resource: {
            drive: string
            resourceId: string
            parentResourceId: string | null
            rid?: string
            gfsUri: string
            name: string
            kind: string
            pathCache: string | null
            path?: string | null
            version: number
            bytes?: number
          }
          bytes: ArrayBuffer
        }>
        listAccessible: (
          drive?: string,
          cursor?: string
        ) => Promise<{
          items: Array<{
            resourceId: string
            rid: string
            gfsUri: string
            drive: string
            parentResourceId: string | null
            name: string
            kind: 'file' | 'directory'
            path: string | null
            version: number
            bytes: number
            sources: string[]
            permissions: string[]
            coversDescendants: boolean
          }>
          nextCursor: string | null
        }>
        listChildren: (
          resourceId: string,
          drive?: string,
          cursor?: string
        ) => Promise<{
          items: Array<{
            resourceId: string
            rid: string
            gfsUri: string
            drive: string
            parentResourceId: string | null
            name: string
            kind: 'file' | 'directory'
            path: string | null
            version: number
            bytes: number
          }>
          nextCursor: string | null
        }>
        affordances: (
          resourceId: string,
          drive?: string
        ) => Promise<{
          held: string[]
          canDelegate: boolean
          grantableBits: string[]
          canCreateShare: boolean
        }>
        createFolder: (
          parentResourceId: string,
          name: string,
          drive?: string
        ) => Promise<{
          resourceId: string
          rid: string
          gfsUri: string
          drive: string
          parentResourceId: string | null
          name: string
          kind: 'file' | 'directory'
          path: string | null
          version: number
          bytes: number
        }>
        createFile: (
          parentResourceId: string,
          name: string,
          encodedData: string,
          drive?: string
        ) => Promise<{
          resourceId: string
          rid: string
          gfsUri: string
          drive: string
          parentResourceId: string | null
          name: string
          kind: 'file' | 'directory'
          path: string | null
          version: number
          bytes: number
        }>
        replaceFile: (
          resourceId: string,
          encodedData: string,
          drive?: string,
          ifMatch?: number
        ) => Promise<{
          resourceId: string
          rid: string
          gfsUri: string
          drive: string
          parentResourceId: string | null
          name: string
          kind: 'file' | 'directory'
          path: string | null
          version: number
          bytes: number
        }>
        renameResource: (
          resourceId: string,
          newName: string,
          drive?: string,
          ifMatch?: number
        ) => Promise<{ resourceId: string; version: number }>
        deleteResource: (
          resourceId: string,
          drive?: string,
          ifMatch?: number
        ) => Promise<{ deleted: boolean; resourceId: string }>
        grant: (
          resourceId: string,
          subjectKey: string,
          bits: string[],
          drive?: string
        ) => Promise<void>
        createShare: (resourceId: string, subjectKey: string, drive?: string) => Promise<void>
      }
      approvals: {
        listPending: (limit?: number) => Promise<PendingWorkflowApproval[]>
        decide: (
          approvalId: string,
          decision: 'approve' | 'deny',
          note?: string,
          options?: { teamId?: string | null }
        ) => Promise<WorkflowApprovalDecisionResult>
      }
      notifications: {
        subscribe: (
          onEvent: (event: WorkflowNotificationStreamEvent) => void
        ) => Promise<() => Promise<void>>
        status: () => Promise<{
          active: number
          open: number
          connecting: number
          error: number
          approvalRequested: number
          snapshot: number
          updated: number
        }>
        isSupported: () => Promise<boolean>
        show: (payload: {
          id: string
          title: string
          body: string
          tag?: string
          silent?: boolean
          actions?: Array<{ action: string; title: string }>
        }) => Promise<{ supported: boolean; id: string }>
        onClick: (callback: (payload: { id: string }) => void) => () => void
        onAction: (callback: (payload: { id: string; action: string }) => void) => () => void
        onFailed: (callback: (payload: { id: string; error: string }) => void) => () => void
        ack: (notificationId: string) => Promise<{ ok: boolean; status: string }>
      }
      notificationPreferences: {
        get: () => Promise<import('./types').UserNotificationPreferences>
        update: (payload: {
          preferredMedium: 'telegram' | 'slack' | null
          channelFallbackEnabled: boolean
        }) => Promise<import('./types').UserNotificationPreferences>
      }
      socialChannels: {
        getSummary: () => Promise<ExternalChannelsSummary>
      }
      access: {
        getCatalog: () => Promise<AccessCatalog>
        refreshCatalog: () => Promise<AccessCatalog>
      }
      sharedFiles: {
        listAttached: (contextId: string) => Promise<{
          items: Array<{
            name: string
            mountPath: string
            phase: string | null
            pvcName: string | null
            message: string | null
          }>
        }>
        listDirectory: (
          contextId: string,
          sfsName: string,
          path: string
        ) => Promise<{
          path: string
          entries: Array<{
            name: string
            kind: 'file' | 'directory' | 'other'
            size: number
            mtime: string
          }>
          truncated: boolean
        }>
        download: (
          contextId: string,
          sfsName: string,
          path: string
        ) => Promise<{ saved: boolean; filePath: string | null }>
      }
      rpc: {
        listServers: (hostRefs?: string[]) => Promise<RpcAllowedServersResult>
        invokeHostMessage: (
          hostRef: string,
          payload: HostMessageRequest,
          hostRefs?: string[],
          options?: { async?: boolean }
        ) => Promise<HostMessageResponse>
        getTaskResult: (
          hostRef: string,
          taskId: string,
          hostRefs?: string[]
        ) => Promise<HostMessageResponse>
        getHostStatus: (hostRef: string, hostRefs?: string[]) => Promise<HostRuntimeStatus>
        prewarmHost: (hostRef: string, hostRefs?: string[]) => Promise<PrewarmHostResult>
        getHostActivity: (
          hostRef: string,
          limit?: number,
          sinceEventId?: string,
          hostRefs?: string[]
        ) => Promise<HostActivitySnapshot>
        subscribeHostStatus: (
          hostRef: string,
          hostRefs: string[] | undefined,
          onEvent: (event: HostStatusStreamEvent) => void
        ) => Promise<() => Promise<void>>
        subscribeHostActivity: (
          hostRef: string,
          hostRefs: string[] | undefined,
          onEvent: (event: HostActivityStreamEvent) => void
        ) => Promise<() => Promise<void>>
        subscribeTaskProgress: (
          hostRef: string,
          taskId: string,
          onEvent: (event: TaskProgressStreamEvent) => void
        ) => Promise<() => Promise<void>>
        cancelTask: (hostRef: string, taskId: string) => Promise<void>
        approveToolCall: (
          hostRef: string,
          taskId: string,
          toolCallId: string,
          hostRefs?: string[],
          options?: { teamId?: string | null }
        ) => Promise<ApprovalDecisionResult>
        denyToolCall: (
          hostRef: string,
          taskId: string,
          toolCallId: string,
          reason: string,
          hostRefs?: string[],
          options?: { teamId?: string | null }
        ) => Promise<ApprovalDecisionResult>
        listArtifacts: (
          hostRef: string,
          hostRefs?: string[]
        ) => Promise<{
          artifacts: Array<{ name: string; format: string; sizeBytes: number; createdAt: string }>
        }>
        downloadArtifact: (
          hostRef: string,
          filename: string,
          hostRefs?: string[]
        ) => Promise<Buffer>
        listSessions: (
          hostRef: string,
          hostRefs?: string[]
        ) => Promise<{
          items: Array<{
            agent: string
            chatId: string
            turnCount: number
            lastActivityAt: string
            state?: SessionLifecycleState
            activeTaskId?: string
            pendingApproval?: PendingApprovalLite
            tokens?: SessionTokensLite
          }>
        }>
        loadSessionMessages: (
          hostRef: string,
          agent: string,
          chatId: string,
          hostRefs?: string[]
        ) => Promise<{
          agent: string
          chatId: string
          state?: SessionLifecycleState
          activeTaskId?: string
          pendingApproval?: PendingApprovalLite
          tokens?: SessionTokensLite
          turns: Array<{
            number: number
            user_input: string
            response?: string
            started_at: string
            completed_at?: string
            tokens?: SessionTokensLite
            tool_steps?: MessageToolStep[]
          }>
        }>
        getContextBreakdown: (
          hostRef: string,
          agent: string,
          chatId: string,
          hostRefs?: string[]
        ) => Promise<ContextBreakdownResult>
        /**
         * R2 model selector. Resolves to `null` when the host predates the
         * endpoint (404/501) so the UI hides the selector (compat, R2.6).
         */
        getHostModels: (
          hostRef: string,
          chatId: string,
          hostRefs?: string[]
        ) => Promise<HostModelsResult | null>
        /**
         * Sets the per-session model (applies to the next task). Rejects with an
         * error whose message contains `model_not_allowed` when the model is not
         * in the operator allowlist.
         */
        setHostModel: (
          hostRef: string,
          chatId: string,
          model: string,
          hostRefs?: string[]
        ) => Promise<SetHostModelResult>
        getTokenMetadata: () => Promise<TokenMetadata>
      }
      app: {
        openUrl: (url: string) => Promise<void>
      }
      window: {
        getVisibility: () => Promise<{ visible: boolean }>
        onVisibilityChange: (callback: (state: { visible: boolean }) => void) => () => void
      }
      system: {
        /** GAP-D1 (§4.5-4): OS resume / screen unlock tick — reconcile in-flight chats. */
        onResume: (callback: () => void) => () => void
      }
      desktop: {
        openWindow: (args: { hostRef: string }) => Promise<void>
        closeWindow: (args: { hostRef: string }) => Promise<void>
        getStatus: (args: {
          hostRef: string
        }) => Promise<{ hostRef: string; status: string; message?: string }>
        onWindowClosed: (callback: (args: { hostRef: string }) => void) => () => void
      }
      workflows: {
        list: () => Promise<WorkflowRecipeListResult>
        read: (ns: string, name: string) => Promise<unknown>
        health: (ns: string, name: string) => Promise<unknown>
        trigger: (
          ns: string,
          name: string,
          inputs?: Record<string, unknown>,
          idempotencyKey?: string
        ) => Promise<unknown>
        runs: (ns: string, name: string, limit?: number) => Promise<WorkflowRunsResult>
        listRunArtifacts: (
          ns: string,
          name: string,
          runId: string
        ) => Promise<WorkflowRunArtifactsResult>
        downloadRunArtifact: (
          ns: string,
          name: string,
          runId: string,
          artifactName: string
        ) => Promise<{ saved: boolean; filePath: string; filename: string }>
      }
      chat: {
        list: (agentRef: string) => Promise<ChatMetadata[]>
        create: (agentRef: string, chatId: string) => Promise<ChatMetadata>
        rename: (agentRef: string, chatId: string, title: string) => Promise<void>
        delete: (agentRef: string, chatId: string) => Promise<void>
        loadMessages: (
          agentRef: string,
          chatId: string,
          limit?: number,
          offset?: number
        ) => Promise<ChatMessage[]>
        appendMessages: (agentRef: string, chatId: string, messages: ChatMessage[]) => Promise<void>
        replaceMessages: (
          agentRef: string,
          chatId: string,
          messages: ChatMessage[]
        ) => Promise<void>
        getLastActive: (agentRef: string) => Promise<string | null>
        setLastActive: (agentRef: string, chatId: string) => Promise<void>
        getIndex: (agentRef: string) => Promise<ChatIndex>
        dismissOnboarding: (agentRef: string) => Promise<void>
        markUnreadTerminal: (agentRef: string, chatId: string) => Promise<void>
        clearUnreadTerminal: (agentRef: string, chatId: string) => Promise<void>
      }
      sandboxUi: {
        listApps: () => Promise<{
          apps: Array<{
            appRef: string
            title?: string
            description?: string
            icon?: string
            defaultPath: string
            ready: boolean
            phase: string | null
            updatedAt: string | null
          }>
        }>
        mintSession: (recipeNs: string, recipeName: string) => Promise<{ setCookie: string }>
        open: (args: {
          recipeNs: string
          recipeName: string
          defaultPath?: string
          bounds: { x: number; y: number; width: number; height: number; dpr?: number }
        }) => Promise<void>
        close: () => Promise<void>
        reload: () => Promise<void>
        setBounds: (bounds: {
          x: number
          y: number
          width: number
          height: number
          dpr?: number
        }) => Promise<void>
        setVisible: (visible: boolean) => Promise<void>
        capturePreview: () => Promise<string | null>
        onClosed: (callback: (args: { appRef: string }) => void) => () => void
        onRefreshError: (
          callback: (args: { appRef: string; message: string }) => void
        ) => () => void
      }
    }
  }
}

export {}
