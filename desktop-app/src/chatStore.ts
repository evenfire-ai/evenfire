import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeAuthoritativeServerMessages, messageServerTurnNumber } from './chatMessageMerge.js'
import { assertSafeFilesystemSegment } from './pathSafety.js'
import type {
  ChatFile,
  ChatIndex,
  ChatMessage,
  ChatMetadata,
  ReplaceChatMessagesOptions,
} from './types.js'

// Keep the catalog at v2 while paged transcripts are dual-readable by the
// pre-paging desktop build. The page layout has its own versioned metadata.
const INDEX_VERSION = 2
const PAGED_CHAT_VERSION = 1
const DEFAULT_PAGE_SIZE = 100
const MAX_COMPATIBILITY_WINDOWS = 100
const MAX_COMPATIBILITY_WINDOW_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_LOCAL_SYNCED_MESSAGES = 1000
const LEGACY_COMPATIBILITY_MESSAGE_LIMIT = 100
const PAGE_FILE_PATTERN = /^\d{6}\.json$/

export interface ChatStoreOptions {
  pageSize?: number
  maxLocalSyncedMessages?: number
}

interface ChatPageEntry {
  file: string
  count: number
  serverSynced: boolean
  firstServerTurnNumber?: number
  lastServerTurnNumber?: number
}

interface PagedChatMeta {
  version: typeof PAGED_CHAT_VERSION
  chatId: string
  pageSize: number
  messageCount: number
  localMessageCount: number
  prunedBeforeCount?: number
  legacyCompatibilitySignature?: string
  pages: ChatPageEntry[]
}

interface ChatPageFile {
  version: typeof PAGED_CHAT_VERSION
  chatId: string
  pageNumber: number
  messages: ChatMessage[]
}

interface SnapshotCandidate {
  dir: string
  kind: 'next' | 'previous'
  token: string
  mtimeMs: number
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : fallback
}

function normalizeMaxLocalSyncedMessages(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_LOCAL_SYNCED_MESSAGES
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(value)) return DEFAULT_MAX_LOCAL_SYNCED_MESSAGES
  return Math.max(0, Math.floor(value))
}

function pageFileName(pageNumber: number): string {
  return `${pageNumber.toString().padStart(6, '0')}.json`
}

function pageNumberFromFileName(fileName: string): number {
  if (!PAGE_FILE_PATTERN.test(fileName)) return 0
  return Number(fileName.slice(0, 6))
}

function isNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isRawFilesystemError(err: unknown): boolean {
  return typeof (err as NodeJS.ErrnoException | undefined)?.code === 'string'
}

function isUnsupportedDirectorySyncError(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP'
}

function isUnsafeSegmentError(err: unknown): boolean {
  return err instanceof Error && /unsafe path segment/.test(err.message)
}

function aggregateMessages(
  messages: ChatMessage[]
): Pick<ChatMetadata, 'errorCount' | 'toolCallCount'> {
  return {
    errorCount: messages.reduce((total, message) => total + (message.isError ? 1 : 0), 0),
    toolCallCount: messages.reduce((total, message) => total + (message.toolSteps?.length ?? 0), 0),
  }
}

function visibleMessageCount(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + (message.role === 'user' || message.role === 'assistant' ? 1 : 0),
    0
  )
}

function pageEntry(file: string, messages: ChatMessage[]): ChatPageEntry {
  const serverTurns = messages
    .map(messageServerTurnNumber)
    .filter((turn): turn is number => turn !== undefined)
  return {
    file,
    count: messages.length,
    serverSynced: messages.length > 0 && serverTurns.length === messages.length,
    firstServerTurnNumber: serverTurns.length ? Math.min(...serverTurns) : undefined,
    lastServerTurnNumber: serverTurns.length ? Math.max(...serverTurns) : undefined,
  }
}

function samePageEntry(left: ChatPageEntry, right: ChatPageEntry): boolean {
  return (
    left.file === right.file &&
    left.count === right.count &&
    left.serverSynced === right.serverSynced &&
    left.firstServerTurnNumber === right.firstServerTurnNumber &&
    left.lastServerTurnNumber === right.lastServerTurnNumber
  )
}

function parseChatIndex(raw: string): ChatIndex {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid chat index')
  }
  const candidate = parsed as Record<string, unknown>
  if (
    (candidate.version !== 2 && candidate.version !== 3) ||
    (candidate.lastActiveChatId !== null && typeof candidate.lastActiveChatId !== 'string') ||
    typeof candidate.onboardingDismissed !== 'boolean' ||
    !Array.isArray(candidate.chats)
  ) {
    throw new Error('Invalid chat index')
  }
  for (const chat of candidate.chats) {
    if (!chat || typeof chat !== 'object') throw new Error('Invalid chat index entry')
    const metadata = chat as Record<string, unknown>
    if (
      typeof metadata.id !== 'string' ||
      typeof metadata.title !== 'string' ||
      typeof metadata.createdAt !== 'string' ||
      typeof metadata.updatedAt !== 'string' ||
      !isNonNegativeSafeInteger(metadata.messageCount) ||
      (metadata.errorCount !== undefined && !isNonNegativeSafeInteger(metadata.errorCount)) ||
      (metadata.toolCallCount !== undefined && !isNonNegativeSafeInteger(metadata.toolCallCount)) ||
      (metadata.unreadTerminal !== undefined && typeof metadata.unreadTerminal !== 'boolean') ||
      (metadata.lastTerminalAt !== undefined && typeof metadata.lastTerminalAt !== 'string')
    ) {
      throw new Error('Invalid chat index entry')
    }
  }
  return { ...candidate, version: INDEX_VERSION } as unknown as ChatIndex
}

/**
 * Reject any path-component (agentRef / chatId) that could escape the store
 * root via `path.join`. agentRefs are slugs and chatIds are UUIDs in practice,
 * so this only ever trips on malicious/garbage input — but `replaceMessages`
 * (wholesale overwrite) and `deleteChat` (unlink) make traversal high-impact,
 * so we guard centrally where the on-disk path is built.
 */
function encodedChatId(chatId: string): string {
  return Buffer.from(chatId, 'utf8').toString('base64url')
}

function legacyCorruptFileBelongsToChat(fileName: string, chatId: string): boolean {
  const encoded = encodedChatId(chatId)
  const match =
    /^(.*)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.exec(
      fileName
    )
  return match?.[1] === encoded
}

function sameReconciledMessage(local: ChatMessage, server: ChatMessage): boolean {
  if (local.id === server.id) return true
  const localTurn = messageServerTurnNumber(local)
  const serverTurn = messageServerTurnNumber(server)
  if (
    localTurn !== undefined &&
    serverTurn !== undefined &&
    localTurn === serverTurn &&
    local.role === server.role
  ) {
    return true
  }
  if (
    localTurn === undefined &&
    serverTurn !== undefined &&
    local.role === server.role &&
    ((local.task_id && server.task_id && local.task_id === server.task_id) ||
      (local.content.trim() === server.content.trim() &&
        Math.abs(local.timestamp - server.timestamp) <= 60_000))
  ) {
    return true
  }
  return false
}

function reconciledMessageRoleRank(message: ChatMessage): number {
  return message.role === 'user' ? 0 : message.role === 'assistant' ? 1 : 2
}

function mergeReconciledMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const merged = [...existing]
  for (const serverMessage of incoming) {
    const matchIndex = merged.findIndex(message => sameReconciledMessage(message, serverMessage))
    if (matchIndex >= 0) {
      merged[matchIndex] = {
        ...serverMessage,
        task_id: merged[matchIndex]?.task_id ?? serverMessage.task_id,
      }
      continue
    }

    const serverTurn = messageServerTurnNumber(serverMessage)
    const insertionIndex =
      serverTurn === undefined
        ? -1
        : merged.findIndex(message => {
            const messageTurn = messageServerTurnNumber(message)
            if (messageTurn === undefined) return false
            return (
              messageTurn > serverTurn ||
              (messageTurn === serverTurn &&
                reconciledMessageRoleRank(message) > reconciledMessageRoleRank(serverMessage))
            )
          })
    if (insertionIndex < 0) merged.push(serverMessage)
    else merged.splice(insertionIndex, 0, serverMessage)
  }
  return merged
}

function emptyIndex(): ChatIndex {
  return {
    version: INDEX_VERSION,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: [],
  }
}

export class ChatStore {
  private readonly pageSize: number
  private readonly maxLocalSyncedMessages: number

  constructor(
    private readonly baseDir: string,
    options: ChatStoreOptions = {}
  ) {
    this.pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE)
    this.maxLocalSyncedMessages = normalizeMaxLocalSyncedMessages(options.maxLocalSyncedMessages)
  }

  /**
   * Index read-modify-write sequences are serialized per agent because every
   * chat shares one `index.json`. Paged transcript operations use a separate
   * per-chat chain so reads stay atomic with writes for the same chat without
   * queuing behind unrelated chat activity.
   */
  private indexChains = new Map<string, Promise<unknown>>()
  private chatChains = new Map<string, Promise<unknown>>()
  private cleanedSnapshotSiblingKeys = new Set<string>()
  private compatibilityCheckedKeys = new Set<string>()
  private compatibilityWindows = new Map<string, ChatMessage[]>()
  private compatibilityWindowBytes = new Map<string, number>()
  private compatibilityWindowsTotalBytes = 0

  private dropCompatibilityWindow(key: string): void {
    this.compatibilityWindows.delete(key)
    this.compatibilityWindowsTotalBytes -= this.compatibilityWindowBytes.get(key) ?? 0
    this.compatibilityWindowBytes.delete(key)
  }

  private cacheCompatibilityWindow(key: string, messages: ChatMessage[]): void {
    this.dropCompatibilityWindow(key)
    const sizeBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8')
    this.compatibilityWindows.set(key, [...messages])
    this.compatibilityWindowBytes.set(key, sizeBytes)
    this.compatibilityWindowsTotalBytes += sizeBytes
    while (
      this.compatibilityWindows.size > MAX_COMPATIBILITY_WINDOWS ||
      this.compatibilityWindowsTotalBytes > MAX_COMPATIBILITY_WINDOW_BYTES
    ) {
      const oldestKey = this.compatibilityWindows.keys().next().value
      if (typeof oldestKey !== 'string') break
      this.dropCompatibilityWindow(oldestKey)
    }
  }

  private serialize<T>(
    chains: Map<string, Promise<unknown>>,
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    chains.set(key, settled)
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return run
  }

  private serializeIndex<T>(agentRef: string, fn: () => Promise<T>): Promise<T> {
    return this.serialize(this.indexChains, agentRef, fn)
  }

  private serializeChat<T>(agentRef: string, chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.serialize(this.chatChains, JSON.stringify([agentRef, chatId]), fn)
  }

  private chatSnapshotCleanupKey(agentRef: string, chatId: string): string {
    return JSON.stringify([agentRef, chatId])
  }

  private agentDir(agentRef: string): string {
    assertSafeFilesystemSegment('agentRef', agentRef)
    return join(this.baseDir, agentRef)
  }

  private indexPath(agentRef: string): string {
    return join(this.agentDir(agentRef), 'index.json')
  }

  private corruptIndexPath(agentRef: string): string {
    return join(this.agentDir(agentRef), '.corrupt', `index-${randomUUID()}.json`)
  }

  private chatFilePath(agentRef: string, chatId: string): string {
    assertSafeFilesystemSegment('chatId', chatId, {
      reservedNames: ['index', 'chats'],
    })
    return join(this.agentDir(agentRef), `${chatId}.json`)
  }

  private chatCompatibilitySignaturePath(agentRef: string, chatId: string): string {
    assertSafeFilesystemSegment('chatId', chatId, {
      reservedNames: ['index', 'chats'],
    })
    return join(this.agentDir(agentRef), `${chatId}.compat`)
  }

  private corruptLegacyChatFilePath(agentRef: string, chatId: string): string {
    assertSafeFilesystemSegment('chatId', chatId, {
      reservedNames: ['index', 'chats'],
    })
    return join(this.agentDir(agentRef), '.corrupt', encodedChatId(chatId), `${randomUUID()}.json`)
  }

  private chatDirPath(agentRef: string, chatId: string): string {
    assertSafeFilesystemSegment('chatId', chatId, {
      reservedNames: ['index', 'chats'],
    })
    return join(this.agentDir(agentRef), 'chats', chatId)
  }

  private chatSnapshotSiblingPath(
    agentRef: string,
    chatId: string,
    kind: 'next' | 'previous' | 'corrupt',
    token: string
  ): string {
    assertSafeFilesystemSegment('chatId', chatId, {
      reservedNames: ['index', 'chats'],
    })
    return join(
      this.agentDir(agentRef),
      'chats',
      '.snapshots',
      encodedChatId(chatId),
      `${kind}-${token}`
    )
  }

  private chatSnapshotRootPath(agentRef: string, chatId: string): string {
    assertSafeFilesystemSegment('chatId', chatId, {
      reservedNames: ['index', 'chats'],
    })
    return join(this.agentDir(agentRef), 'chats', '.snapshots', encodedChatId(chatId))
  }

  private chatPagesDirPath(agentRef: string, chatId: string): string {
    return this.chatPagesDirFromChatDir(this.chatDirPath(agentRef, chatId))
  }

  private chatMetaPath(agentRef: string, chatId: string): string {
    return this.chatMetaPathFromChatDir(this.chatDirPath(agentRef, chatId))
  }

  private chatPagesDirFromChatDir(chatDir: string): string {
    return join(chatDir, 'pages')
  }

  private chatMetaPathFromChatDir(chatDir: string): string {
    return join(chatDir, 'meta.json')
  }

  private chatPagePathFromPagesDir(pagesDir: string, fileName: string): string {
    if (!PAGE_FILE_PATTERN.test(fileName)) {
      throw new Error(`Invalid chat page: unsafe file name`)
    }
    return join(pagesDir, fileName)
  }

  private chatPagePath(agentRef: string, chatId: string, fileName: string): string {
    return this.chatPagePathFromPagesDir(this.chatPagesDirPath(agentRef, chatId), fileName)
  }

  private async syncFile(filePath: string): Promise<void> {
    const handle = await fs.open(filePath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(directoryPath, 'r')
      await handle.sync()
    } catch (error) {
      // Node cannot open/fsync directories on Windows. The file itself is still
      // flushed before rename; retain directory fsync on platforms that support it.
      if (!isUnsupportedDirectorySyncError(error)) throw error
    } finally {
      await handle?.close()
    }
  }

  private async syncRenamedEntry(sourcePath: string, targetPath: string): Promise<void> {
    const sourceDir = dirname(sourcePath)
    const targetDir = dirname(targetPath)
    await this.syncDirectory(sourceDir)
    if (targetDir !== sourceDir) {
      await this.syncDirectory(targetDir)
    }
  }

  private async writeJsonAtomic(
    filePath: string,
    value: unknown,
    indentation?: number
  ): Promise<void> {
    const tmp = `${filePath}.tmp`
    try {
      const serialized = JSON.stringify(value, null, indentation)
      if (serialized === undefined) throw new TypeError('Unable to serialize JSON value')
      await fs.writeFile(tmp, serialized, { mode: 0o600 })
      await this.syncFile(tmp)
      await fs.rename(tmp, filePath)
      await this.syncRenamedEntry(tmp, filePath)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  }

  private finalizePagedMeta(meta: PagedChatMeta): PagedChatMeta {
    const localMessageCount = meta.pages.reduce((total, page) => total + page.count, 0)

    return {
      ...meta,
      pageSize: this.pageSize,
      localMessageCount,
    }
  }

  private async readPagedMeta(agentRef: string, chatId: string): Promise<PagedChatMeta | null> {
    return this.readPagedMetaAtPath(this.chatMetaPath(agentRef, chatId), chatId)
  }

  private async readPagedMetaAtPath(
    metaPath: string,
    chatId: string
  ): Promise<PagedChatMeta | null> {
    let raw: string
    try {
      raw = await fs.readFile(metaPath, 'utf-8')
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }

    try {
      const parsed = JSON.parse(raw) as PagedChatMeta
      if (
        parsed?.version !== PAGED_CHAT_VERSION ||
        parsed.chatId !== chatId ||
        !Array.isArray(parsed.pages) ||
        !isPositiveSafeInteger(parsed.pageSize) ||
        !isNonNegativeSafeInteger(parsed.messageCount) ||
        !isNonNegativeSafeInteger(parsed.localMessageCount) ||
        (parsed.prunedBeforeCount !== undefined &&
          !isNonNegativeSafeInteger(parsed.prunedBeforeCount))
      ) {
        throw new Error('Invalid paged chat metadata')
      }
      let previousPageNumber: number | undefined
      for (const page of parsed.pages) {
        const pageNumber = pageNumberFromFileName(page.file)
        if (
          !PAGE_FILE_PATTERN.test(page.file) ||
          !isPositiveSafeInteger(page.count) ||
          (previousPageNumber !== undefined && pageNumber !== previousPageNumber + 1)
        ) {
          throw new Error('Invalid paged chat metadata page reference')
        }
        previousPageNumber = pageNumber
      }
      return this.finalizePagedMeta({
        ...parsed,
        pageSize: normalizePositiveInteger(parsed.pageSize, this.pageSize),
        messageCount: parsed.messageCount,
        localMessageCount: parsed.localMessageCount,
      })
    } catch (err) {
      throw new Error(`Unable to read paged chat metadata for ${chatId}`, { cause: err })
    }
  }

  private async readLegacyMessages(
    agentRef: string,
    chatId: string
  ): Promise<ChatMessage[] | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.chatFilePath(agentRef, chatId), 'utf-8')
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }

    try {
      const file = JSON.parse(raw) as ChatFile
      if (!file || !Array.isArray(file.messages)) {
        throw new Error('Invalid legacy chat file')
      }
      return file.messages
    } catch (err) {
      // Old flat chat files were written in place, so a crash could leave
      // truncated JSON. Quarantine only malformed content; filesystem errors
      // above still propagate. Returning "no legacy snapshot" lets the server
      // rehydrate the chat and makes subsequent appends writable again.
      const corruptPath = this.corruptLegacyChatFilePath(agentRef, chatId)
      await fs.mkdir(dirname(corruptPath), { recursive: true, mode: 0o700 })
      await fs.rename(this.chatFilePath(agentRef, chatId), corruptPath)
      return null
    }
  }

  /**
   * Keep a bounded v2 flat-file window for pre-paging desktop builds.
   *
   * Rewriting this fixed-size window preserves downgrade readability without
   * restoring the old unbounded whole-conversation write cost. The server
   * remains the source of truth for older synced turns.
   */
  private legacyCompatibilitySnapshot(
    chatId: string,
    messages: ChatMessage[]
  ): { file: ChatFile; signature: string } {
    const compatibilityMessages = messages.slice(-LEGACY_COMPATIBILITY_MESSAGE_LIMIT)
    const file: ChatFile = {
      version: 2,
      chatId,
      messages: compatibilityMessages,
    }
    const signature = createHash('sha256')
      .update(JSON.stringify([chatId, compatibilityMessages]))
      .digest('hex')
    return { file, signature }
  }

  private async writeLegacyCompatibilitySnapshot(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[]
  ): Promise<string> {
    const { file, signature } = this.legacyCompatibilitySnapshot(chatId, messages)
    await this.writeJsonAtomic(this.chatFilePath(agentRef, chatId), file)
    await this.writeJsonAtomic(this.chatCompatibilitySignaturePath(agentRef, chatId), {
      signature,
    })
    this.cacheCompatibilityWindow(this.chatSnapshotCleanupKey(agentRef, chatId), file.messages)
    return signature
  }

  private async readLegacyCompatibilitySignature(
    agentRef: string,
    chatId: string
  ): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.chatCompatibilitySignaturePath(agentRef, chatId), 'utf-8')
      const parsed = JSON.parse(raw) as { signature?: unknown }
      return typeof parsed.signature === 'string' ? parsed.signature : null
    } catch {
      return null
    }
  }

  private async refreshLegacyCompatibilitySnapshotUnlocked(
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta
  ): Promise<PagedChatMeta> {
    const compatibilityMessages = await this.readMessagesFromPagedMeta(
      agentRef,
      chatId,
      meta,
      LEGACY_COMPATIBILITY_MESSAGE_LIMIT
    )
    const signature = await this.writeLegacyCompatibilitySnapshot(
      agentRef,
      chatId,
      compatibilityMessages
    )
    const refreshed = { ...meta, legacyCompatibilitySignature: signature }
    await this.writePagedMeta(agentRef, chatId, refreshed)
    return refreshed
  }

  /**
   * A downgraded build may append local messages to the v2 compatibility file.
   * Import only messages missing from the paged snapshot before refreshing the
   * bounded window, so upgrading again cannot discard offline work.
   */
  private async importDowngradedLocalMessagesUnlocked(
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta
  ): Promise<PagedChatMeta> {
    const compatibilityKey = this.chatSnapshotCleanupKey(agentRef, chatId)
    let legacyMessages: ChatMessage[] | null
    try {
      legacyMessages = await this.readLegacyMessages(agentRef, chatId)
    } catch (error) {
      if (isRawFilesystemError(error)) {
        console.warn(`[chatStore] Downgrade snapshot unavailable for ${chatId}:`, error)
        this.compatibilityCheckedKeys.add(compatibilityKey)
        return meta
      }
      const refreshed = await this.refreshLegacyCompatibilitySnapshotUnlocked(
        agentRef,
        chatId,
        meta
      )
      this.compatibilityCheckedKeys.add(compatibilityKey)
      return refreshed
    }
    if (!legacyMessages) {
      const refreshed = await this.refreshLegacyCompatibilitySnapshotUnlocked(
        agentRef,
        chatId,
        meta
      )
      this.compatibilityCheckedKeys.add(compatibilityKey)
      return refreshed
    }
    this.cacheCompatibilityWindow(compatibilityKey, legacyMessages)

    const legacySignature = this.legacyCompatibilitySnapshot(chatId, legacyMessages).signature
    if (legacySignature === meta.legacyCompatibilitySignature) {
      this.compatibilityCheckedKeys.add(compatibilityKey)
      return meta
    }
    const recordedSignature = await this.readLegacyCompatibilitySignature(agentRef, chatId)
    if (legacySignature === recordedSignature) {
      const refreshed = await this.refreshLegacyCompatibilitySnapshotUnlocked(
        agentRef,
        chatId,
        meta
      )
      this.compatibilityCheckedKeys.add(compatibilityKey)
      return refreshed
    }

    const existing = await this.readMessagesFromPagedMeta(agentRef, chatId, meta)
    const missing = legacyMessages.filter(
      candidate =>
        !existing.some(
          message =>
            sameReconciledMessage(candidate, message) || sameReconciledMessage(message, candidate)
        )
    )
    if (!missing.length) {
      const refreshed = await this.refreshLegacyCompatibilitySnapshotUnlocked(
        agentRef,
        chatId,
        meta
      )
      this.compatibilityCheckedKeys.add(compatibilityKey)
      return refreshed
    }

    const merged = mergeReconciledMessages(existing, missing)
    const indexedCount = await this.indexedMessageCount(agentRef, chatId)
    const imported = await this.writePagedChatUnlocked(agentRef, chatId, merged, {
      messageCount: Math.max(meta.messageCount, merged.length, indexedCount ?? 0),
    })
    await this.updateChatIndexFromMessages(agentRef, chatId, merged, {
      preserveExistingTotals: true,
      touchUpdatedAt: false,
    })
    this.compatibilityCheckedKeys.add(compatibilityKey)
    return imported
  }

  private async readPageMessages(
    agentRef: string,
    chatId: string,
    page: ChatPageEntry
  ): Promise<ChatMessage[]> {
    return this.readPageMessagesAtPath(
      chatId,
      pageNumberFromFileName(page.file),
      this.chatPagePath(agentRef, chatId, page.file)
    )
  }

  private async readPageMessagesAtPath(
    chatId: string,
    pageNumber: number,
    pagePath: string
  ): Promise<ChatMessage[]> {
    const raw = await fs.readFile(pagePath, 'utf-8')

    try {
      const parsed = JSON.parse(raw) as ChatPageFile
      if (
        parsed?.version !== PAGED_CHAT_VERSION ||
        parsed.chatId !== chatId ||
        parsed.pageNumber !== pageNumber ||
        !Array.isArray(parsed.messages)
      ) {
        throw new Error('Invalid chat page file')
      }
      return parsed.messages
    } catch (err) {
      throw new Error(`Unable to read paged chat page for ${chatId}`, { cause: err })
    }
  }

  private async writePageMessages(
    agentRef: string,
    chatId: string,
    pageNumber: number,
    messages: ChatMessage[]
  ): Promise<ChatPageEntry> {
    return this.writePageMessagesToDir(
      chatId,
      this.chatPagesDirPath(agentRef, chatId),
      pageNumber,
      messages
    )
  }

  private async writePageMessagesToDir(
    chatId: string,
    pagesDir: string,
    pageNumber: number,
    messages: ChatMessage[]
  ): Promise<ChatPageEntry> {
    const file = pageFileName(pageNumber)
    const page: ChatPageFile = {
      version: PAGED_CHAT_VERSION,
      chatId,
      pageNumber,
      messages,
    }
    await this.writeJsonAtomic(this.chatPagePathFromPagesDir(pagesDir, file), page)
    return pageEntry(file, messages)
  }

  private async writePagedMeta(
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta
  ): Promise<void> {
    await this.writePagedMetaToDir(chatId, this.chatDirPath(agentRef, chatId), meta)
  }

  private async writePagedMetaToDir(
    chatId: string,
    chatDir: string,
    meta: PagedChatMeta
  ): Promise<void> {
    await this.writeJsonAtomic(this.chatMetaPathFromChatDir(chatDir), {
      ...this.finalizePagedMeta(meta),
      chatId,
    })
  }

  private async pruneSyncedPages(
    meta: PagedChatMeta
  ): Promise<{ meta: PagedChatMeta; removedFiles: string[] }> {
    if (this.maxLocalSyncedMessages === Number.POSITIVE_INFINITY) {
      return { meta: this.finalizePagedMeta(meta), removedFiles: [] }
    }

    let localCount = meta.pages.reduce((total, page) => total + page.count, 0)
    let prunedBeforeCount = meta.prunedBeforeCount ?? 0
    const retained: ChatPageEntry[] = []
    const removedFiles: string[] = []
    for (const page of meta.pages) {
      const canPrunePage =
        page.serverSynced && localCount - page.count >= this.maxLocalSyncedMessages

      if (canPrunePage) {
        removedFiles.push(page.file)
        localCount -= page.count
        prunedBeforeCount += page.count
        continue
      }

      retained.push(page)
      // Pruning must remove only a contiguous prefix. Once a legacy/local-only
      // page is retained, deleting a later synced page would punch a permanent
      // hole in the middle of the transcript and make load-older cursors lie.
      retained.push(...meta.pages.slice(retained.length + removedFiles.length))
      break
    }

    return {
      meta: this.finalizePagedMeta({
        ...meta,
        pages: retained,
        prunedBeforeCount: prunedBeforeCount > 0 ? prunedBeforeCount : undefined,
      }),
      removedFiles,
    }
  }

  /**
   * Finish page writes that reached disk before their metadata update.
   *
   * Existing pages may contain a durable append beyond the count recorded in
   * meta.json, and newly-created pages may exist after the last referenced page.
   * Both are safe to adopt because page files are themselves written atomically.
   */
  private async adoptDurablePageWritesUnlocked(
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta
  ): Promise<PagedChatMeta | null> {
    const pagesDir = this.chatPagesDirPath(agentRef, chatId)
    const repairedPages: ChatPageEntry[] = []
    let changed = false

    for (const [index, page] of meta.pages.entries()) {
      let messages: ChatMessage[]
      try {
        messages = await this.readPageMessages(agentRef, chatId, page)
      } catch (error) {
        if (isRawFilesystemError(error) && !isNotFoundError(error)) throw error
        return null
      }
      if (messages.length < page.count) return null
      if (messages.length > page.count && index !== meta.pages.length - 1) return null
      const repaired = pageEntry(page.file, messages)
      repairedPages.push(repaired)
      changed ||= !samePageEntry(repaired, page)
    }

    const referenced = new Set(repairedPages.map(page => page.file))
    const lastReferencedNumber = pageNumberFromFileName(repairedPages.at(-1)?.file ?? '')
    const entries = await fs.readdir(pagesDir).catch(() => [])
    const durableOrphans = entries
      .filter(
        file =>
          PAGE_FILE_PATTERN.test(file) &&
          !referenced.has(file) &&
          pageNumberFromFileName(file) > lastReferencedNumber
      )
      .sort((a, b) => pageNumberFromFileName(a) - pageNumberFromFileName(b))

    let expectedPageNumber = lastReferencedNumber + 1
    for (const file of durableOrphans) {
      const pageNumber = pageNumberFromFileName(file)
      // Reader metadata requires contiguous page numbers. A later orphan cannot
      // prove that the missing page was never written, so stop at the first gap.
      if (pageNumber !== expectedPageNumber) break
      try {
        const messages = await this.readPageMessagesAtPath(
          chatId,
          pageNumber,
          this.chatPagePathFromPagesDir(pagesDir, file)
        )
        if (!messages.length) break
        repairedPages.push(pageEntry(file, messages))
        referenced.add(file)
        changed = true
        expectedPageNumber += 1
      } catch (error) {
        if (isRawFilesystemError(error) && !isNotFoundError(error)) throw error
        // Leave an invalid orphan untouched. It is not referenced by metadata,
        // so it cannot break reads and may still be useful for manual recovery.
        // Later pages are not safe to adopt across this gap.
        break
      }
    }

    if (!changed) return meta
    const previousLocalCount = meta.pages.reduce((total, page) => total + page.count, 0)
    const nextLocalCount = repairedPages.reduce((total, page) => total + page.count, 0)
    const repaired = this.finalizePagedMeta({
      ...meta,
      messageCount: Math.max(
        meta.messageCount + Math.max(0, nextLocalCount - previousLocalCount),
        nextLocalCount + (meta.prunedBeforeCount ?? 0)
      ),
      pages: repairedPages,
    })
    await this.writePagedMeta(agentRef, chatId, repaired)
    await this.updateIndexedMessageCount(agentRef, chatId, repaired.messageCount)
    return repaired
  }

  private async updateIndexedMessageCount(
    agentRef: string,
    chatId: string,
    messageCount: number
  ): Promise<void> {
    await this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(candidate => candidate.id === chatId)
      if (!chat || chat.messageCount >= messageCount) return
      chat.messageCount = messageCount
      await this.saveIndex(agentRef, index)
    })
  }

  private async rebuildPagedChatFromSurvivingFilesUnlocked(
    agentRef: string,
    chatId: string
  ): Promise<boolean> {
    const pagesDir = this.chatPagesDirPath(agentRef, chatId)
    const entries = await fs.readdir(pagesDir).catch(() => [])
    const surviving: ChatMessage[] = []
    for (const file of entries
      .filter(candidate => PAGE_FILE_PATTERN.test(candidate))
      .sort((a, b) => pageNumberFromFileName(a) - pageNumberFromFileName(b))) {
      try {
        surviving.push(
          ...(await this.readPageMessagesAtPath(
            chatId,
            pageNumberFromFileName(file),
            this.chatPagePathFromPagesDir(pagesDir, file)
          ))
        )
      } catch (error) {
        if (isRawFilesystemError(error) && !isNotFoundError(error)) throw error
        // Skip only the unreadable page; readable siblings are still valuable.
      }
    }

    const legacy = await this.readLegacyMessages(agentRef, chatId).catch(error => {
      if (isRawFilesystemError(error) && !isNotFoundError(error)) throw error
      return null
    })
    const recovered = mergeReconciledMessages(surviving, legacy ?? [])
    if (!recovered.length) return false
    await this.writePagedChatUnlocked(agentRef, chatId, recovered, {
      messageCount: recovered.length,
    })
    await this.updateIndexedMessageCount(agentRef, chatId, recovered.length)
    return true
  }

  private async recoverPagedChatUnlocked(
    agentRef: string,
    chatId: string
  ): Promise<PagedChatMeta | null> {
    const activeDir = this.chatDirPath(agentRef, chatId)
    const snapshotRoot = this.chatSnapshotRootPath(agentRef, chatId)
    const cleanupKey = this.chatSnapshotCleanupKey(agentRef, chatId)
    let activeMeta: PagedChatMeta | null = null
    let activeReadError: unknown

    try {
      activeMeta = await this.readPagedMeta(agentRef, chatId)
    } catch (err) {
      if (isRawFilesystemError(err) && !isNotFoundError(err)) throw err
      activeReadError = err
    }

    if (activeMeta) {
      if (this.cleanedSnapshotSiblingKeys.has(cleanupKey)) return activeMeta
      const repaired = await this.adoptDurablePageWritesUnlocked(agentRef, chatId, activeMeta)
      if (repaired) {
        await this.removePagedChatSnapshotSiblings(agentRef, chatId)
        this.cleanedSnapshotSiblingKeys.add(cleanupKey)
        return repaired
      }
      activeReadError = new Error(`Paged chat snapshot is incomplete for ${chatId}`)
      activeMeta = null
    }

    if (!activeReadError) {
      const activeStat = await fs.stat(activeDir).catch(() => null)
      if (activeStat?.isDirectory()) {
        activeReadError = new Error(`Paged chat metadata missing for ${chatId}`)
      }
    }

    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = await fs.readdir(snapshotRoot, { withFileTypes: true })
    } catch {
      entries = []
    }
    if (!activeReadError && entries.length === 0) return null

    const snapshots = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const nextPrefix = 'next-'
          const previousPrefix = 'previous-'
          const kind = entry.name.startsWith(nextPrefix)
            ? 'next'
            : entry.name.startsWith(previousPrefix)
              ? 'previous'
              : null
          if (!kind) return null
          const token =
            kind === 'next'
              ? entry.name.slice(nextPrefix.length)
              : entry.name.slice(previousPrefix.length)
          if (!token) return null
          const dir = join(snapshotRoot, entry.name)
          const meta = await this.readPagedMetaAtPath(
            this.chatMetaPathFromChatDir(dir),
            chatId
          ).catch(() => null)
          if (!meta || !(await this.isCompletePagedSnapshot(dir, chatId, meta))) return null
          const stat = await fs.stat(dir).catch(() => null)
          return {
            dir,
            kind,
            token,
            mtimeMs: stat?.mtimeMs ?? 0,
          }
        })
    )
    const validSnapshots = snapshots
      .filter((snapshot): snapshot is SnapshotCandidate => snapshot !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    const groups = new Map<
      string,
      { next?: SnapshotCandidate; previous?: SnapshotCandidate; mtimeMs: number }
    >()
    for (const snapshot of validSnapshots) {
      const group = groups.get(snapshot.token) ?? { mtimeMs: 0 }
      group[snapshot.kind] = snapshot
      group.mtimeMs = Math.max(group.mtimeMs, snapshot.mtimeMs)
      groups.set(snapshot.token, group)
    }
    const candidates = [...groups.values()]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(group => group.next ?? group.previous)
      .filter((snapshot): snapshot is SnapshotCandidate => Boolean(snapshot))

    for (const snapshot of candidates) {
      let corruptDir: string | null = null
      try {
        if (activeReadError) {
          corruptDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'corrupt', randomUUID())
          try {
            await fs.rename(activeDir, corruptDir)
            await this.syncRenamedEntry(activeDir, corruptDir)
          } catch (err) {
            if (!isNotFoundError(err)) throw err
          }
        } else {
          await fs.rm(activeDir, { recursive: true, force: true })
        }
        await fs.rename(snapshot.dir, activeDir)
        await this.syncRenamedEntry(snapshot.dir, activeDir)
        await this.removePagedChatSnapshotSiblings(agentRef, chatId)
        if (corruptDir) {
          await fs.rm(corruptDir, { recursive: true, force: true }).catch(() => undefined)
        }
        this.cleanedSnapshotSiblingKeys.add(cleanupKey)
        return await this.readPagedMeta(agentRef, chatId)
      } catch (err) {
        if (corruptDir) {
          try {
            await fs.rename(corruptDir, activeDir)
            await this.syncRenamedEntry(corruptDir, activeDir)
          } catch {
            // Try the next complete snapshot, if one exists.
          }
        }
        // Try the next complete snapshot, if one exists.
      }
    }

    if (await this.rebuildPagedChatFromSurvivingFilesUnlocked(agentRef, chatId)) {
      this.cleanedSnapshotSiblingKeys.add(cleanupKey)
      return await this.readPagedMeta(agentRef, chatId)
    }
    if (activeReadError) {
      const corruptDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'corrupt', randomUUID())
      await fs.mkdir(this.chatSnapshotRootPath(agentRef, chatId), {
        recursive: true,
        mode: 0o700,
      })
      try {
        await fs.rename(activeDir, corruptDir)
        await this.syncRenamedEntry(activeDir, corruptDir)
      } catch (err) {
        if (!isNotFoundError(err)) throw err
      }
      console.warn(`[chatStore] Quarantined unreadable paged cache for "${chatId}"`)
      return null
    }
    return null
  }

  private async removePagedChatSnapshotSiblings(agentRef: string, chatId: string): Promise<void> {
    await fs.rm(this.chatSnapshotRootPath(agentRef, chatId), {
      recursive: true,
      force: true,
    })
  }

  private async isCompletePagedSnapshot(
    chatDir: string,
    chatId: string,
    meta: PagedChatMeta
  ): Promise<boolean> {
    const pagesDir = this.chatPagesDirFromChatDir(chatDir)
    for (const page of meta.pages) {
      try {
        const messages = await this.readPageMessagesAtPath(
          chatId,
          pageNumberFromFileName(page.file),
          this.chatPagePathFromPagesDir(pagesDir, page.file)
        )
        if (messages.length !== page.count) return false
      } catch {
        return false
      }
    }
    return true
  }

  private async writePagedChatUnlocked(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[],
    options: { messageCount?: number } = {}
  ): Promise<PagedChatMeta> {
    const chatDir = this.chatDirPath(agentRef, chatId)
    const snapshotToken = randomUUID()
    const stagingDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'next', snapshotToken)
    const backupDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'previous', snapshotToken)
    const pagesDir = this.chatPagesDirFromChatDir(stagingDir)
    let movedExistingSnapshot = false
    let primaryCommitted = false

    this.cleanedSnapshotSiblingKeys.delete(this.chatSnapshotCleanupKey(agentRef, chatId))
    await fs.mkdir(join(this.agentDir(agentRef), 'chats'), { recursive: true, mode: 0o700 })
    await fs.rm(stagingDir, { recursive: true, force: true })
    await fs.mkdir(pagesDir, { recursive: true, mode: 0o700 })

    try {
      const pages: ChatPageEntry[] = []
      for (
        let start = 0, pageNumber = 1;
        start < messages.length;
        start += this.pageSize, pageNumber += 1
      ) {
        pages.push(
          await this.writePageMessagesToDir(
            chatId,
            pagesDir,
            pageNumber,
            messages.slice(start, start + this.pageSize)
          )
        )
      }

      const pruned = await this.pruneSyncedPages(
        this.finalizePagedMeta({
          version: PAGED_CHAT_VERSION,
          chatId,
          pageSize: this.pageSize,
          messageCount: Math.max(messages.length, options.messageCount ?? 0),
          localMessageCount: messages.length,
          pages,
        })
      )
      const compatibility = this.legacyCompatibilitySnapshot(chatId, messages)
      pruned.meta.legacyCompatibilitySignature = compatibility.signature
      await this.writePagedMetaToDir(chatId, stagingDir, pruned.meta)
      await Promise.all(
        pruned.removedFiles.map(file =>
          fs.rm(this.chatPagePathFromPagesDir(pagesDir, file), { force: true })
        )
      )

      try {
        await fs.rename(chatDir, backupDir)
        movedExistingSnapshot = true
        await this.syncRenamedEntry(chatDir, backupDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }

      await fs.rename(stagingDir, chatDir)
      primaryCommitted = true
      await this.syncRenamedEntry(stagingDir, chatDir)
      const cacheKey = this.chatSnapshotCleanupKey(agentRef, chatId)
      try {
        await this.writeLegacyCompatibilitySnapshot(agentRef, chatId, messages)
        this.compatibilityCheckedKeys.add(cacheKey)
      } catch (error) {
        // The paged snapshot is the durable source of truth and has already
        // committed. Keep the successful write visible to the caller; a later
        // read repairs the auxiliary downgrade window from the paged data.
        this.compatibilityCheckedKeys.delete(cacheKey)
        console.warn(
          `[chatStore] Failed to refresh downgrade snapshot for ${chatId}; retrying on read`,
          error
        )
      }
      if (movedExistingSnapshot) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      }
      this.cleanedSnapshotSiblingKeys.add(cacheKey)

      return pruned.meta
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      if (movedExistingSnapshot && !primaryCommitted) {
        await fs
          .rename(backupDir, chatDir)
          .then(() => this.syncRenamedEntry(backupDir, chatDir))
          .catch(() => undefined)
      }
      throw err
    }
  }

  private async readOrMigratePagedChatUnlocked(
    agentRef: string,
    chatId: string
  ): Promise<PagedChatMeta | null> {
    const paged = await this.recoverPagedChatUnlocked(agentRef, chatId)
    if (paged) {
      if (this.compatibilityCheckedKeys.has(this.chatSnapshotCleanupKey(agentRef, chatId))) {
        return paged
      }
      return this.importDowngradedLocalMessagesUnlocked(agentRef, chatId, paged)
    }

    const legacyMessages = await this.readLegacyMessages(agentRef, chatId)
    if (!legacyMessages) return null

    const migrated = await this.writePagedChatUnlocked(agentRef, chatId, legacyMessages)
    await this.updateChatIndexFromMessages(agentRef, chatId, legacyMessages, {
      touchUpdatedAt: false,
    })
    return migrated
  }

  private async readMessagesFromPagedMeta(
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta,
    limit?: number,
    offset?: number
  ): Promise<ChatMessage[]> {
    const localCount = meta.pages.reduce((total, page) => total + page.count, 0)
    if (localCount === 0) return []

    const effectiveOffset = Math.max(0, Math.floor(offset ?? 0))
    const end = Math.max(0, localCount - effectiveOffset)
    if (end === 0) return []

    const effectiveLimit = limit === undefined ? end : Math.max(0, Math.floor(limit))
    if (effectiveLimit === 0) return []

    const start = Math.max(0, end - effectiveLimit)
    const result: ChatMessage[] = []
    let cursor = 0

    for (const page of meta.pages) {
      const pageStart = cursor
      const pageEnd = cursor + page.count
      cursor = pageEnd

      const overlapStart = Math.max(start, pageStart)
      const overlapEnd = Math.min(end, pageEnd)
      if (overlapStart >= overlapEnd) continue

      const pageMessages = await this.readPageMessages(agentRef, chatId, page)
      result.push(...pageMessages.slice(overlapStart - pageStart, overlapEnd - pageStart))
    }

    return result
  }

  private async appendPagedMessagesUnlocked(
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta,
    newMessages: ChatMessage[]
  ): Promise<PagedChatMeta> {
    if (!newMessages.length) return meta

    const cacheKey = this.chatSnapshotCleanupKey(agentRef, chatId)
    this.cleanedSnapshotSiblingKeys.delete(cacheKey)
    const pages = [...meta.pages]
    let remaining = [...newMessages]

    const lastPage = pages.at(-1)
    if (lastPage && lastPage.count < this.pageSize) {
      const currentMessages = await this.readPageMessages(agentRef, chatId, lastPage)
      const capacity = Math.max(0, this.pageSize - currentMessages.length)
      if (capacity > 0) {
        const added = remaining.slice(0, capacity)
        remaining = remaining.slice(added.length)
        pages[pages.length - 1] = await this.writePageMessages(
          agentRef,
          chatId,
          pageNumberFromFileName(lastPage.file),
          [...currentMessages, ...added]
        )
      }
    }

    let nextPageNumber = pageNumberFromFileName(pages.at(-1)?.file ?? '') + 1
    while (remaining.length) {
      const pageMessages = remaining.slice(0, this.pageSize)
      remaining = remaining.slice(pageMessages.length)
      pages.push(await this.writePageMessages(agentRef, chatId, nextPageNumber, pageMessages))
      nextPageNumber += 1
    }

    const messageCount =
      Math.max(meta.messageCount, meta.localMessageCount ?? 0) + newMessages.length
    const pruned = await this.pruneSyncedPages({
      ...meta,
      messageCount,
      pages,
    })
    const cachedCompatibilityMessages = this.compatibilityWindows.get(cacheKey)
    const compatibilityMessages = cachedCompatibilityMessages
      ? [...cachedCompatibilityMessages, ...newMessages].slice(-LEGACY_COMPATIBILITY_MESSAGE_LIMIT)
      : await this.readMessagesFromPagedMeta(
          agentRef,
          chatId,
          pruned.meta,
          LEGACY_COMPATIBILITY_MESSAGE_LIMIT
        )
    const compatibility = this.legacyCompatibilitySnapshot(chatId, compatibilityMessages)
    pruned.meta.legacyCompatibilitySignature = compatibility.signature
    await this.writePagedMeta(agentRef, chatId, pruned.meta)
    await Promise.all(
      pruned.removedFiles.map(file =>
        fs.rm(this.chatPagePath(agentRef, chatId, file), { force: true })
      )
    )
    let compatibilityCurrent = compatibility.signature === meta.legacyCompatibilitySignature
    if (!compatibilityCurrent) {
      try {
        await this.writeLegacyCompatibilitySnapshot(agentRef, chatId, compatibilityMessages)
        compatibilityCurrent = true
      } catch (error) {
        // The page and metadata writes above are already durable. Do not turn an
        // auxiliary downgrade-window failure into a false append failure.
        console.warn(
          `[chatStore] Failed to refresh downgrade snapshot for ${chatId}; retrying on read`,
          error
        )
      }
    }
    this.cleanedSnapshotSiblingKeys.add(cacheKey)
    if (compatibilityCurrent) {
      this.compatibilityCheckedKeys.add(cacheKey)
    } else {
      this.compatibilityCheckedKeys.delete(cacheKey)
    }
    return pruned.meta
  }

  async getIndex(agentRef: string): Promise<ChatIndex> {
    let raw: string
    try {
      raw = await fs.readFile(this.indexPath(agentRef), 'utf-8')
    } catch (error) {
      if (isNotFoundError(error)) return emptyIndex()
      throw error
    }
    try {
      return parseChatIndex(raw)
    } catch (error) {
      // Preserve unreadable catalog bytes for bounded recovery/diagnostics, but
      // detach them from the writable path so a torn index cannot brick every
      // chat mutation. Paged transcripts live under chats/ and remain untouched;
      // the catalog can be repopulated by the server as normal writes resume.
      const source = this.indexPath(agentRef)
      const target = this.corruptIndexPath(agentRef)
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
      try {
        await fs.rename(source, target)
        await this.syncRenamedEntry(source, target)
        console.warn(`[chatStore] Quarantined unreadable chat index for "${agentRef}"`)
      } catch (renameError) {
        if (!isNotFoundError(renameError)) {
          throw new Error(`Unable to quarantine chat index for ${agentRef}`, {
            cause: renameError,
          })
        }
      }
      return emptyIndex()
    }
  }

  private async saveIndex(agentRef: string, index: ChatIndex): Promise<void> {
    if (index.version !== INDEX_VERSION) {
      throw new Error(`Refusing to overwrite unsupported chat index version ${index.version}`)
    }
    const dir = this.agentDir(agentRef)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    // Keep the index readable by the pre-paging desktop while the transcript
    // files are maintained in both paged and bounded v2-compatible forms.
    const normalized: ChatIndex = { ...index, version: INDEX_VERSION }
    // Flush the temp file before rename and the containing directory afterward.
    // Visibility atomicity alone does not make the catalog durable across power loss.
    const target = this.indexPath(agentRef)
    await this.writeJsonAtomic(target, normalized, 2)
  }

  async listChats(agentRef: string): Promise<ChatMetadata[]> {
    const index = await this.getIndex(agentRef)
    return index.chats
  }

  async getLastActiveChatId(agentRef: string): Promise<string | null> {
    const index = await this.getIndex(agentRef)
    return index.lastActiveChatId
  }

  async setLastActiveChatId(agentRef: string, chatId: string): Promise<void> {
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      index.lastActiveChatId = chatId
      await this.saveIndex(agentRef, index)
    })
  }

  async setOnboardingDismissed(agentRef: string, dismissed: boolean): Promise<void> {
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      index.onboardingDismissed = dismissed
      await this.saveIndex(agentRef, index)
    })
  }

  async createChat(agentRef: string, chatId: string): Promise<ChatMetadata> {
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const existing = index.chats.find(c => c.id === chatId)
      if (existing) return existing

      const now = new Date().toISOString()
      const meta: ChatMetadata = {
        id: chatId,
        title: 'New Chat',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      }
      index.chats.push(meta)
      await this.saveIndex(agentRef, index)
      return meta
    })
  }

  async renameChat(agentRef: string, chatId: string, title: string): Promise<void> {
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(c => c.id === chatId)
      if (!chat) return
      chat.title = title
      chat.updatedAt = new Date().toISOString()
      await this.saveIndex(agentRef, index)
    })
  }

  async deleteChat(agentRef: string, chatId: string): Promise<void> {
    return this.serializeChat(agentRef, chatId, async () => {
      await this.serializeIndex(agentRef, async () => {
        const index = await this.getIndex(agentRef)
        index.chats = index.chats.filter(c => c.id !== chatId)
        if (index.lastActiveChatId === chatId) {
          index.lastActiveChatId = null
        }
        await this.saveIndex(agentRef, index)
      })
      await fs.rm(this.chatFilePath(agentRef, chatId), { force: true })
      const corruptLegacyDir = join(this.agentDir(agentRef), '.corrupt')
      await fs.rm(join(corruptLegacyDir, encodedChatId(chatId)), { recursive: true, force: true })
      const corruptLegacyEntries = await fs.readdir(corruptLegacyDir).catch(() => [])
      await Promise.all(
        corruptLegacyEntries
          .filter(name => legacyCorruptFileBelongsToChat(name, chatId))
          .map(name => fs.rm(join(corruptLegacyDir, name), { force: true }))
      )
      await fs.rm(`${this.chatFilePath(agentRef, chatId)}.tmp`, { force: true })
      await fs.rm(this.chatCompatibilitySignaturePath(agentRef, chatId), { force: true })
      await fs.rm(`${this.chatCompatibilitySignaturePath(agentRef, chatId)}.tmp`, { force: true })
      await fs.rm(this.chatDirPath(agentRef, chatId), { recursive: true, force: true })
      await this.removePagedChatSnapshotSiblings(agentRef, chatId)
      const cacheKey = this.chatSnapshotCleanupKey(agentRef, chatId)
      this.cleanedSnapshotSiblingKeys.delete(cacheKey)
      this.compatibilityCheckedKeys.delete(cacheKey)
      this.dropCompatibilityWindow(cacheKey)
    })
  }

  async loadMessages(
    agentRef: string,
    chatId: string,
    limit?: number,
    offset?: number
  ): Promise<ChatMessage[]> {
    try {
      return await this.serializeChat(agentRef, chatId, async () => {
        const meta = await this.readOrMigratePagedChatUnlocked(agentRef, chatId)
        if (!meta) return []
        return this.readMessagesFromPagedMeta(agentRef, chatId, meta, limit, offset)
      })
    } catch (err) {
      if (isUnsafeSegmentError(err)) return []
      throw err
    }
  }

  private async updateChatIndexFromMessages(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[],
    options: { preserveExistingTotals?: boolean; touchUpdatedAt?: boolean } = {}
  ): Promise<void> {
    await this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(c => c.id === chatId)
      if (!chat) return

      const aggregate = aggregateMessages(messages)
      const displayMessageCount = visibleMessageCount(messages)
      if (options.preserveExistingTotals) {
        chat.messageCount = Math.max(chat.messageCount ?? 0, displayMessageCount)
        chat.errorCount = Math.max(chat.errorCount ?? 0, aggregate.errorCount ?? 0)
        chat.toolCallCount = Math.max(chat.toolCallCount ?? 0, aggregate.toolCallCount ?? 0)
      } else {
        chat.messageCount = displayMessageCount
        Object.assign(chat, aggregate)
      }
      if (options.touchUpdatedAt !== false) {
        chat.updatedAt = new Date().toISOString()
      }
      await this.saveIndex(agentRef, index)
    })
  }

  private async indexedMessageCount(agentRef: string, chatId: string): Promise<number | undefined> {
    try {
      const index = await this.getIndex(agentRef)
      return index.chats.find(chat => chat.id === chatId)?.messageCount
    } catch {
      return undefined
    }
  }

  private async saveMessagesInternal(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[],
    options: { preserveExistingTotals?: boolean } = {}
  ): Promise<void> {
    return this.serializeChat(agentRef, chatId, async () => {
      const indexedCount = options.preserveExistingTotals
        ? await this.indexedMessageCount(agentRef, chatId)
        : undefined
      await this.writePagedChatUnlocked(agentRef, chatId, messages, {
        messageCount: Math.max(messages.length, indexedCount ?? 0),
      })

      await this.updateChatIndexFromMessages(agentRef, chatId, messages, {
        preserveExistingTotals: options.preserveExistingTotals,
      })
    })
  }

  async saveMessages(agentRef: string, chatId: string, messages: ChatMessage[]): Promise<void> {
    return this.saveMessagesInternal(agentRef, chatId, messages)
  }

  /**
   * Upsert a server reconciliation window without truncating unseen history.
   *
   * Reconciliation is intentionally bounded, while the local store may contain
   * older pages or optimistic messages that are not present in that window.
   * Merge the window into the complete local snapshot before publishing a new
   * generation so a background reconcile cannot discard either category.
   */
  async replaceMessages(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[],
    options: ReplaceChatMessagesOptions = {}
  ): Promise<void> {
    await this.serializeChat(agentRef, chatId, async () => {
      const existingMeta = await this.readOrMigratePagedChatUnlocked(agentRef, chatId)
      const existingMessages = existingMeta
        ? await this.readMessagesFromPagedMeta(agentRef, chatId, existingMeta)
        : []
      const replaceLegacyTurnlessWindow =
        existingMessages.length > 0 &&
        !options.activeTaskIds?.length &&
        existingMessages.every(message => messageServerTurnNumber(message) === undefined) &&
        messages.some(message => messageServerTurnNumber(message) !== undefined)
      const merged = mergeAuthoritativeServerMessages(existingMessages, messages, {
        activeTaskIds: options.activeTaskIds ? new Set(options.activeTaskIds) : undefined,
        replaceLegacyTurnlessWindow,
      })
      const indexedCount = await this.indexedMessageCount(agentRef, chatId)
      await this.writePagedChatUnlocked(agentRef, chatId, merged, {
        messageCount: Math.max(merged.length, indexedCount ?? 0),
      })
      await this.updateChatIndexFromMessages(agentRef, chatId, merged, {
        preserveExistingTotals: true,
      })
    })
  }

  async backfillChatCounters(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[]
  ): Promise<void> {
    await this.updateChatIndexFromMessages(agentRef, chatId, messages, {
      preserveExistingTotals: true,
      touchUpdatedAt: false,
    })
  }

  async appendMessages(
    agentRef: string,
    chatId: string,
    newMessages: ChatMessage[]
  ): Promise<void> {
    return this.serializeChat(agentRef, chatId, async () => {
      const existing =
        (await this.readOrMigratePagedChatUnlocked(agentRef, chatId)) ??
        (await this.writePagedChatUnlocked(agentRef, chatId, []))
      const meta = await this.appendPagedMessagesUnlocked(agentRef, chatId, existing, newMessages)

      await this.serializeIndex(agentRef, async () => {
        const index = await this.getIndex(agentRef)
        const chat = index.chats.find(c => c.id === chatId)
        if (chat) {
          const delta = aggregateMessages(newMessages)
          chat.messageCount = (chat.messageCount ?? 0) + visibleMessageCount(newMessages)
          chat.errorCount = (chat.errorCount ?? 0) + (delta.errorCount ?? 0)
          chat.toolCallCount = (chat.toolCallCount ?? 0) + (delta.toolCallCount ?? 0)
          chat.updatedAt = new Date().toISOString()
          await this.saveIndex(agentRef, index)
        }
      })
    })
  }

  /**
   * Flag that a task terminated while the chat was not the active view (D.5).
   * Idempotent: a no-op when already flagged, so a noisy task can't spam FS writes.
   */
  async markUnreadTerminal(agentRef: string, chatId: string): Promise<void> {
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(c => c.id === chatId)
      if (!chat || chat.unreadTerminal === true) return
      chat.unreadTerminal = true
      chat.lastTerminalAt = new Date().toISOString()
      await this.saveIndex(agentRef, index)
    })
  }

  /**
   * Reconcile the local index against the server's session listing (spec §5.3).
   * The mcp-host is the source of truth; this refreshes `updatedAt` for chats
   * ALREADY tracked locally so the persisted sidebar order/freshness survives a
   * cold start without a server round-trip.
   *
   * Deliberately does NOT create entries for server-only sessions: the sidebar's
   * in-memory merge (`useChatListController`) already surfaces those, and a local
   * `deleteChat` doesn't remove the server session — eagerly re-persisting it
   * would resurrect a chat the user just deleted. Titles are never touched (the
   * server has none; the client derives them on open). Returns the count of
   * entries reconciled.
   */
  async upsertServerSessions(
    agentRef: string,
    sessions: Array<{ chatId: string; lastActivityAt?: string }>
  ): Promise<number> {
    if (!sessions.length) return 0
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const byId = new Map(index.chats.map(chat => [chat.id, chat]))
      let changed = 0
      for (const session of sessions) {
        const chat = byId.get(session.chatId)
        if (!chat) continue // server-only session — do not resurrect a local delete
        const lastActivityAt = session.lastActivityAt
        if (!lastActivityAt) continue
        if (new Date(lastActivityAt).getTime() > new Date(chat.updatedAt).getTime()) {
          chat.updatedAt = lastActivityAt
          changed += 1
        }
      }
      if (changed > 0) await this.saveIndex(agentRef, index)
      return changed
    })
  }

  /** Clear the unread-terminal flag (D.5), e.g. when the user opens the chat. */
  async clearUnreadTerminal(agentRef: string, chatId: string): Promise<void> {
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(c => c.id === chatId)
      if (!chat || !chat.unreadTerminal) return
      chat.unreadTerminal = false
      await this.saveIndex(agentRef, index)
    })
  }
}
