import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ChatFile, ChatIndex, ChatMessage, ChatMetadata } from './types.js'

const INDEX_VERSION = 3
const PAGED_CHAT_VERSION = 1
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_LOCAL_SYNCED_MESSAGES = 1000
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
  prunedThroughServerTurnNumber?: number
  oldestLocalServerTurnNumber?: number
  latestServerTurnNumber?: number
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

function serverTurnNumber(message: ChatMessage): number | undefined {
  return Number.isFinite(message.serverTurnNumber) ? message.serverTurnNumber : undefined
}

function isNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isRawFilesystemError(err: unknown): boolean {
  return typeof (err as NodeJS.ErrnoException | undefined)?.code === 'string'
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

function pageEntry(file: string, messages: ChatMessage[]): ChatPageEntry {
  const serverTurns = messages
    .map(serverTurnNumber)
    .filter((turn): turn is number => turn !== undefined)
  return {
    file,
    count: messages.length,
    serverSynced: messages.length > 0 && serverTurns.length === messages.length,
    firstServerTurnNumber: serverTurns.length ? Math.min(...serverTurns) : undefined,
    lastServerTurnNumber: serverTurns.length ? Math.max(...serverTurns) : undefined,
  }
}

/**
 * Reject any path-component (agentRef / chatId) that could escape the store
 * root via `path.join`. agentRefs are slugs and chatIds are UUIDs in practice,
 * so this only ever trips on malicious/garbage input — but `replaceMessages`
 * (wholesale overwrite) and `deleteChat` (unlink) make traversal high-impact,
 * so we guard centrally where the on-disk path is built.
 */
function assertSafeSegment(label: string, value: string): void {
  const collidesWithSnapshotNamespace =
    label === 'chatId' && /\.(?:next|previous|corrupt)-/.test(value)
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    /[/\\\0]/.test(value) ||
    collidesWithSnapshotNamespace
  ) {
    throw new Error(`Invalid ${label}: unsafe path segment`)
  }
}

function sameReconciledMessage(local: ChatMessage, server: ChatMessage): boolean {
  if (local.id === server.id) return true
  const localTurn = serverTurnNumber(local)
  const serverTurn = serverTurnNumber(server)
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

    const serverTurn = serverTurnNumber(serverMessage)
    const insertionIndex =
      serverTurn === undefined
        ? -1
        : merged.findIndex(message => {
            const messageTurn = serverTurnNumber(message)
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
    assertSafeSegment('agentRef', agentRef)
    return join(this.baseDir, agentRef)
  }

  private indexPath(agentRef: string): string {
    return join(this.agentDir(agentRef), 'index.json')
  }

  private chatFilePath(agentRef: string, chatId: string): string {
    assertSafeSegment('chatId', chatId)
    return join(this.agentDir(agentRef), `${chatId}.json`)
  }

  private chatDirPath(agentRef: string, chatId: string): string {
    assertSafeSegment('chatId', chatId)
    return join(this.agentDir(agentRef), 'chats', chatId)
  }

  private chatSnapshotSiblingPath(
    agentRef: string,
    chatId: string,
    kind: 'next' | 'previous' | 'corrupt',
    token: string
  ): string {
    assertSafeSegment('chatId', chatId)
    return join(this.agentDir(agentRef), 'chats', `${chatId}.${kind}-${token}`)
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

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(tmp, filePath)
  }

  private finalizePagedMeta(meta: PagedChatMeta): PagedChatMeta {
    const localMessageCount = meta.pages.reduce((total, page) => total + page.count, 0)
    const oldestLocalServerTurnNumber = meta.pages.find(
      page => page.firstServerTurnNumber !== undefined
    )?.firstServerTurnNumber
    const latestServerTurnNumber = [...meta.pages]
      .reverse()
      .find(page => page.lastServerTurnNumber !== undefined)?.lastServerTurnNumber

    return {
      ...meta,
      pageSize: this.pageSize,
      localMessageCount,
      oldestLocalServerTurnNumber,
      latestServerTurnNumber,
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
        !Array.isArray(parsed.pages)
      ) {
        throw new Error('Invalid paged chat metadata')
      }
      if (parsed.pages.some(page => !PAGE_FILE_PATTERN.test(page.file))) {
        throw new Error('Invalid paged chat metadata page reference')
      }
      return this.finalizePagedMeta({
        ...parsed,
        pageSize: normalizePositiveInteger(parsed.pageSize, this.pageSize),
        messageCount: Math.max(0, Math.floor(parsed.messageCount ?? 0)),
        localMessageCount: Math.max(0, Math.floor(parsed.localMessageCount ?? 0)),
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
      throw new Error(`Unable to read legacy chat file for ${chatId}`, { cause: err })
    }
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
    let raw: string
    try {
      raw = await fs.readFile(pagePath, 'utf-8')
    } catch (err) {
      throw err
    }

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
    let prunedThroughServerTurnNumber = meta.prunedThroughServerTurnNumber
    const retained: ChatPageEntry[] = []
    const removedFiles: string[] = []
    let pruning = true

    for (const page of meta.pages) {
      const canPrunePage =
        pruning && page.serverSynced && localCount - page.count >= this.maxLocalSyncedMessages

      if (canPrunePage) {
        removedFiles.push(page.file)
        localCount -= page.count
        prunedBeforeCount += page.count
        prunedThroughServerTurnNumber = page.lastServerTurnNumber ?? prunedThroughServerTurnNumber
        continue
      }

      pruning = false
      retained.push(page)
    }

    return {
      meta: this.finalizePagedMeta({
        ...meta,
        pages: retained,
        prunedBeforeCount: prunedBeforeCount > 0 ? prunedBeforeCount : undefined,
        prunedThroughServerTurnNumber,
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
      changed ||= repaired.count !== page.count
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

    for (const file of durableOrphans) {
      try {
        const messages = await this.readPageMessagesAtPath(
          chatId,
          pageNumberFromFileName(file),
          this.chatPagePathFromPagesDir(pagesDir, file)
        )
        if (!messages.length) continue
        repairedPages.push(pageEntry(file, messages))
        referenced.add(file)
        changed = true
      } catch (error) {
        if (isRawFilesystemError(error) && !isNotFoundError(error)) throw error
        // Leave an invalid orphan untouched. It is not referenced by metadata,
        // so it cannot break reads and may still be useful for manual recovery.
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
    return repaired
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
      removeLegacy: true,
      messageCount: recovered.length,
    })
    return true
  }

  private async recoverPagedChatUnlocked(agentRef: string, chatId: string): Promise<void> {
    const activeDir = this.chatDirPath(agentRef, chatId)
    const chatsDir = join(this.agentDir(agentRef), 'chats')
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
      const repaired = await this.adoptDurablePageWritesUnlocked(agentRef, chatId, activeMeta)
      if (repaired) {
        if (this.cleanedSnapshotSiblingKeys.has(cleanupKey)) return
        await this.removePagedChatSnapshotSiblings(chatsDir, chatId)
        this.cleanedSnapshotSiblingKeys.add(cleanupKey)
        return
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
      entries = await fs.readdir(chatsDir, { withFileTypes: true })
    } catch {
      return
    }

    const snapshots = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const nextPrefix = `${chatId}.next-`
          const previousPrefix = `${chatId}.previous-`
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
          const dir = join(chatsDir, entry.name)
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
          await fs.rename(activeDir, corruptDir).catch(err => {
            if (!isNotFoundError(err)) throw err
          })
        } else {
          await fs.rm(activeDir, { recursive: true, force: true })
        }
        await fs.rename(snapshot.dir, activeDir)
        await this.removePagedChatSnapshotSiblings(chatsDir, chatId)
        if (corruptDir) {
          await fs.rm(corruptDir, { recursive: true, force: true }).catch(() => undefined)
        }
        this.cleanedSnapshotSiblingKeys.add(cleanupKey)
        return
      } catch (err) {
        if (corruptDir) {
          await fs.rename(corruptDir, activeDir).catch(() => undefined)
        }
        // Try the next complete snapshot, if one exists.
      }
    }

    if (await this.rebuildPagedChatFromSurvivingFilesUnlocked(agentRef, chatId)) return
    if (activeReadError) throw activeReadError
  }

  private async removePagedChatSnapshotSiblings(chatsDir: string, chatId: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = await fs.readdir(chatsDir, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(
      entries
        .filter(
          entry =>
            entry.isDirectory() &&
            (entry.name.startsWith(`${chatId}.next-`) ||
              entry.name.startsWith(`${chatId}.previous-`))
        )
        .map(entry => fs.rm(join(chatsDir, entry.name), { recursive: true, force: true }))
    )
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
    options: { removeLegacy?: boolean; messageCount?: number } = {}
  ): Promise<PagedChatMeta> {
    const chatDir = this.chatDirPath(agentRef, chatId)
    const snapshotToken = randomUUID()
    const stagingDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'next', snapshotToken)
    const backupDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'previous', snapshotToken)
    const pagesDir = this.chatPagesDirFromChatDir(stagingDir)
    let movedExistingSnapshot = false

    this.cleanedSnapshotSiblingKeys.delete(this.chatSnapshotCleanupKey(agentRef, chatId))
    await fs.mkdir(join(this.agentDir(agentRef), 'chats'), { recursive: true })
    await fs.rm(stagingDir, { recursive: true, force: true })
    await fs.mkdir(pagesDir, { recursive: true })

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
      await this.writePagedMetaToDir(chatId, stagingDir, pruned.meta)
      await Promise.all(
        pruned.removedFiles.map(file =>
          fs.rm(this.chatPagePathFromPagesDir(pagesDir, file), { force: true })
        )
      )

      try {
        await fs.rename(chatDir, backupDir)
        movedExistingSnapshot = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }

      await fs.rename(stagingDir, chatDir)
      if (movedExistingSnapshot) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      }

      if (options.removeLegacy) {
        await fs.rm(this.chatFilePath(agentRef, chatId), { force: true })
      }

      return pruned.meta
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      if (movedExistingSnapshot) {
        await fs.rename(backupDir, chatDir).catch(() => undefined)
      }
      throw err
    }
  }

  private async readOrMigratePagedChatUnlocked(
    agentRef: string,
    chatId: string
  ): Promise<PagedChatMeta | null> {
    await this.recoverPagedChatUnlocked(agentRef, chatId)
    const paged = await this.readPagedMeta(agentRef, chatId)
    if (paged) return paged

    const legacyMessages = await this.readLegacyMessages(agentRef, chatId)
    if (!legacyMessages) return null

    const migrated = await this.writePagedChatUnlocked(agentRef, chatId, legacyMessages, {
      removeLegacy: true,
    })
    await this.updateChatIndexFromMessages(agentRef, chatId, legacyMessages)
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
    await this.writePagedMeta(agentRef, chatId, pruned.meta)
    await Promise.all(
      pruned.removedFiles.map(file =>
        fs.rm(this.chatPagePath(agentRef, chatId, file), { force: true })
      )
    )
    await fs.rm(this.chatFilePath(agentRef, chatId), { force: true })
    return pruned.meta
  }

  async getIndex(agentRef: string): Promise<ChatIndex> {
    try {
      const raw = await fs.readFile(this.indexPath(agentRef), 'utf-8')
      const parsed = JSON.parse(raw) as ChatIndex
      // Version-agnostic read: legacy directories are handled at bind time by
      // chatStoreBinding, so any index we read here is safe to normalize;
      // saveIndex writes the current v3 marker on the next update.
      if (parsed && Array.isArray(parsed.chats)) {
        return parsed
      }
      return emptyIndex()
    } catch {
      return emptyIndex()
    }
  }

  private async saveIndex(agentRef: string, index: ChatIndex): Promise<void> {
    const dir = this.agentDir(agentRef)
    await fs.mkdir(dir, { recursive: true })
    // Always persist at the current schema version so a read-back never looks legacy.
    const normalized: ChatIndex = { ...index, version: INDEX_VERSION }
    // Atomic write (temp + rename): a crash mid-write must never leave a
    // truncated index.json, because the bootstrap wipe treats an unparseable
    // index as legacy and would delete live v3 chats.
    const target = this.indexPath(agentRef)
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600 })
    await fs.rename(tmp, target)
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
      await fs.rm(this.chatDirPath(agentRef, chatId), { recursive: true, force: true })
      await this.removePagedChatSnapshotSiblings(join(this.agentDir(agentRef), 'chats'), chatId)
      this.cleanedSnapshotSiblingKeys.delete(this.chatSnapshotCleanupKey(agentRef, chatId))
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
    options: { preserveExistingTotals?: boolean } = {}
  ): Promise<void> {
    await this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(c => c.id === chatId)
      if (!chat) return

      const aggregate = aggregateMessages(messages)
      if (options.preserveExistingTotals) {
        chat.messageCount = Math.max(chat.messageCount ?? 0, messages.length)
        chat.errorCount = Math.max(chat.errorCount ?? 0, aggregate.errorCount ?? 0)
        chat.toolCallCount = Math.max(chat.toolCallCount ?? 0, aggregate.toolCallCount ?? 0)
      } else {
        chat.messageCount = messages.length
        Object.assign(chat, aggregate)
      }
      chat.updatedAt = new Date().toISOString()
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
        removeLegacy: true,
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
  async replaceMessages(agentRef: string, chatId: string, messages: ChatMessage[]): Promise<void> {
    await this.serializeChat(agentRef, chatId, async () => {
      const existingMeta = await this.readOrMigratePagedChatUnlocked(agentRef, chatId)
      const existingMessages = existingMeta
        ? await this.readMessagesFromPagedMeta(agentRef, chatId, existingMeta)
        : []
      const merged = mergeReconciledMessages(existingMessages, messages)
      const indexedCount = await this.indexedMessageCount(agentRef, chatId)
      await this.writePagedChatUnlocked(agentRef, chatId, merged, {
        removeLegacy: true,
        messageCount: Math.max(merged.length, indexedCount ?? 0),
      })
      await this.updateChatIndexFromMessages(agentRef, chatId, merged, {
        preserveExistingTotals: true,
      })
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
        (await this.writePagedChatUnlocked(agentRef, chatId, [], { removeLegacy: true }))
      const meta = await this.appendPagedMessagesUnlocked(agentRef, chatId, existing, newMessages)

      await this.serializeIndex(agentRef, async () => {
        const index = await this.getIndex(agentRef)
        const chat = index.chats.find(c => c.id === chatId)
        if (chat) {
          const delta = aggregateMessages(newMessages)
          chat.messageCount = meta.messageCount
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
