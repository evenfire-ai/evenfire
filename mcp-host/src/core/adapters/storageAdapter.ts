import { Storage } from '../interfaces'
import { Conversation } from '../types'

/**
 * In-memory conversation storage.
 *
 * Conversations persist for the lifetime of the mcp-host process.
 * For production persistence, implement Storage backed by:
 * - K8s ConfigMap
 * - PVC file storage
 * - External database
 */
export class InMemoryStorage implements Storage {
  private conversations = new Map<string, Conversation>()
  private systemPrompt: string | null = null

  async loadConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.id, conversation)
  }

  async loadSystemPrompt(): Promise<string | null> {
    return this.systemPrompt
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
  }
}
