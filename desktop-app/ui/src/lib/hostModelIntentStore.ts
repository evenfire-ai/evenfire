/**
 * Unpersisted model-selection intents (R2 "Option A").
 *
 * When a user changes the model while the agent host is SUSPENDED (`replicas=0`)
 * the `POST /model` write cannot reach the runtime, so the choice cannot be
 * persisted server-side. Rather than silently drop it, the selection is held
 * here — keyed by `(agentRef, chatId)` like sessions — and PIGGYBACKED onto the
 * next send, which wakes the host and applies the model to that task.
 *
 * A PRE-CHAT pick (no chatId yet) is keyed by agent alone; the send path
 * migrates it into the chat-keyed slot once the first send creates the chat.
 *
 * This is a module-level singleton (not React state): it is written by the
 * shared `hostModelSelectionStore` and read by the composer/send path, two
 * consumers that never share a render tree. Keeping it out of React state avoids
 * a context/provider just to shuttle one imperative value between them.
 */

const pendingModelByChat: Record<string, string> = {}
const preChatModelByAgent: Record<string, string> = {}

/** Composite key mirroring the session `chatKey` convention (`agentRef::chatId`). */
export function pendingModelKey(agentRef: string, chatId: string): string {
  return `${agentRef}::${chatId}`
}

export function setPendingModelIntent(agentRef: string, chatId: string, model: string): void {
  if (!agentRef || !chatId || !model) return
  pendingModelByChat[pendingModelKey(agentRef, chatId)] = model
}

export function getPendingModelIntent(agentRef: string, chatId: string): string | undefined {
  if (!agentRef || !chatId) return undefined
  return pendingModelByChat[pendingModelKey(agentRef, chatId)]
}

export function clearPendingModelIntent(agentRef: string, chatId: string): void {
  if (!agentRef || !chatId) return
  delete pendingModelByChat[pendingModelKey(agentRef, chatId)]
}

export function setPreChatModelIntent(agentRef: string, model: string): void {
  if (!agentRef || !model) return
  preChatModelByAgent[agentRef] = model
}

export function getPreChatModelIntent(agentRef: string): string | undefined {
  return agentRef ? preChatModelByAgent[agentRef] : undefined
}

export function clearPreChatModelIntent(agentRef: string): void {
  if (!agentRef) return
  delete preChatModelByAgent[agentRef]
}

/**
 * Drops every intent. Called on logout/user/team scope changes: an unpersisted
 * model choice must never carry across identity boundaries where the same
 * agent/chat identifiers may reappear.
 */
export function resetHostModelIntentStore(): void {
  for (const key of Object.keys(pendingModelByChat)) delete pendingModelByChat[key]
  for (const key of Object.keys(preChatModelByAgent)) delete preChatModelByAgent[key]
}
