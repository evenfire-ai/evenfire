import { contextBridge, ipcRenderer } from 'electron'
import type { HostMessageRequest, ProfileSettingsOpenOptions } from './types.js'

const clerum = Object.freeze({
  auth: {
    getSessionState: () => ipcRenderer.invoke('auth:getSessionState'),
    getDependenciesHealth: () => ipcRenderer.invoke('auth:getDependenciesHealth'),
    getRuntimeConfigState: () => ipcRenderer.invoke('auth:getRuntimeConfigState'),
    selectRuntimeConfig: (optionId: string) =>
      ipcRenderer.invoke('auth:selectRuntimeConfig', { optionId }),
    clearRuntimeConfigSelection: () => ipcRenderer.invoke('auth:clearRuntimeConfigSelection'),
    saveRuntimeConfig: (config: {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl?: string
      appName?: string
    }) => ipcRenderer.invoke('auth:saveRuntimeConfig', config),
    deleteRuntimeConfig: (optionId: string) =>
      ipcRenderer.invoke('auth:deleteRuntimeConfig', { optionId }),
    googleLogin: (idToken: string) => ipcRenderer.invoke('auth:googleLogin', { idToken }),
    passwordLogin: (email: string, password: string) =>
      ipcRenderer.invoke('auth:passwordLogin', { email, password }),
    startDesktopSetup: (email: string) => ipcRenderer.invoke('auth:startDesktopSetup', { email }),
    openForgotPassword: (email?: string) =>
      ipcRenderer.invoke('auth:openForgotPassword', { email }),
    openProfileSettings: (email?: string, options?: ProfileSettingsOpenOptions) =>
      ipcRenderer.invoke('auth:openProfileSettings', { email, ...options }),
    completeDesktopSetup: (email: string, authorizationToken: string) =>
      ipcRenderer.invoke('auth:completeDesktopSetup', { email, authorizationToken }),
    onDesktopSetupToken: (
      callback: (payload: { email: string; authorizationToken: string }) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { email: string; authorizationToken: string }
      ) => callback(payload)
      ipcRenderer.on('auth:desktopSetupToken', listener)
      return () => ipcRenderer.off('auth:desktopSetupToken', listener)
    },
    onDesktopEnvironmentSetup: (
      callback: (payload: { externalRestApiBaseUrl: string; appName?: string }) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { externalRestApiBaseUrl: string; appName?: string }
      ) => callback(payload)
      ipcRenderer.on('auth:desktopEnvironmentSetup', listener)
      return () => ipcRenderer.off('auth:desktopEnvironmentSetup', listener)
    },
    getDesktopReleaseStatus: () => ipcRenderer.invoke('auth:getDesktopReleaseStatus'),
    getDesktopAppInfo: () => ipcRenderer.invoke('auth:getDesktopAppInfo'),
    openDesktopRelease: (releaseUrl: string) =>
      ipcRenderer.invoke('auth:openDesktopRelease', { releaseUrl }),
    onExternalLogout: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('auth:externalLogout', listener)
      return () => ipcRenderer.off('auth:externalLogout', listener)
    },
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  team: {
    list: () => ipcRenderer.invoke('team:list'),
    members: () => ipcRenderer.invoke('team:members'),
    directory: () => ipcRenderer.invoke('team:directory'),
    initialDirectory: () => ipcRenderer.invoke('team:initialDirectory'),
    switch: (teamId: string) => ipcRenderer.invoke('team:switch', { teamId }),
  },
  gfs: {
    resolve: (uri: string) => ipcRenderer.invoke('gfs:resolve', { uri }),
    download: (uri: string) => ipcRenderer.invoke('gfs:download', { uri }),
    listAccessible: (drive?: string, cursor?: string) =>
      ipcRenderer.invoke('gfs:listAccessible', { drive, cursor }),
    listChildren: (resourceId: string, drive?: string, cursor?: string) =>
      ipcRenderer.invoke('gfs:listChildren', { resourceId, drive, cursor }),
    affordances: (resourceId: string, drive?: string) =>
      ipcRenderer.invoke('gfs:affordances', { resourceId, drive }),
    createFolder: (parentResourceId: string, name: string, drive?: string) =>
      ipcRenderer.invoke('gfs:createFolder', { parentResourceId, name, drive }),
    createFile: (parentResourceId: string, name: string, encodedData: string, drive?: string) =>
      ipcRenderer.invoke('gfs:createFile', { parentResourceId, name, encodedData, drive }),
    replaceFile: (resourceId: string, encodedData: string, drive?: string, ifMatch?: number) =>
      ipcRenderer.invoke('gfs:replaceFile', { resourceId, encodedData, drive, ifMatch }),
    renameResource: (resourceId: string, newName: string, drive?: string, ifMatch?: number) =>
      ipcRenderer.invoke('gfs:renameResource', { resourceId, newName, drive, ifMatch }),
    deleteResource: (resourceId: string, drive?: string, ifMatch?: number) =>
      ipcRenderer.invoke('gfs:deleteResource', { resourceId, drive, ifMatch }),
    grant: (resourceId: string, subjectKey: string, bits: string[], drive?: string) =>
      ipcRenderer.invoke('gfs:grant', { resourceId, subjectKey, bits, drive }),
    // A desktop share grants READ access only (the minimal shared capability) —
    // unlike `grant`, it takes no permission bits by design. The server still
    // enforces the caller holds read + share (no-escalation).
    createShare: (resourceId: string, subjectKey: string, drive?: string) =>
      ipcRenderer.invoke('gfs:createShare', { resourceId, subjectKey, drive }),
  },
  approvals: {
    listPending: (limit?: number) => ipcRenderer.invoke('approvals:listPending', { limit }),
    decide: (
      approvalId: string,
      decision: 'approve' | 'deny',
      note?: string,
      options?: { teamId?: string | null }
    ) => ipcRenderer.invoke('approvals:decide', { approvalId, decision, note, ...options }),
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke('notifications:isSupported'),
    show: (payload: {
      id: string
      title: string
      body: string
      tag?: string
      silent?: boolean
      actions?: Array<{ action: string; title: string }>
    }) => ipcRenderer.invoke('notifications:show', payload),
    onClick: (callback: (payload: { id: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { id: string }) =>
        callback(payload)
      ipcRenderer.on('notifications:click', listener)
      return () => ipcRenderer.off('notifications:click', listener)
    },
    onAction: (callback: (payload: { id: string; action: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { id: string; action: string }
      ) => callback(payload)
      ipcRenderer.on('notifications:action', listener)
      return () => ipcRenderer.off('notifications:action', listener)
    },
    onFailed: (callback: (payload: { id: string; error: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { id: string; error: string }
      ) => callback(payload)
      ipcRenderer.on('notifications:failed', listener)
      return () => ipcRenderer.off('notifications:failed', listener)
    },
    subscribe: async (onEvent: (event: unknown) => void) => {
      const started = (await ipcRenderer.invoke('notifications:streamStart')) as {
        streamId: string
      }
      const streamId = String(started?.streamId || '').trim()
      if (!streamId) throw new Error('Failed to start notification stream')

      const listener = (_event: unknown, payload: unknown) => {
        const parsed = payload as { streamId?: string; event?: unknown }
        if (parsed?.streamId !== streamId) return
        onEvent(parsed.event)
      }
      ipcRenderer.on('notifications:streamEvent', listener)

      return async () => {
        ipcRenderer.removeListener('notifications:streamEvent', listener)
        await ipcRenderer.invoke('notifications:streamStop', { streamId })
      }
    },
    status: () => ipcRenderer.invoke('notifications:streamStatus'),
    ack: (notificationId: string) =>
      ipcRenderer.invoke('notifications:ack', { notificationId }) as Promise<{
        ok: boolean
        status: string
      }>,
  },
  notificationPreferences: {
    get: () => ipcRenderer.invoke('notificationPreferences:get'),
    update: (payload: {
      preferredMedium: 'telegram' | 'slack' | null
      channelFallbackEnabled: boolean
    }) => ipcRenderer.invoke('notificationPreferences:update', payload),
  },
  socialChannels: {
    getSummary: () => ipcRenderer.invoke('socialChannels:getSummary'),
  },
  access: {
    getCatalog: () => ipcRenderer.invoke('access:getCatalog'),
    refreshCatalog: () => ipcRenderer.invoke('access:refreshCatalog'),
  },
  sharedFiles: {
    listAttached: (contextId: string) =>
      ipcRenderer.invoke('sharedFiles:listAttached', { contextId }),
    listDirectory: (contextId: string, sfsName: string, path: string) =>
      ipcRenderer.invoke('sharedFiles:listDirectory', { contextId, sfsName, path }),
    download: (contextId: string, sfsName: string, path: string) =>
      ipcRenderer.invoke('sharedFiles:download', { contextId, sfsName, path }),
  },
  rpc: {
    listServers: (hostRefs?: string[]) => ipcRenderer.invoke('rpc:listServers', { hostRefs }),
    invokeHostMessage: (
      hostRef: string,
      payload: HostMessageRequest,
      hostRefs?: string[],
      options?: { async?: boolean }
    ) => ipcRenderer.invoke('rpc:invokeHostMessage', { hostRef, payload, hostRefs, options }),
    getTaskResult: (hostRef: string, taskId: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:getTaskResult', { hostRef, taskId, hostRefs }),
    getHostStatus: (hostRef: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:getHostStatus', { hostRef, hostRefs }),
    prewarmHost: (hostRef: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:prewarmHost', { hostRef, hostRefs }),
    getHostActivity: (
      hostRef: string,
      limit?: number,
      sinceEventId?: string,
      hostRefs?: string[]
    ) => ipcRenderer.invoke('rpc:getHostActivity', { hostRef, limit, sinceEventId, hostRefs }),
    subscribeHostStatus: async (
      hostRef: string,
      hostRefs: string[] | undefined,
      onEvent: (event: unknown) => void
    ) => {
      const started = (await ipcRenderer.invoke('rpc:hostStatusStreamStart', {
        hostRef,
        hostRefs,
      })) as { streamId: string }
      const streamId = String(started?.streamId || '').trim()
      if (!streamId) throw new Error('Failed to start host status stream')

      const listener = (_event: unknown, payload: unknown) => {
        const parsed = payload as { streamId?: string; event?: unknown }
        if (parsed?.streamId !== streamId) return
        onEvent(parsed.event)
      }
      ipcRenderer.on('rpc:hostStatusStreamEvent', listener)

      return async () => {
        ipcRenderer.removeListener('rpc:hostStatusStreamEvent', listener)
        await ipcRenderer.invoke('rpc:hostStatusStreamStop', { streamId })
      }
    },
    subscribeHostActivity: async (
      hostRef: string,
      hostRefs: string[] | undefined,
      onEvent: (event: unknown) => void
    ) => {
      const started = (await ipcRenderer.invoke('rpc:hostActivityStreamStart', {
        hostRef,
        hostRefs,
      })) as { streamId: string }
      const streamId = String(started?.streamId || '').trim()
      if (!streamId) throw new Error('Failed to start host activity stream')

      const listener = (_event: unknown, payload: unknown) => {
        const parsed = payload as { streamId?: string; event?: unknown }
        if (parsed?.streamId !== streamId) return
        onEvent(parsed.event)
      }
      ipcRenderer.on('rpc:hostActivityStreamEvent', listener)

      return async () => {
        ipcRenderer.removeListener('rpc:hostActivityStreamEvent', listener)
        await ipcRenderer.invoke('rpc:hostActivityStreamStop', { streamId })
      }
    },
    subscribeTaskProgress: async (
      hostRef: string,
      taskId: string,
      onEvent: (event: unknown) => void
    ) => {
      const started = (await ipcRenderer.invoke('rpc:taskProgressStreamStart', {
        hostRef,
        taskId,
      })) as { streamId: string }
      const streamId = String(started?.streamId || '').trim()
      if (!streamId) throw new Error('Failed to start task progress stream')

      const listener = (_event: unknown, payload: unknown) => {
        const parsed = payload as { streamId?: string; event?: unknown }
        if (parsed?.streamId !== streamId) return
        onEvent(parsed.event)
      }
      ipcRenderer.on('rpc:taskProgressStreamEvent', listener)

      return async () => {
        ipcRenderer.removeListener('rpc:taskProgressStreamEvent', listener)
        await ipcRenderer.invoke('rpc:taskProgressStreamStop', { streamId })
      }
    },
    cancelTask: (hostRef: string, taskId: string): Promise<void> =>
      ipcRenderer.invoke('rpc:cancelTask', { hostRef, taskId }),
    approveToolCall: (
      hostRef: string,
      taskId: string,
      toolCallId: string,
      hostRefs?: string[],
      options?: { teamId?: string | null }
    ) =>
      ipcRenderer.invoke('rpc:approveToolCall', {
        hostRef,
        taskId,
        toolCallId,
        hostRefs,
        ...options,
      }),
    denyToolCall: (
      hostRef: string,
      taskId: string,
      toolCallId: string,
      reason: string,
      hostRefs?: string[],
      options?: { teamId?: string | null }
    ) =>
      ipcRenderer.invoke('rpc:denyToolCall', {
        hostRef,
        taskId,
        toolCallId,
        reason,
        hostRefs,
        ...options,
      }),
    listArtifacts: (hostRef: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:listArtifacts', { hostRef, hostRefs }),
    downloadArtifact: (hostRef: string, filename: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:downloadArtifact', { hostRef, filename, hostRefs }),
    listSessions: (hostRef: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:listSessions', { hostRef, hostRefs }),
    loadSessionMessages: (hostRef: string, agent: string, chatId: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:loadSessionMessages', { hostRef, agent, chatId, hostRefs }),
    getContextBreakdown: (hostRef: string, agent: string, chatId: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:getContextBreakdown', { hostRef, agent, chatId, hostRefs }),
    getHostModels: (hostRef: string, chatId: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:getHostModels', { hostRef, chatId, hostRefs }),
    setHostModel: (hostRef: string, chatId: string, model: string, hostRefs?: string[]) =>
      ipcRenderer.invoke('rpc:setHostModel', { hostRef, chatId, model, hostRefs }),
    getTokenMetadata: () => ipcRenderer.invoke('rpc:getTokenMetadata'),
  },
  workflows: {
    list: () => ipcRenderer.invoke('workflows:list'),
    read: (ns: string, name: string) => ipcRenderer.invoke('workflows:read', { ns, name }),
    health: (ns: string, name: string) => ipcRenderer.invoke('workflows:health', { ns, name }),
    trigger: (
      ns: string,
      name: string,
      inputs?: Record<string, unknown>,
      idempotencyKey?: string
    ) => ipcRenderer.invoke('workflows:trigger', { ns, name, inputs, idempotencyKey }),
    runs: (ns: string, name: string, limit?: number) =>
      ipcRenderer.invoke('workflows:runs', { ns, name, limit }),
    listRunArtifacts: (ns: string, name: string, runId: string) =>
      ipcRenderer.invoke('workflows:runArtifacts', { ns, name, runId }),
    downloadRunArtifact: (ns: string, name: string, runId: string, artifactName: string) =>
      ipcRenderer.invoke('workflows:downloadRunArtifact', { ns, name, runId, artifactName }),
  },
  app: {
    openUrl: (url: string) => ipcRenderer.invoke('app:openUrl', { url }),
  },
  window: {
    getVisibility: () => ipcRenderer.invoke('window:getVisibility'),
    onVisibilityChange: (callback: (state: { visible: boolean }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: { visible: boolean }) =>
        callback(state)
      ipcRenderer.on('window:visibility', listener)
      return () => ipcRenderer.off('window:visibility', listener)
    },
  },
  system: {
    // GAP-D1 (§4.5-4): fired after OS sleep/resume or screen unlock so the renderer
    // reconciles chats with in-flight tasks and re-attaches dead streams.
    onResume: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('system:resume', listener)
      return () => ipcRenderer.off('system:resume', listener)
    },
  },
  desktop: {
    openWindow: (args: { hostRef: string }) => ipcRenderer.invoke('desktop:openWindow', args),
    closeWindow: (args: { hostRef: string }) => ipcRenderer.invoke('desktop:closeWindow', args),
    getStatus: (args: { hostRef: string }) => ipcRenderer.invoke('desktop:getStatus', args),
    onWindowClosed: (callback: (args: { hostRef: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, args: { hostRef: string }) =>
        callback(args)
      ipcRenderer.on('desktop:windowClosed', listener)
      return () => ipcRenderer.off('desktop:windowClosed', listener)
    },
  },
  chat: {
    list: (agentRef: string) => ipcRenderer.invoke('chat:list', { agentRef }),
    create: (agentRef: string, chatId: string) =>
      ipcRenderer.invoke('chat:create', { agentRef, chatId }),
    rename: (agentRef: string, chatId: string, title: string) =>
      ipcRenderer.invoke('chat:rename', { agentRef, chatId, title }),
    delete: (agentRef: string, chatId: string) =>
      ipcRenderer.invoke('chat:delete', { agentRef, chatId }),
    loadMessages: (agentRef: string, chatId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('chat:loadMessages', { agentRef, chatId, limit, offset }),
    appendMessages: (agentRef: string, chatId: string, messages: unknown[]) =>
      ipcRenderer.invoke('chat:appendMessages', { agentRef, chatId, messages }),
    replaceMessages: (agentRef: string, chatId: string, messages: unknown[]) =>
      ipcRenderer.invoke('chat:replaceMessages', { agentRef, chatId, messages }),
    markUnreadTerminal: (agentRef: string, chatId: string) =>
      ipcRenderer.invoke('chat:markUnreadTerminal', { agentRef, chatId }),
    clearUnreadTerminal: (agentRef: string, chatId: string) =>
      ipcRenderer.invoke('chat:clearUnreadTerminal', { agentRef, chatId }),
    getLastActive: (agentRef: string) => ipcRenderer.invoke('chat:getLastActive', { agentRef }),
    setLastActive: (agentRef: string, chatId: string) =>
      ipcRenderer.invoke('chat:setLastActive', { agentRef, chatId }),
    getIndex: (agentRef: string) => ipcRenderer.invoke('chat:getIndex', { agentRef }),
    dismissOnboarding: (agentRef: string) =>
      ipcRenderer.invoke('chat:dismissOnboarding', { agentRef }),
  },
  sandboxUi: {
    listApps: () => ipcRenderer.invoke('sandboxUi:listApps'),
    mintSession: (recipeNs: string, recipeName: string) =>
      ipcRenderer.invoke('sandboxUi:mintSession', { recipeNs, recipeName }),
    open: (args: {
      recipeNs: string
      recipeName: string
      defaultPath?: string
      bounds: { x: number; y: number; width: number; height: number; dpr?: number }
    }) => ipcRenderer.invoke('sandboxUi:open', args),
    close: () => ipcRenderer.invoke('sandboxUi:close'),
    reload: () => ipcRenderer.invoke('sandboxUi:reload'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number; dpr?: number }) =>
      ipcRenderer.invoke('sandboxUi:setBounds', { bounds }),
    setVisible: (visible: boolean) => ipcRenderer.invoke('sandboxUi:setVisible', { visible }),
    capturePreview: () => ipcRenderer.invoke('sandboxUi:capturePreview'),
    onClosed: (callback: (args: { appRef: string }) => void) => {
      const listener = (_event: unknown, args: { appRef: string }) => callback(args)
      ipcRenderer.on('sandboxUi:closed', listener)
      return () => ipcRenderer.off('sandboxUi:closed', listener)
    },
    onRefreshError: (callback: (args: { appRef: string; message: string }) => void) => {
      const listener = (_event: unknown, args: { appRef: string; message: string }) =>
        callback(args)
      ipcRenderer.on('sandboxUi:refreshError', listener)
      return () => ipcRenderer.off('sandboxUi:refreshError', listener)
    },
  },
})

contextBridge.exposeInMainWorld('clerum', clerum)
