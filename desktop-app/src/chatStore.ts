import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ChatFile, ChatIndex, ChatMessage, ChatMetadata } from './types.js'

const INDEX_VERSION = 2

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
  constructor(private readonly baseDir: string) {}

  /**
   * Per-agent serialization of index read-modify-write sequences. The index is
   * a single shared `index.json`, so concurrent mutators (e.g. two chats of one
   * agent terminating at once — a first-class case post-D.4 fire-and-forget)
   * could interleave getIndex→saveIndex and drop one update (e.g. an
   * `unreadTerminal` flag). Chaining per agentRef makes each RMW atomic w.r.t.
   * the others. Reads (getIndex/loadMessages) are not serialized.
   */
  private indexChains = new Map<string, Promise<unknown>>()

  private serializeIndex<T>(agentRef: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.indexChains.get(agentRef) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    // Keep the chain alive regardless of individual outcomes.
    this.indexChains.set(
      agentRef,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
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
    return this.serializeIndex(agentRef, async () => {
      const index = await this.getIndex(agentRef)
      index.chats = index.chats.filter(c => c.id !== chatId)
      if (index.lastActiveChatId === chatId) {
        index.lastActiveChatId = null
      }
      await this.saveIndex(agentRef, index)
      try {
        await fs.unlink(this.chatFilePath(agentRef, chatId))
      } catch {
        // file may not exist
      }
    })
  }

  async loadMessages(
    agentRef: string,
    chatId: string,
    limit?: number,
    offset?: number
  ): Promise<ChatMessage[]> {
    try {
      const raw = await fs.readFile(this.chatFilePath(agentRef, chatId), 'utf-8')
      const file = JSON.parse(raw) as ChatFile
      if (!file || !Array.isArray(file.messages)) return []

      const messages = file.messages
      if (limit === undefined && offset === undefined) return messages

      const effectiveOffset = offset ?? 0
      const start = Math.max(0, messages.length - effectiveOffset - (limit ?? messages.length))
      const end = messages.length - effectiveOffset
      return messages.slice(start, end)
    } catch {
      return []
    }
  }

  async saveMessages(agentRef: string, chatId: string, messages: ChatMessage[]): Promise<void> {
    return this.serializeIndex(agentRef, async () => {
      const dir = this.agentDir(agentRef)
      await fs.mkdir(dir, { recursive: true })
      const file: ChatFile = { version: 2, chatId, messages }
      await fs.writeFile(this.chatFilePath(agentRef, chatId), JSON.stringify(file), { mode: 0o600 })

      const index = await this.getIndex(agentRef)
      const chat = index.chats.find(c => c.id === chatId)
      if (chat) {
        chat.messageCount = messages.length
        chat.updatedAt = new Date().toISOString()
        await this.saveIndex(agentRef, index)
      }
    })
  }

  async appendMessages(
    agentRef: string,
    chatId: string,
    newMessages: ChatMessage[]
  ): Promise<void> {
    const existing = await this.loadMessages(agentRef, chatId)
    await this.saveMessages(agentRef, chatId, [...existing, ...newMessages])
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
