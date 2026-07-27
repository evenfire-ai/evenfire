import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ChatFile, ChatIndex, ChatMessage, ChatMetadata } from './types.js'

const INDEX_VERSION = 2
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
  if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid ${label}: unsafe path segment`)
  }
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
    kind: 'next' | 'previous',
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
    try {
      const raw = await fs.readFile(metaPath, 'utf-8')
      const parsed = JSON.parse(raw) as PagedChatMeta
      if (
        parsed?.version !== PAGED_CHAT_VERSION ||
        parsed.chatId !== chatId ||
        !Array.isArray(parsed.pages)
      ) {
        return null
      }
      if (parsed.pages.some(page => !PAGE_FILE_PATTERN.test(page.file))) return null
      return this.finalizePagedMeta({
        ...parsed,
        pageSize: normalizePositiveInteger(parsed.pageSize, this.pageSize),
        messageCount: Math.max(0, Math.floor(parsed.messageCount ?? 0)),
        localMessageCount: Math.max(0, Math.floor(parsed.localMessageCount ?? 0)),
      })
    } catch {
      return null
    }
  }

  private async readLegacyMessages(
    agentRef: string,
    chatId: string
  ): Promise<ChatMessage[] | null> {
    try {
      const raw = await fs.readFile(this.chatFilePath(agentRef, chatId), 'utf-8')
      const file = JSON.parse(raw) as ChatFile
      if (!file || !Array.isArray(file.messages)) return null
      return file.messages
    } catch {
      return null
    }
  }

  private async readPageMessages(
    agentRef: string,
    chatId: string,
    page: ChatPageEntry
  ): Promise<ChatMessage[]> {
    try {
      const raw = await fs.readFile(this.chatPagePath(agentRef, chatId, page.file), 'utf-8')
      const parsed = JSON.parse(raw) as ChatPageFile
      if (
        parsed?.version !== PAGED_CHAT_VERSION ||
        parsed.chatId !== chatId ||
        !Array.isArray(parsed.messages)
      ) {
        return []
      }
      return parsed.messages
    } catch {
      return []
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
    agentRef: string,
    chatId: string,
    meta: PagedChatMeta,
    options: { pagesDir?: string } = {}
  ): Promise<PagedChatMeta> {
    if (this.maxLocalSyncedMessages === Number.POSITIVE_INFINITY) {
      return this.finalizePagedMeta(meta)
    }

    let localCount = meta.pages.reduce((total, page) => total + page.count, 0)
    let prunedBeforeCount = meta.prunedBeforeCount ?? 0
    let prunedThroughServerTurnNumber = meta.prunedThroughServerTurnNumber
    const retained: ChatPageEntry[] = []
    let pruning = true

    for (const page of meta.pages) {
      const canPrunePage =
        pruning && page.serverSynced && localCount - page.count >= this.maxLocalSyncedMessages

      if (canPrunePage) {
        const pagesDir = options.pagesDir ?? this.chatPagesDirPath(agentRef, chatId)
        await fs.rm(this.chatPagePathFromPagesDir(pagesDir, page.file), { force: true })
        localCount -= page.count
        prunedBeforeCount += page.count
        prunedThroughServerTurnNumber = page.lastServerTurnNumber ?? prunedThroughServerTurnNumber
        continue
      }

      pruning = false
      retained.push(page)
    }

    return this.finalizePagedMeta({
      ...meta,
      pages: retained,
      prunedBeforeCount: prunedBeforeCount > 0 ? prunedBeforeCount : undefined,
      prunedThroughServerTurnNumber,
    })
  }

  private async recoverPagedChatUnlocked(agentRef: string, chatId: string): Promise<void> {
    const activeDir = this.chatDirPath(agentRef, chatId)
    const chatsDir = join(this.agentDir(agentRef), 'chats')
    const activeMeta = await this.readPagedMeta(agentRef, chatId)

    if (activeMeta) {
      await this.removePagedChatSnapshotSiblings(chatsDir, chatId)
      return
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
          const kind = entry.name.startsWith(`${chatId}.next-`)
            ? 'next'
            : entry.name.startsWith(`${chatId}.previous-`)
              ? 'previous'
              : null
          if (!kind) return null
          const dir = join(chatsDir, entry.name)
          const meta = await this.readPagedMetaAtPath(this.chatMetaPathFromChatDir(dir), chatId)
          if (!meta) return null
          const stat = await fs.stat(dir).catch(() => null)
          return {
            dir,
            kind,
            mtimeMs: stat?.mtimeMs ?? 0,
          }
        })
    )
    const validSnapshots = snapshots
      .filter(
        (snapshot): snapshot is { dir: string; kind: 'next' | 'previous'; mtimeMs: number } =>
          snapshot !== null
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    const candidates = [
      ...validSnapshots.filter(snapshot => snapshot.kind === 'next'),
      ...validSnapshots.filter(snapshot => snapshot.kind === 'previous'),
    ]

    for (const snapshot of candidates) {
      try {
        await fs.rm(activeDir, { recursive: true, force: true })
        await fs.rename(snapshot.dir, activeDir)
        await this.removePagedChatSnapshotSiblings(chatsDir, chatId)
        return
      } catch {
        // Try the next complete snapshot, if one exists.
      }
    }
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

  private async writePagedChatUnlocked(
    agentRef: string,
    chatId: string,
    messages: ChatMessage[],
    options: { removeLegacy?: boolean } = {}
  ): Promise<PagedChatMeta> {
    const chatDir = this.chatDirPath(agentRef, chatId)
    const snapshotToken = randomUUID()
    const stagingDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'next', snapshotToken)
    const backupDir = this.chatSnapshotSiblingPath(agentRef, chatId, 'previous', snapshotToken)
    const pagesDir = this.chatPagesDirFromChatDir(stagingDir)
    let movedExistingSnapshot = false

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

      const meta = await this.pruneSyncedPages(
        agentRef,
        chatId,
        this.finalizePagedMeta({
          version: PAGED_CHAT_VERSION,
          chatId,
          pageSize: this.pageSize,
          messageCount: messages.length,
          localMessageCount: messages.length,
          pages,
        }),
        { pagesDir }
      )
      await this.writePagedMetaToDir(chatId, stagingDir, meta)

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

      return meta
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

    return this.writePagedChatUnlocked(agentRef, chatId, legacyMessages, { removeLegacy: true })
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
    const pruned = await this.pruneSyncedPages(agentRef, chatId, {
      ...meta,
      messageCount,
      pages,
    })
    await this.writePagedMeta(agentRef, chatId, pruned)
    await fs.rm(this.chatFilePath(agentRef, chatId), { force: true })
    return pruned
  }

  async getIndex(agentRef: string): Promise<ChatIndex> {
    try {
      const raw = await fs.readFile(this.indexPath(agentRef), 'utf-8')
      const parsed = JSON.parse(raw) as ChatIndex
      // Version-agnostic read: legacy (v1) dirs are removed at bind time by the
      // bootstrap wipe (chatStoreBinding), so any index we read here is current;
      // saveIndex normalizes the stored version to v2 on the next write.
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
    // index as legacy and would delete live v2 chats.
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
    } catch {
      return []
    }
  }

  async saveMessages(agentRef: string, chatId: string, messages: ChatMessage[]): Promise<void> {
    return this.serializeChat(agentRef, chatId, async () => {
      await this.writePagedChatUnlocked(agentRef, chatId, messages, { removeLegacy: true })

      await this.serializeIndex(agentRef, async () => {
        const index = await this.getIndex(agentRef)
        const chat = index.chats.find(c => c.id === chatId)
        if (chat) {
          chat.messageCount = messages.length
          Object.assign(chat, aggregateMessages(messages))
          chat.updatedAt = new Date().toISOString()
          await this.saveIndex(agentRef, index)
        }
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
   * Overwrite a chat's entire history (D.4 reconcile: the server is the source
   * of truth, so on a diff the server's turns replace the local cache). Same
   * on-disk effect as `saveMessages`, named for the reconcile intent.
   */
  async replaceMessages(agentRef: string, chatId: string, messages: ChatMessage[]): Promise<void> {
    await this.saveMessages(agentRef, chatId, messages)
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
