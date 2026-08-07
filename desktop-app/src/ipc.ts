import {
  BrowserWindow,
  IpcMainInvokeEvent,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AppService } from './appService.js'
import { requireChatStore } from './chatStoreBinding.js'
import {
  PLUGIN_SDK_CAPABILITIES_CHANNEL,
  PLUGIN_SDK_CONSENT_RESOLVE_CHANNEL,
  PLUGIN_SDK_PERMISSIONS_CHANNEL,
  PLUGIN_SDK_PERMISSION_STATE_CHANNEL,
  PLUGIN_SDK_REQUEST_CHANNEL,
} from './pluginSdkProtocol.js'
import {
  DesktopRuntimeConfig,
  HostActivityStreamEvent,
  HostMessageRequest,
  HostStatusStreamEvent,
  TaskProgressStreamEvent,
  WorkflowNotificationStreamEvent,
} from './types.js'

function sanitizeString(input: unknown): string {
  return String(input || '').trim()
}

/**
 * Sanitize a bulk subject-key array (grant/share to many subjects in one call).
 * Fails loud on a non-array or empty payload rather than silently no-op'ing — an
 * empty selection is a renderer bug, and the server re-validates the 1..100 bound.
 */
function sanitizeSubjectKeys(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('subjectKeys must be a non-empty array')
  }
  return input.map(sanitizeString)
}

function sanitizeOptionalInteger(input: unknown): number | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error('Invalid integer')
  }
  return input
}

function sanitizeOptionalPositiveInteger(input: unknown, label: string): number | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    throw new Error(`Invalid ${label}`)
  }
  return input
}

export function sanitizeChatLoadWindow(
  limitInput: unknown,
  offsetInput: unknown
): { limit?: number; offset?: number } {
  const limit = sanitizeOptionalInteger(limitInput)
  const offset = sanitizeOptionalInteger(offsetInput)
  if (limit !== undefined && (limit < 1 || limit > 1000)) {
    throw new Error('Invalid chat message limit')
  }
  if (offset !== undefined && offset < 0) {
    throw new Error('Invalid chat message offset')
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  }
}

function sanitizeSessionsListQuery(
  input: import('./types.js').SessionsListQuery | undefined
): import('./types.js').SessionsListQuery {
  const agent = sanitizeString(input?.agent)
  const cursor = sanitizeString(input?.cursor)
  if (agent && (agent.length > 200 || agent.includes(':'))) {
    throw new Error('Invalid session agent')
  }
  if (cursor.length > 2048) throw new Error('Invalid sessions cursor')
  const rawLimit = sanitizeOptionalInteger(input?.limit)
  if (rawLimit !== undefined && rawLimit < 1) throw new Error('Invalid sessions limit')
  return {
    ...(agent ? { agent } : {}),
    ...(rawLimit !== undefined ? { limit: Math.min(rawLimit, 100) } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

function sanitizeSessionMessagesQuery(
  input: import('./types.js').SessionMessagesQuery | undefined
): import('./types.js').SessionMessagesQuery {
  const rawLimit = sanitizeOptionalInteger(input?.limit)
  const beforeTurn = sanitizeOptionalInteger(input?.beforeTurn)
  const afterTurn = sanitizeOptionalInteger(input?.afterTurn)
  if (rawLimit !== undefined && rawLimit < 1) throw new Error('Invalid messages limit')
  if (beforeTurn !== undefined && beforeTurn < 1) throw new Error('Invalid beforeTurn')
  if (afterTurn !== undefined && afterTurn < 0) throw new Error('Invalid afterTurn')
  if (beforeTurn !== undefined && afterTurn !== undefined) {
    throw new Error('beforeTurn and afterTurn are mutually exclusive')
  }
  return {
    ...(rawLimit !== undefined ? { limit: Math.min(rawLimit, 200) } : {}),
    ...(beforeTurn !== undefined ? { beforeTurn } : {}),
    ...(afterTurn !== undefined ? { afterTurn } : {}),
  }
}

function runScopedArtifactDownloadName(runId: string, artifactName: string): string {
  const rawName = path.basename(artifactName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  const safeName = rawName || 'artifact'
  const prefix = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8)
  return prefix ? `${prefix}-${safeName}` : safeName
}

async function writeUniqueDownload(
  downloadsDir: string,
  filename: string,
  bytes: Uint8Array
): Promise<{ filePath: string; filename: string }> {
  const parsed = path.parse(filename)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidateName = attempt === 0 ? filename : `${parsed.name} (${attempt})${parsed.ext}`
    const candidatePath = path.join(downloadsDir, candidateName)
    try {
      const handle = await fs.open(candidatePath, 'wx')
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
      return { filePath: candidatePath, filename: candidateName }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not create a unique artifact download filename')
}

function parseHostMessageRequest(raw: unknown): HostMessageRequest {
  const parsed = raw as HostMessageRequest
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid host message request')
  }
  if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
    throw new Error('Invalid host message request')
  }
  return parsed
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = String(event.senderFrame?.url || '')
  const devUrl = String(process.env.EVENFIRE_RENDERER_URL || '').trim()
  const isFileSender = senderUrl.startsWith('file://')
  const isDevSender = Boolean(devUrl) && senderUrl.startsWith(devUrl)
  if (!isFileSender && !isDevSender) {
    throw new Error('Untrusted IPC sender')
  }
}

type DesktopNotificationActionInput = {
  action?: string
  title?: string
}

type DesktopNotificationInput = {
  id?: string
  title?: string
  body?: string
  tag?: string
  silent?: boolean
  actions?: DesktopNotificationActionInput[]
}

function sanitizeDesktopNotificationActions(
  actions: unknown
): Array<{ action: string; title: string }> {
  if (!Array.isArray(actions)) return []
  return actions
    .map(rawAction => {
      const action = rawAction as DesktopNotificationActionInput
      return {
        action: sanitizeString(action?.action),
        title: sanitizeString(action?.title),
      }
    })
    .filter(action => action.action && action.title)
    .slice(0, 3)
}

export function registerIpcHandlers(service: AppService): void {
  const streamOwnerCleanupRegistered = new Set<number>()
  const activeDesktopNotifications = new Map<string, Notification>()

  ipcMain.handle('auth:getSessionState', async event => {
    assertTrustedSender(event)
    return service.getSessionState()
  })
  ipcMain.handle('auth:getDependenciesHealth', async event => {
    assertTrustedSender(event)
    return service.getDependenciesHealth()
  })
  ipcMain.handle('auth:getRuntimeConfigState', async event => {
    assertTrustedSender(event)
    return service.getRuntimeConfigState()
  })
  ipcMain.handle('auth:selectRuntimeConfig', async (event, payload: { optionId: string }) => {
    assertTrustedSender(event)
    return service.selectRuntimeConfig(sanitizeString(payload?.optionId))
  })
  ipcMain.handle('auth:clearRuntimeConfigSelection', async event => {
    assertTrustedSender(event)
    return service.clearRuntimeConfigSelection()
  })
  ipcMain.handle('auth:saveRuntimeConfig', async (event, payload: DesktopRuntimeConfig) => {
    assertTrustedSender(event)
    return service.saveRuntimeConfig({
      externalRestApiBaseUrl: sanitizeString(payload?.externalRestApiBaseUrl),
      rpcProxyBaseUrl: sanitizeString(payload?.rpcProxyBaseUrl),
      appName: sanitizeString(payload?.appName),
    })
  })
  ipcMain.handle('auth:deleteRuntimeConfig', async (event, payload: { optionId: string }) => {
    assertTrustedSender(event)
    return service.deleteRuntimeConfig(sanitizeString(payload?.optionId))
  })
  ipcMain.handle('auth:googleLogin', async (event, payload: { idToken: string }) => {
    assertTrustedSender(event)
    return service.googleLogin(sanitizeString(payload?.idToken))
  })
  ipcMain.handle(
    'auth:passwordLogin',
    async (event, payload: { email: string; password: string }) => {
      assertTrustedSender(event)
      return service.passwordLogin(
        sanitizeString(payload?.email).toLowerCase(),
        String(payload?.password || '')
      )
    }
  )
  ipcMain.handle('auth:startDesktopSetup', async (event, payload: { email: string }) => {
    assertTrustedSender(event)
    return service.startDesktopSetup(sanitizeString(payload?.email).toLowerCase())
  })
  ipcMain.handle('auth:openForgotPassword', async (event, payload: { email?: string }) => {
    assertTrustedSender(event)
    return service.openForgotPassword(sanitizeString(payload?.email || '').toLowerCase())
  })
  ipcMain.handle(
    'auth:openProfileSettings',
    async (
      event,
      payload: { email?: string; section?: string; network?: string; action?: string }
    ) => {
      assertTrustedSender(event)
      const action = payload?.action === 'password' ? 'password' : undefined
      const section = payload?.section === 'social' ? 'social' : 'profile'
      return service.openProfileSettings(sanitizeString(payload?.email || '').toLowerCase(), {
        section,
        network: sanitizeString(payload?.network || '').toLowerCase(),
        action,
      })
    }
  )
  ipcMain.handle(
    'auth:completeDesktopSetup',
    async (event, payload: { email: string; authorizationToken: string }) => {
      assertTrustedSender(event)
      return service.completeDesktopSetup(
        sanitizeString(payload?.email).toLowerCase(),
        sanitizeString(payload?.authorizationToken)
      )
    }
  )
  ipcMain.handle('auth:getDesktopReleaseStatus', async event => {
    assertTrustedSender(event)
    return service.getDesktopReleaseStatus()
  })
  ipcMain.handle('auth:getDesktopAppInfo', async event => {
    assertTrustedSender(event)
    return service.getDesktopAppInfo()
  })
  ipcMain.handle('auth:openDesktopRelease', async (event, payload: { releaseUrl: string }) => {
    assertTrustedSender(event)
    return service.openDesktopRelease(sanitizeString(payload?.releaseUrl))
  })
  ipcMain.handle('auth:logout', async event => {
    assertTrustedSender(event)
    await service.logout()
    return { ok: true }
  })

  ipcMain.handle('notifications:isSupported', async event => {
    assertTrustedSender(event)
    return Notification.isSupported()
  })

  ipcMain.handle('notifications:show', async (event, payload: DesktopNotificationInput) => {
    assertTrustedSender(event)
    if (!Notification.isSupported()) return { supported: false, id: '' }

    const id = sanitizeString(payload?.id) || randomUUID()
    const title = sanitizeString(payload?.title) || 'Evenfire'
    const body = String(payload?.body || '').trim()
    const actions = sanitizeDesktopNotificationActions(payload?.actions)
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const sendToRenderer = (channel: string, detail: Record<string, string>) => {
      if (event.sender.isDestroyed()) return
      event.sender.send(channel, detail)
    }
    const focusOwner = () => {
      if (!owner || owner.isDestroyed()) return
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
    }

    const notification = new Notification({
      title,
      body,
      silent: payload?.silent === true,
      actions: actions.map(action => ({ type: 'button', text: action.title })),
      closeButtonText: 'Dismiss',
      timeoutType: actions.length > 0 ? 'never' : 'default',
    })

    activeDesktopNotifications.set(id, notification)
    notification.on('click', () => {
      focusOwner()
      sendToRenderer('notifications:click', { id })
    })
    notification.on('action', (details, actionIndex) => {
      focusOwner()
      const index =
        typeof details.actionIndex === 'number'
          ? details.actionIndex
          : typeof actionIndex === 'number'
            ? actionIndex
            : -1
      const action = actions[index]?.action
      if (action) {
        sendToRenderer('notifications:action', { id, action })
      }
    })
    notification.on('close', () => {
      activeDesktopNotifications.delete(id)
    })
    notification.on('failed', (_event, error) => {
      activeDesktopNotifications.delete(id)
      sendToRenderer('notifications:failed', { id, error: String(error || 'Notification failed') })
    })
    notification.show()
    return { supported: true, id }
  })

  ipcMain.handle('team:list', async event => {
    assertTrustedSender(event)
    return service.listTeams()
  })
  ipcMain.handle('team:members', async event => {
    assertTrustedSender(event)
    return service.listTeamMembers()
  })
  ipcMain.handle('gfs:resolve', async (event, payload: { uri: string }) => {
    assertTrustedSender(event)
    return service.resolveGfsUri(sanitizeString(payload?.uri))
  })
  ipcMain.handle('gfs:download', async (event, payload: { uri: string }) => {
    assertTrustedSender(event)
    return service.downloadGfsUri(sanitizeString(payload?.uri))
  })
  ipcMain.handle(
    'gfs:listAccessible',
    async (event, payload: { drive?: string; cursor?: string }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      const cursor = payload?.cursor ? sanitizeString(payload.cursor) : undefined
      return service.listAccessibleGfsResources(drive, cursor)
    }
  )
  ipcMain.handle(
    'gfs:listChildren',
    async (event, payload: { resourceId: string; drive?: string; cursor?: string }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      const cursor = payload?.cursor ? sanitizeString(payload.cursor) : undefined
      return service.listGfsChildren(sanitizeString(payload?.resourceId), drive, cursor)
    }
  )
  ipcMain.handle(
    'gfs:affordances',
    async (event, payload: { resourceId: string; drive?: string }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.gfsAffordances(sanitizeString(payload?.resourceId), drive)
    }
  )
  ipcMain.handle(
    'gfs:createFolder',
    async (event, payload: { parentResourceId: string; name: string; drive?: string }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.createGfsFolder(
        sanitizeString(payload?.parentResourceId),
        sanitizeString(payload?.name),
        drive
      )
    }
  )
  ipcMain.handle(
    'gfs:createFile',
    async (
      event,
      payload: { parentResourceId: string; name: string; encodedData: string; drive?: string }
    ) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.createGfsFile(
        sanitizeString(payload?.parentResourceId),
        sanitizeString(payload?.name),
        sanitizeString(payload?.encodedData),
        drive
      )
    }
  )
  ipcMain.handle(
    'gfs:replaceFile',
    async (
      event,
      payload: { resourceId: string; encodedData: string; drive?: string; ifMatch?: number }
    ) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.replaceGfsFile(
        sanitizeString(payload?.resourceId),
        sanitizeString(payload?.encodedData),
        drive,
        sanitizeOptionalInteger(payload?.ifMatch)
      )
    }
  )
  ipcMain.handle(
    'gfs:renameResource',
    async (
      event,
      payload: { resourceId: string; newName: string; drive?: string; ifMatch?: number }
    ) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.renameGfsResource(
        sanitizeString(payload?.resourceId),
        sanitizeString(payload?.newName),
        drive,
        sanitizeOptionalInteger(payload?.ifMatch)
      )
    }
  )
  ipcMain.handle(
    'gfs:deleteResource',
    async (event, payload: { resourceId: string; drive?: string; ifMatch?: number }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.deleteGfsResource(
        sanitizeString(payload?.resourceId),
        drive,
        sanitizeOptionalInteger(payload?.ifMatch)
      )
    }
  )
  ipcMain.handle(
    'gfs:grant',
    async (
      event,
      payload: {
        resourceId: string
        subjectKeys: string[]
        bits: string[]
        drive?: string
        inherit?: boolean
      }
    ) => {
      assertTrustedSender(event)
      const bits = Array.isArray(payload?.bits) ? payload.bits.map(sanitizeString) : []
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      const inherit = payload?.inherit
      if (inherit !== undefined && typeof inherit !== 'boolean') {
        throw new Error('inherit must be a boolean')
      }
      return service.grantGfs(
        sanitizeString(payload?.resourceId),
        sanitizeSubjectKeys(payload?.subjectKeys),
        bits,
        drive,
        inherit
      )
    }
  )
  ipcMain.handle(
    'gfs:listGrants',
    async (event, payload: { resourceId: string; drive?: string }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.listGfsGrants(sanitizeString(payload?.resourceId), drive)
    }
  )
  ipcMain.handle('gfs:revokeGrant', async (event, payload: { grantId: string }) => {
    assertTrustedSender(event)
    return service.revokeGfsGrant(sanitizeString(payload?.grantId))
  })
  ipcMain.handle(
    'gfs:createShare',
    async (event, payload: { resourceId: string; subjectKeys: string[]; drive?: string }) => {
      assertTrustedSender(event)
      const drive = payload?.drive ? sanitizeString(payload.drive) : undefined
      return service.createGfsShare(
        sanitizeString(payload?.resourceId),
        sanitizeSubjectKeys(payload?.subjectKeys),
        drive
      )
    }
  )
  // The caller's own agents with canonical GFS host subjects (grant targets for
  // per-agent delegation). Dedicated channel: the cached AccessCatalog is
  // name-based and must not be reshaped to carry subjects.
  ipcMain.handle('agents:listMine', async event => {
    assertTrustedSender(event)
    return service.listMyAgents()
  })
  ipcMain.handle('approvals:listPending', async (event, payload?: { limit?: number }) => {
    assertTrustedSender(event)
    const limit = sanitizeOptionalPositiveInteger(payload?.limit, 'pending approvals limit')
    return service.listPendingWorkflowApprovals(limit ?? 20)
  })
  ipcMain.handle(
    'approvals:decide',
    async (
      event,
      payload: {
        approvalId: string
        decision: 'approve' | 'deny'
        note?: string
        teamId?: string
      }
    ) => {
      assertTrustedSender(event)
      const decision = payload?.decision
      if (decision !== 'approve' && decision !== 'deny') {
        throw new Error('decision must be approve or deny')
      }
      return service.decideWorkflowApproval(
        sanitizeString(payload?.approvalId),
        decision,
        sanitizeString(payload?.note) || undefined,
        { teamId: sanitizeString(payload?.teamId) || undefined }
      )
    }
  )
  ipcMain.handle('notifications:streamStart', async event => {
    assertTrustedSender(event)
    const streamId = randomUUID()
    const ownerId = event.sender.id

    service.startWorkflowNotificationStream(
      streamId,
      ownerId,
      (streamEvent: WorkflowNotificationStreamEvent) => {
        try {
          event.sender.send('notifications:streamEvent', { streamId, event: streamEvent })
        } catch {
          /* sender destroyed */
        }
      }
    )

    if (!streamOwnerCleanupRegistered.has(ownerId)) {
      streamOwnerCleanupRegistered.add(ownerId)
      event.sender.once('destroyed', () => {
        service.stopHostStatusStreamsForOwner(ownerId)
        service.stopHostActivityStreamsForOwner(ownerId)
        service.stopTaskProgressStreamsForOwner(ownerId)
        service.stopWorkflowNotificationStreamsForOwner(ownerId)
        streamOwnerCleanupRegistered.delete(ownerId)
      })
    }

    return { streamId }
  })

  ipcMain.handle('notifications:streamStop', async (event, payload: { streamId: string }) => {
    assertTrustedSender(event)
    const streamId = sanitizeString(payload?.streamId)
    if (!streamId) return { ok: true }
    const stopped = service.stopWorkflowNotificationStream(streamId, event.sender.id)
    if (!stopped) {
      throw new Error('Forbidden: cannot stop stream owned by another renderer')
    }
    return { ok: true }
  })

  ipcMain.handle('notifications:streamStatus', async event => {
    assertTrustedSender(event)
    return service.getWorkflowNotificationStreamStatus()
  })
  ipcMain.handle('notifications:ack', async (event, payload: { notificationId?: string }) => {
    assertTrustedSender(event)
    const notificationId = sanitizeString(payload?.notificationId)
    if (!notificationId) throw new Error('notificationId is required')
    return service.acknowledgeNotificationDelivery(notificationId)
  })
  ipcMain.handle('notificationPreferences:get', async event => {
    assertTrustedSender(event)
    return service.getNotificationPreferences()
  })
  ipcMain.handle('socialChannels:getSummary', async event => {
    assertTrustedSender(event)
    return service.getExternalChannelsSummary()
  })
  ipcMain.handle(
    'notificationPreferences:update',
    async (
      event,
      payload: {
        preferredMedium: 'telegram' | 'slack' | null
        channelFallbackEnabled: boolean
      }
    ) => {
      assertTrustedSender(event)
      return service.updateNotificationPreferences({
        preferredMedium: payload.preferredMedium,
        channelFallbackEnabled: payload.channelFallbackEnabled,
      })
    }
  )
  ipcMain.handle('team:directory', async event => {
    assertTrustedSender(event)
    return service.getTeamsDirectory()
  })
  ipcMain.handle('team:initialDirectory', async event => {
    assertTrustedSender(event)
    return service.getInitialTeamsDirectory()
  })
  ipcMain.handle('team:switch', async (event, payload: { teamId: string }) => {
    assertTrustedSender(event)
    return service.switchTeam(sanitizeString(payload?.teamId))
  })

  ipcMain.handle('access:getCatalog', async event => {
    assertTrustedSender(event)
    return service.getAccessCatalog()
  })
  ipcMain.handle('access:refreshCatalog', async event => {
    assertTrustedSender(event)
    return service.refreshAccessCatalog()
  })

  ipcMain.handle('sharedFiles:listAttached', async (event, payload: { contextId: string }) => {
    assertTrustedSender(event)
    return service.listContextSharedFilesystems(sanitizeString(payload?.contextId))
  })
  ipcMain.handle(
    'sharedFiles:listDirectory',
    async (event, payload: { contextId: string; sfsName: string; path?: string }) => {
      assertTrustedSender(event)
      return service.listSharedFilesystemDirectory(
        sanitizeString(payload?.contextId),
        sanitizeString(payload?.sfsName),
        String(payload?.path || '/')
      )
    }
  )
  ipcMain.handle(
    'sharedFiles:download',
    async (event, payload: { contextId: string; sfsName: string; path: string }) => {
      assertTrustedSender(event)
      const contextId = sanitizeString(payload?.contextId)
      const sfsName = sanitizeString(payload?.sfsName)
      const relPath = String(payload?.path || '').trim()
      if (!relPath) throw new Error('path is required')

      const result = await service.downloadSharedFile(contextId, sfsName, relPath)
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const saveResult = await dialog.showSaveDialog(owner!, {
        defaultPath: result.filename,
        title: 'Save file',
      })
      if (saveResult.canceled || !saveResult.filePath) {
        return { saved: false, filePath: null }
      }
      await fs.writeFile(saveResult.filePath, result.bytes)
      return { saved: true, filePath: saveResult.filePath }
    }
  )

  ipcMain.handle(
    'rpc:invokeHostMessage',
    async (
      event,
      payload: {
        hostRef: string
        payload: HostMessageRequest
        hostRefs?: string[]
        options?: { async?: boolean }
      }
    ) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const request = parseHostMessageRequest(payload?.payload)
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      const options = payload?.options?.async ? { async: true as const } : undefined
      return service.invokeHostMessage(hostRef, request, hostRefs, options)
    }
  )

  ipcMain.handle(
    'rpc:getTaskResult',
    async (event, payload: { hostRef: string; taskId: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const taskId = sanitizeString(payload?.taskId)
      if (!taskId) throw new Error('taskId is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      return service.getTaskResult(hostRef, taskId, hostRefs)
    }
  )

  ipcMain.handle(
    'rpc:getHostStatus',
    async (event, payload: { hostRef: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      return service.getHostStatus(hostRef, hostRefs)
    }
  )
  ipcMain.handle(
    'rpc:prewarmHost',
    async (event, payload: { hostRef: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      return service.prewarmHost(hostRef, hostRefs)
    }
  )
  ipcMain.handle(
    'rpc:getHostActivity',
    async (
      event,
      payload: { hostRef: string; limit?: number; sinceEventId?: string; hostRefs?: string[] }
    ) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      const limit = sanitizeOptionalPositiveInteger(payload?.limit, 'host activity limit')
      return service.getHostActivity(hostRef, {
        limit,
        sinceEventId: sanitizeString(payload?.sinceEventId) || undefined,
        hostRefs,
      })
    }
  )

  ipcMain.handle(
    'rpc:hostStatusStreamStart',
    async (event, payload: { hostRef: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      const streamId = randomUUID()
      const ownerId = event.sender.id

      service.startHostStatusStream(
        streamId,
        ownerId,
        hostRef,
        hostRefs,
        (streamEvent: HostStatusStreamEvent) => {
          try {
            event.sender.send('rpc:hostStatusStreamEvent', { streamId, event: streamEvent })
          } catch {
            /* sender destroyed */
          }
        }
      )

      if (!streamOwnerCleanupRegistered.has(ownerId)) {
        streamOwnerCleanupRegistered.add(ownerId)
        event.sender.once('destroyed', () => {
          service.stopHostStatusStreamsForOwner(ownerId)
          service.stopHostActivityStreamsForOwner(ownerId)
          service.stopTaskProgressStreamsForOwner(ownerId)
          service.stopWorkflowNotificationStreamsForOwner(ownerId)
          streamOwnerCleanupRegistered.delete(ownerId)
        })
      }

      return { streamId }
    }
  )

  ipcMain.handle('rpc:hostStatusStreamStop', async (event, payload: { streamId: string }) => {
    assertTrustedSender(event)
    const streamId = sanitizeString(payload?.streamId)
    if (!streamId) return { ok: true }
    const stopped = service.stopHostStatusStream(streamId, event.sender.id)
    if (!stopped) {
      throw new Error('Forbidden: cannot stop stream owned by another renderer')
    }
    return { ok: true }
  })

  ipcMain.handle(
    'rpc:hostActivityStreamStart',
    async (event, payload: { hostRef: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      const streamId = randomUUID()
      const ownerId = event.sender.id

      service.startHostActivityStream(
        streamId,
        ownerId,
        hostRef,
        hostRefs,
        (streamEvent: HostActivityStreamEvent) => {
          try {
            event.sender.send('rpc:hostActivityStreamEvent', { streamId, event: streamEvent })
          } catch {
            /* sender destroyed */
          }
        }
      )

      return { streamId }
    }
  )

  ipcMain.handle('rpc:hostActivityStreamStop', async (event, payload: { streamId: string }) => {
    assertTrustedSender(event)
    const streamId = sanitizeString(payload?.streamId)
    if (!streamId) return { ok: true }
    const stopped = service.stopHostActivityStream(streamId, event.sender.id)
    if (!stopped) {
      throw new Error('Forbidden: cannot stop stream owned by another renderer')
    }
    return { ok: true }
  })

  ipcMain.handle(
    'rpc:taskProgressStreamStart',
    async (event, payload: { hostRef: string; taskId: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      const taskId = sanitizeString(payload?.taskId)
      if (!taskId) throw new Error('taskId is required')
      const hostRefs = Array.isArray(payload?.hostRefs)
        ? payload.hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      const streamId = randomUUID()
      const ownerId = event.sender.id

      service.startTaskProgressStream(
        streamId,
        ownerId,
        hostRef,
        taskId,
        hostRefs,
        (streamEvent: TaskProgressStreamEvent) => {
          try {
            event.sender.send('rpc:taskProgressStreamEvent', { streamId, event: streamEvent })
          } catch {
            // renderer may be destroyed
          }
        }
      )

      if (!streamOwnerCleanupRegistered.has(ownerId)) {
        streamOwnerCleanupRegistered.add(ownerId)
        event.sender.once('destroyed', () => {
          service.stopHostStatusStreamsForOwner(ownerId)
          service.stopHostActivityStreamsForOwner(ownerId)
          service.stopTaskProgressStreamsForOwner(ownerId)
          service.stopWorkflowNotificationStreamsForOwner(ownerId)
          streamOwnerCleanupRegistered.delete(ownerId)
        })
      }

      return { streamId }
    }
  )

  ipcMain.handle('rpc:taskProgressStreamStop', async (event, payload: { streamId: string }) => {
    assertTrustedSender(event)
    const streamId = sanitizeString(payload?.streamId)
    if (!streamId) return { ok: true }
    const stopped = service.stopTaskProgressStream(streamId, event.sender.id)
    if (!stopped) {
      throw new Error('Forbidden: cannot stop stream owned by another renderer')
    }
    return { ok: true }
  })

  ipcMain.handle(
    'rpc:approveToolCall',
    async (event, { hostRef, taskId, toolCallId, hostRefs, teamId }) => {
      assertTrustedSender(event)
      const targetHostRef = sanitizeString(hostRef)
      const targetTaskId = sanitizeString(taskId)
      const targetToolCallId = sanitizeString(toolCallId)
      const targetHostRefs = Array.isArray(hostRefs)
        ? hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      return service.approveToolCall(
        targetHostRef,
        targetTaskId,
        targetToolCallId,
        targetHostRefs,
        { teamId: sanitizeString(teamId) || undefined }
      )
    }
  )

  ipcMain.handle(
    'rpc:denyToolCall',
    async (event, { hostRef, taskId, toolCallId, reason, hostRefs, teamId }) => {
      assertTrustedSender(event)
      const targetHostRef = sanitizeString(hostRef)
      const targetTaskId = sanitizeString(taskId)
      const targetToolCallId = sanitizeString(toolCallId)
      const denyReason = sanitizeString(reason) || 'User denied'
      const targetHostRefs = Array.isArray(hostRefs)
        ? hostRefs.map(v => String(v).trim()).filter(Boolean)
        : undefined
      return service.denyToolCall(
        targetHostRef,
        targetTaskId,
        targetToolCallId,
        denyReason,
        targetHostRefs,
        { teamId: sanitizeString(teamId) || undefined }
      )
    }
  )

  ipcMain.handle('rpc:listServers', async (event, { hostRefs }) => {
    assertTrustedSender(event)
    return service.listAccessibleMcpServers(hostRefs)
  })

  ipcMain.handle('rpc:cancelTask', async (event, { hostRef, taskId }) => {
    assertTrustedSender(event)
    const targetHostRef = sanitizeString(hostRef)
    const targetTaskId = sanitizeString(taskId)
    return service.cancelTask(targetHostRef, targetTaskId)
  })

  ipcMain.handle('rpc:listArtifacts', async (event, { hostRef, hostRefs }) => {
    assertTrustedSender(event)
    return service.listArtifacts(hostRef, hostRefs)
  })

  ipcMain.handle('rpc:downloadArtifact', async (event, { hostRef, filename, hostRefs }) => {
    assertTrustedSender(event)
    return service.downloadArtifact(hostRef, filename, hostRefs)
  })

  ipcMain.handle(
    'rpc:listSessions',
    async (
      event,
      payload: {
        hostRef: string
        hostRefs?: string[]
        query?: import('./types.js').SessionsListQuery
      }
    ) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      if (!hostRef) throw new Error('hostRef is required')
      return service.listSessions(
        hostRef,
        payload?.hostRefs,
        sanitizeSessionsListQuery(payload?.query)
      )
    }
  )

  ipcMain.handle(
    'rpc:loadSessionMessages',
    async (
      event,
      payload: {
        hostRef: string
        agent: string
        chatId: string
        hostRefs?: string[]
        query?: import('./types.js').SessionMessagesQuery
      }
    ) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      const agent = sanitizeString(payload?.agent)
      const chatId = sanitizeString(payload?.chatId)
      if (!hostRef || !agent || !chatId) {
        throw new Error('hostRef, agent, and chatId are required')
      }
      return service.loadSessionMessages(
        hostRef,
        agent,
        chatId,
        payload?.hostRefs,
        sanitizeSessionMessagesQuery(payload?.query)
      )
    }
  )

  ipcMain.handle(
    'rpc:getContextBreakdown',
    async (
      event,
      payload: { hostRef: string; agent: string; chatId: string; hostRefs?: string[] }
    ) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      const agent = sanitizeString(payload?.agent)
      const chatId = sanitizeString(payload?.chatId)
      if (!hostRef || !agent || !chatId) {
        throw new Error('hostRef, agent, and chatId are required')
      }
      return service.getContextBreakdown(hostRef, agent, chatId, payload?.hostRefs)
    }
  )

  ipcMain.handle(
    'rpc:getHostModels',
    async (event, payload: { hostRef: string; chatId: string; hostRefs?: string[] }) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      // `chatId` is optional for the model LIST (host-level allowlist). A new chat
      // has no id yet; the server returns the list with `sessionModel: null`.
      const chatId = sanitizeString(payload?.chatId)
      if (!hostRef) {
        throw new Error('hostRef is required')
      }
      return service.getHostModels(hostRef, chatId, payload?.hostRefs)
    }
  )

  ipcMain.handle(
    'rpc:setHostModel',
    async (
      event,
      payload: { hostRef: string; chatId: string; model: string; hostRefs?: string[] }
    ) => {
      assertTrustedSender(event)
      const hostRef = sanitizeString(payload?.hostRef)
      const chatId = sanitizeString(payload?.chatId)
      const model = sanitizeString(payload?.model)
      if (!hostRef || !chatId || !model) {
        throw new Error('hostRef, chatId, and model are required')
      }
      return service.setHostModel(hostRef, chatId, model, payload?.hostRefs)
    }
  )

  ipcMain.handle('rpc:getTokenMetadata', async event => {
    assertTrustedSender(event)
    return service.getTokenMetadata()
  })

  // ─── Chat persistence ───

  ipcMain.handle('chat:list', async (event, payload: { agentRef: string }) => {
    assertTrustedSender(event)
    const agentRef = sanitizeString(payload?.agentRef)
    if (!agentRef) throw new Error('agentRef is required')
    return requireChatStore().listChats(agentRef)
  })

  ipcMain.handle('chat:create', async (event, payload: { agentRef: string; chatId: string }) => {
    assertTrustedSender(event)
    const agentRef = sanitizeString(payload?.agentRef)
    const chatId = sanitizeString(payload?.chatId)
    if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
    return requireChatStore().createChat(agentRef, chatId)
  })

  ipcMain.handle(
    'chat:rename',
    async (event, payload: { agentRef: string; chatId: string; title: string }) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      const title = sanitizeString(payload?.title)
      if (!agentRef || !chatId || !title)
        throw new Error('agentRef, chatId, and title are required')
      await requireChatStore().renameChat(agentRef, chatId, title)
    }
  )

  ipcMain.handle('chat:delete', async (event, payload: { agentRef: string; chatId: string }) => {
    assertTrustedSender(event)
    const agentRef = sanitizeString(payload?.agentRef)
    const chatId = sanitizeString(payload?.chatId)
    if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
    await requireChatStore().deleteChat(agentRef, chatId)
  })

  ipcMain.handle(
    'chat:loadMessages',
    async (
      event,
      payload: { agentRef: string; chatId: string; limit?: number; offset?: number }
    ) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      const { limit, offset } = sanitizeChatLoadWindow(payload?.limit, payload?.offset)
      return requireChatStore().loadMessages(agentRef, chatId, limit, offset)
    }
  )

  ipcMain.handle(
    'chat:appendMessages',
    async (event, payload: { agentRef: string; chatId: string; messages: unknown[] }) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      await requireChatStore().appendMessages(
        agentRef,
        chatId,
        messages as import('./types.js').ChatMessage[]
      )
    }
  )

  ipcMain.handle(
    'chat:replaceMessages',
    async (
      event,
      payload: {
        agentRef: string
        chatId: string
        messages: unknown[]
        options?: import('./types.js').ReplaceChatMessagesOptions
      }
    ) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      const activeTaskIds = Array.isArray(payload?.options?.activeTaskIds)
        ? payload.options.activeTaskIds
            .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
            .slice(0, 32)
        : undefined
      await requireChatStore().replaceMessages(
        agentRef,
        chatId,
        messages as import('./types.js').ChatMessage[],
        {
          activeTaskIds,
        }
      )
    }
  )

  ipcMain.handle(
    'chat:backfillCounters',
    async (event, payload: { agentRef: string; chatId: string; messages: unknown[] }) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      await requireChatStore().backfillChatCounters(
        agentRef,
        chatId,
        messages as import('./types.js').ChatMessage[]
      )
    }
  )

  ipcMain.handle(
    'chat:markUnreadTerminal',
    async (event, payload: { agentRef: string; chatId: string }) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      await requireChatStore().markUnreadTerminal(agentRef, chatId)
    }
  )

  ipcMain.handle(
    'chat:clearUnreadTerminal',
    async (event, payload: { agentRef: string; chatId: string }) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      await requireChatStore().clearUnreadTerminal(agentRef, chatId)
    }
  )

  ipcMain.handle('chat:getLastActive', async (event, payload: { agentRef: string }) => {
    assertTrustedSender(event)
    const agentRef = sanitizeString(payload?.agentRef)
    if (!agentRef) throw new Error('agentRef is required')
    return requireChatStore().getLastActiveChatId(agentRef)
  })

  ipcMain.handle(
    'chat:setLastActive',
    async (event, payload: { agentRef: string; chatId: string }) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      const chatId = sanitizeString(payload?.chatId)
      if (!agentRef || !chatId) throw new Error('agentRef and chatId are required')
      await requireChatStore().setLastActiveChatId(agentRef, chatId)
    }
  )

  ipcMain.handle(
    'chat:reconcileSessions',
    async (
      event,
      payload: {
        agentRef: string
        sessions?: Array<{ chatId?: unknown; lastActivityAt?: unknown }>
      }
    ) => {
      assertTrustedSender(event)
      const agentRef = sanitizeString(payload?.agentRef)
      if (!agentRef) throw new Error('agentRef is required')
      const sessions = Array.isArray(payload?.sessions)
        ? payload.sessions
            .map(session => ({
              chatId: sanitizeString(session?.chatId),
              lastActivityAt:
                typeof session?.lastActivityAt === 'string' ? session.lastActivityAt : undefined,
            }))
            .filter(session => Boolean(session.chatId))
        : []
      return requireChatStore().upsertServerSessions(agentRef, sessions)
    }
  )

  ipcMain.handle('chat:getIndex', async (event, payload: { agentRef: string }) => {
    assertTrustedSender(event)
    const agentRef = sanitizeString(payload?.agentRef)
    if (!agentRef) throw new Error('agentRef is required')
    return requireChatStore().getIndex(agentRef)
  })

  ipcMain.handle('chat:dismissOnboarding', async (event, payload: { agentRef: string }) => {
    assertTrustedSender(event)
    const agentRef = sanitizeString(payload?.agentRef)
    if (!agentRef) throw new Error('agentRef is required')
    await requireChatStore().setOnboardingDismissed(agentRef, true)
  })

  // ─── Workflow triggers ───

  ipcMain.handle('workflows:list', async event => {
    assertTrustedSender(event)
    return service.listWorkflows()
  })

  ipcMain.handle('workflows:read', async (event, payload: { ns: string; name: string }) => {
    assertTrustedSender(event)
    const ns = sanitizeString(payload?.ns)
    const name = sanitizeString(payload?.name)
    if (!ns || !name) throw new Error('ns and name are required')
    return service.readWorkflow(ns, name)
  })

  ipcMain.handle('workflows:health', async (event, payload: { ns: string; name: string }) => {
    assertTrustedSender(event)
    const ns = sanitizeString(payload?.ns)
    const name = sanitizeString(payload?.name)
    if (!ns || !name) throw new Error('ns and name are required')
    return service.getWorkflowHealth(ns, name)
  })

  ipcMain.handle(
    'workflows:trigger',
    async (
      event,
      payload: {
        ns: string
        name: string
        inputs?: Record<string, unknown>
        idempotencyKey?: string
      }
    ) => {
      assertTrustedSender(event)
      const ns = sanitizeString(payload?.ns)
      const name = sanitizeString(payload?.name)
      const idempotencyKey = sanitizeString(payload?.idempotencyKey)
      if (!ns || !name) throw new Error('ns and name are required')
      return service.triggerWorkflow(ns, name, payload?.inputs, idempotencyKey || undefined)
    }
  )

  ipcMain.handle(
    'workflows:runs',
    async (event, payload: { ns: string; name: string; limit?: number }) => {
      assertTrustedSender(event)
      const ns = sanitizeString(payload?.ns)
      const name = sanitizeString(payload?.name)
      if (!ns || !name) throw new Error('ns and name are required')
      const limit = sanitizeOptionalPositiveInteger(payload?.limit, 'workflow runs limit')
      return service.listWorkflowRuns(ns, name, limit)
    }
  )

  ipcMain.handle(
    'workflows:runArtifacts',
    async (event, payload: { ns: string; name: string; runId: string }) => {
      assertTrustedSender(event)
      const ns = sanitizeString(payload?.ns)
      const name = sanitizeString(payload?.name)
      const runId = sanitizeString(payload?.runId)
      if (!ns || !name || !runId) throw new Error('ns, name, and runId are required')
      return service.listWorkflowRunArtifacts(ns, name, runId)
    }
  )

  ipcMain.handle(
    'workflows:downloadRunArtifact',
    async (event, payload: { ns: string; name: string; runId: string; artifactName: string }) => {
      assertTrustedSender(event)
      const ns = sanitizeString(payload?.ns)
      const name = sanitizeString(payload?.name)
      const runId = sanitizeString(payload?.runId)
      const artifactName = sanitizeString(payload?.artifactName)
      if (!ns || !name || !runId || !artifactName) {
        throw new Error('ns, name, runId, and artifactName are required')
      }
      const bytes = await service.downloadWorkflowRunArtifact(ns, name, runId, artifactName)
      const filename = runScopedArtifactDownloadName(runId, artifactName)
      const saved = await writeUniqueDownload(app.getPath('downloads'), filename, bytes)
      return { saved: true, ...saved }
    }
  )

  ipcMain.handle('app:openUrl', async (event, { url }: { url: string }) => {
    assertTrustedSender(event)
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('Only HTTP(S) URLs are allowed')
    }
    const { shell } = await import('electron')
    await shell.openExternal(url)
  })

  ipcMain.handle('desktop:openWindow', async (event, { hostRef }: { hostRef: string }) => {
    assertTrustedSender(event)
    if (!hostRef || typeof hostRef !== 'string') {
      throw new Error('hostRef is required')
    }
    await service.openDesktop(hostRef, closedHostRef => {
      const { BrowserWindow } = require('electron') as typeof import('electron')
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('desktop:windowClosed', { hostRef: closedHostRef })
        }
      }
    })
  })

  ipcMain.handle('desktop:closeWindow', async (event, { hostRef }: { hostRef: string }) => {
    assertTrustedSender(event)
    if (!hostRef || typeof hostRef !== 'string') {
      throw new Error('hostRef is required')
    }
    await service.closeDesktop(hostRef)
  })

  ipcMain.handle('desktop:getStatus', async (event, { hostRef }: { hostRef: string }) => {
    assertTrustedSender(event)
    if (!hostRef || typeof hostRef !== 'string') {
      throw new Error('hostRef is required')
    }
    return service.getDesktopStatus(hostRef)
  })

  // ─── Sandbox UI ─────────────────────────────────────────────────

  ipcMain.handle('sandboxUi:listApps', async event => {
    assertTrustedSender(event)
    return service.listSandboxUiApps()
  })

  ipcMain.handle(
    'sandboxUi:mintSession',
    async (event, payload: { recipeNs: string; recipeName: string }) => {
      assertTrustedSender(event)
      const recipeNs = sanitizeString(payload?.recipeNs)
      const recipeName = sanitizeString(payload?.recipeName)
      if (!recipeNs || !recipeName) {
        throw new Error('recipeNs and recipeName are required')
      }
      return service.mintSandboxUiSession(recipeNs, recipeName)
    }
  )

  function parseBounds(raw: unknown): {
    x: number
    y: number
    width: number
    height: number
    dpr?: number
  } {
    const obj = (raw ?? {}) as Record<string, unknown>
    const x = Math.round(Number(obj.x))
    const y = Math.round(Number(obj.y))
    const width = Math.round(Number(obj.width))
    const height = Math.round(Number(obj.height))
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('bounds.x/y must be numeric')
    if (!Number.isFinite(width) || width <= 0) throw new Error('bounds.width must be positive')
    if (!Number.isFinite(height) || height <= 0) throw new Error('bounds.height must be positive')
    const dprNum = Number(obj.dpr)
    const dpr = Number.isFinite(dprNum) && dprNum > 0 ? dprNum : undefined
    return { x, y, width, height, dpr }
  }

  ipcMain.handle(
    'sandboxUi:open',
    async (
      event,
      payload: {
        recipeNs: string
        recipeName: string
        defaultPath?: string
        routePath?: string
        bounds: unknown
      }
    ) => {
      assertTrustedSender(event)
      const recipeNs = sanitizeString(payload?.recipeNs)
      const recipeName = sanitizeString(payload?.recipeName)
      if (!recipeNs || !recipeName) {
        throw new Error('recipeNs and recipeName are required')
      }
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      if (!parentWindow) {
        throw new Error('cannot resolve parent window from IPC sender')
      }
      const bounds = parseBounds(payload?.bounds)
      const appRef = `${recipeNs}/${recipeName}`
      await service.openSandboxUi({
        recipeNs,
        recipeName,
        // Human title from the installed recipe, used verbatim in consent
        // prompts and notification attribution. Comes from the trusted renderer's
        // app list — NEVER from anything the plugin itself can set.
        title: sanitizeString((payload as { title?: unknown })?.title) || undefined,
        defaultPath: typeof payload?.defaultPath === 'string' ? payload.defaultPath : undefined,
        routePath: typeof payload?.routePath === 'string' ? payload.routePath : undefined,
        bounds,
        parentWindow,
        onClosed: () => {
          if (parentWindow.isDestroyed()) return
          parentWindow.webContents.send('sandboxUi:closed', { appRef })
        },
        onRefreshError: message => {
          if (parentWindow.isDestroyed()) return
          parentWindow.webContents.send('sandboxUi:refreshError', { appRef, message })
        },
      })
    }
  )

  ipcMain.handle('sandboxUi:close', async event => {
    assertTrustedSender(event)
    await service.closeSandboxUi()
  })

  ipcMain.handle('sandboxUi:reload', async event => {
    assertTrustedSender(event)
    await service.reloadSandboxUi()
  })

  ipcMain.handle('sandboxUi:copyDeepLink', async (event, payload: { teamId?: unknown }) => {
    assertTrustedSender(event)
    const teamId = sanitizeString(payload?.teamId)
    const result = await service.createSandboxUiDeepLink(teamId || undefined)
    clipboard.writeText(result.url)
    return result
  })

  ipcMain.handle('sandboxUi:setBounds', async (event, payload: { bounds: unknown }) => {
    assertTrustedSender(event)
    const bounds = parseBounds(payload?.bounds)
    await service.setSandboxUiBounds(bounds)
  })

  ipcMain.handle('sandboxUi:setVisible', async (event, payload: { visible?: unknown }) => {
    assertTrustedSender(event)
    if (typeof payload?.visible !== 'boolean') {
      throw new Error('visible must be boolean')
    }
    await service.setSandboxUiVisible(payload.visible)
  })

  ipcMain.handle('sandboxUi:capturePreview', async event => {
    assertTrustedSender(event)
    return service.captureSandboxUiPreview()
  })

  // Embed-side refresh request. NOTE: this IPC is exposed to *untrusted*
  // recipe JS via the embed preload, so we deliberately do NOT call
  // `assertTrustedSender` (the embed loads from the rpc-proxy URL, not
  // file:// or the dev URL). The trust check is the pinning map owned by
  // the refresh module: an IPC from a webContents.id that is not in the
  // map is dropped with an error.
  ipcMain.handle('clerum:sandbox-ui:request-refresh', async event => {
    await service.requestSandboxUiRefresh(event.sender.id)
  })

  // ── Plugin UI SDK ────────────────────────────────────────────────────
  //
  // Same trust model as the refresh IPC above and for the same reason: these
  // four channels are reachable by untrusted plugin JS, so `assertTrustedSender`
  // cannot be the gate (the embed's origin is rpc-proxy). Identity comes from
  // the surface pinning map, and every other check — consent, rate limits,
  // response minimization, audit — happens inside the broker. Nothing is
  // enforced here; this layer only routes.

  // Lazily imported: `pluginSdkRuntime` pulls in `config`, whose module-level
  // profile load needs a real Electron `app`. Importing it at the top of this
  // file would make merely registering IPC handlers depend on an initialized
  // Electron runtime. Mirrors how `appService` defers `sandboxUiDriver`.
  const pluginSdk = async () => (await import('./pluginSdkRuntime.js')).getPluginSdkRuntime()

  ipcMain.handle(PLUGIN_SDK_CAPABILITIES_CHANNEL, async event =>
    (await pluginSdk()).broker.listCapabilities(event.sender.id)
  )

  ipcMain.handle(PLUGIN_SDK_PERMISSION_STATE_CHANNEL, async (event, payload: unknown) =>
    (await pluginSdk()).broker.permissionState(event.sender.id, payload)
  )

  ipcMain.handle(PLUGIN_SDK_PERMISSIONS_CHANNEL, async (event, payload: unknown) =>
    (await pluginSdk()).broker.requestPermissions(event.sender.id, payload)
  )

  ipcMain.handle(PLUGIN_SDK_REQUEST_CHANNEL, async (event, payload: unknown) =>
    (await pluginSdk()).broker.request(event.sender.id, payload)
  )

  // ── Plugin SDK, trusted-renderer half ────────────────────────────────
  //
  // The consent resolve channel IS trusted-sender guarded. That is what stops
  // an embed from answering its own permission prompt, and it pairs with the
  // main-generated `promptId` nonce: a resolve for an unknown or already-
  // answered prompt is dropped inside the gate (spec §9.4).

  ipcMain.handle(
    PLUGIN_SDK_CONSENT_RESOLVE_CHANNEL,
    async (event, payload: { promptId?: unknown; allowed?: unknown }) => {
      assertTrustedSender(event)
      const promptId = sanitizeString(payload?.promptId)
      if (!promptId) throw new Error('promptId is required')
      const allowed = Array.isArray(payload?.allowed)
        ? payload.allowed.filter((entry): entry is string => typeof entry === 'string')
        : []
      return (await pluginSdk()).resolveConsentPrompt(promptId, allowed)
    }
  )

  ipcMain.handle('pluginSdk:listGrants', async event => {
    assertTrustedSender(event)
    return (await pluginSdk()).listGrants()
  })

  ipcMain.handle(
    'pluginSdk:revoke',
    async (event, payload: { pluginId?: unknown; capability?: unknown }) => {
      assertTrustedSender(event)
      const pluginId = sanitizeString(payload?.pluginId)
      const capability = sanitizeString(payload?.capability)
      if (!pluginId) throw new Error('pluginId is required')
      const runtime = await pluginSdk()
      if (capability) await runtime.revokeGrant(pluginId, capability)
      else await runtime.revokeAllForPlugin(pluginId)
    }
  )

  ipcMain.handle(
    'pluginSdk:activity',
    async (event, payload: { limit?: unknown; includeAmbient?: unknown }) => {
      assertTrustedSender(event)
      return (await pluginSdk()).readAudit({
        limit: sanitizeOptionalInteger(payload?.limit),
        includeAmbient: payload?.includeAmbient === true,
      })
    }
  )

  ipcMain.handle('pluginSdk:clearActivity', async event => {
    assertTrustedSender(event)
    await (await pluginSdk()).clearAudit()
  })

  ipcMain.handle('pluginSdk:setTheme', async (event, payload: { theme?: unknown }) => {
    assertTrustedSender(event)
    ;(await pluginSdk()).setTheme(payload?.theme)
  })
}
