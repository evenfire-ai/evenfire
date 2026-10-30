import type { AgentChatMessage } from '../../uiTypes'

/**
 * #1091 A9 — the last transcripts the user saw, so reopening a chat renders it
 * at once instead of clearing to a spinner while the disk cache and the Host are
 * read again. The disk check and the Host reconcile still run afterwards; this
 * only removes the blank window.
 */
export interface TranscriptMemoEntry {
  messages: AgentChatMessage[]
  hasOlderMessages: boolean
  loadedLocalMessageCount: number
}

export interface TranscriptMemo {
  get: (key: string) => TranscriptMemoEntry | undefined
  set: (key: string, entry: TranscriptMemoEntry) => void
  delete: (key: string) => void
  deleteAgent: (agentRef: string) => void
  clear: () => void
}

export interface TranscriptMemoLimits {
  maxChats: number
  maxMessages: number
  maxAttachmentBase64Chars: number
}

/** Key layout: auth scope, agentRef and chatId, NUL-separated. */
export function transcriptMemoKey(authScope: string, agentRef: string, chatId: string): string {
  return `${authScope}\u0000${agentRef}\u0000${chatId}`
}

function attachmentBase64Chars(messages: AgentChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      total += attachment.dataBase64?.length ?? 0
    }
  }
  return total
}

export function createTranscriptMemo(limits: TranscriptMemoLimits): TranscriptMemo {
  // Map iteration order is insertion order, so the first key is the least
  // recently used one once `get` and `set` re-insert what they touch.
  const entries = new Map<string, TranscriptMemoEntry>()

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry
    },
    set(key, entry) {
      entries.delete(key)
      if (
        entry.messages.length === 0 ||
        entry.messages.length > limits.maxMessages ||
        attachmentBase64Chars(entry.messages) > limits.maxAttachmentBase64Chars
      ) {
        return
      }
      entries.set(key, entry)
      while (entries.size > limits.maxChats) {
        entries.delete(entries.keys().next().value!)
      }
    },
    delete(key) {
      entries.delete(key)
    },
    deleteAgent(agentRef) {
      for (const key of entries.keys()) {
        if (key.split('\u0000')[1] === agentRef) entries.delete(key)
      }
    },
    clear() {
      entries.clear()
    },
  }
}
