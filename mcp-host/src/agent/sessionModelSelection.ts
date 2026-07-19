/**
 * R2 — per-session model swap core. Shared, dependency-injected so it is unit
 * testable outside `main.ts` (which is the process entrypoint and runs `main()`
 * on import). Two callers wire it with live process state:
 *   - `POST /v1/runtime/model` (`handleSetModel`), and
 *   - the piggybacked `message.model` on `handleIncomingMessage` (applied to the
 *     task that WAKES a suspended Host, since a replicas=0 Host can't serve the
 *     route).
 *
 * Behaviour: validate `model ∈ allowlist` (fail-closed; degraded → only the Host
 * default), then persist the per-session selection. Key-derivation contract: the
 * "agent" slot is `hostRef`, matching the desktop's rpc `channelId`, and `chatId`
 * maps to the message `threadId`, so the next task's `resolveTaskSessionKey`
 * reads this exact row. `getOrCreate` makes a set-before-first-message land the
 * selection on a persisted session.
 */
import type { AllowlistView } from '../config/allowlistCheck'
import { isModelAllowed } from '../config/modelResolution'
import type { ConversationManager } from '../core/conversation/conversation'
import type { SetModelResult } from '../server/types'
import { serializeSessionKey } from '../session'

/** Upper bound on the caller-supplied model string. Real model ids are far
 *  shorter; an oversized value can never match the exact-match allowlist, so we
 *  reject it up front and keep it out of the structured logs / API echo
 *  (log-bloat defense — the value is authenticated but caller-influenced). */
const MAX_MODEL_LEN = 256

export interface SessionModelSelectionDeps {
  /** The Host's configured provider + default model, or undefined when the
   *  Host has no resolvable model config (degraded). */
  modelCfg: { provider?: string; name?: string } | undefined
  /** In-memory allowlist snapshot for the Host's provider. */
  allowlistView: AllowlistView
  convManager: ConversationManager
}

export async function applySessionModelSelection(
  deps: SessionModelSelectionDeps,
  userSub: string,
  hostRef: string,
  chatId: string | undefined,
  model: string
): Promise<SetModelResult> {
  const { modelCfg, allowlistView, convManager } = deps
  const provider = modelCfg?.provider ?? 'unknown'
  if (model.length > MAX_MODEL_LEN) {
    console.info(
      JSON.stringify({
        level: 'info',
        event: 'set_model_rejected',
        userId: userSub,
        chatId,
        provider,
        reason: 'model_too_long',
        modelLength: model.length,
      })
    )
    return {
      ok: false as const,
      reason: 'model_not_allowed' as const,
      provider,
      model: model.slice(0, MAX_MODEL_LEN),
    }
  }
  if (!modelCfg?.provider || !modelCfg.name) {
    return { ok: false as const, reason: 'model_not_allowed' as const, provider, model }
  }
  if (!isModelAllowed(allowlistView, provider, model, modelCfg.name)) {
    console.info(
      JSON.stringify({
        level: 'info',
        event: 'set_model_rejected',
        userId: userSub,
        chatId,
        provider,
        model,
      })
    )
    return { ok: false as const, reason: 'model_not_allowed' as const, provider, model }
  }
  const key = serializeSessionKey({
    userId: userSub,
    channelType: 'rpc',
    channelId: hostRef,
    threadId: chatId,
  })
  const conversation = await convManager.getOrCreate(key, {
    userId: userSub,
    channelType: 'rpc',
    channelId: hostRef,
    threadId: chatId,
    source: 'rpc',
  })
  convManager.setModelSelection(conversation, provider, model)
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'set_model',
      userId: userSub,
      chatId,
      provider,
      model,
    })
  )
  return { ok: true as const, provider, model }
}
