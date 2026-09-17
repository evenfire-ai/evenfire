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
 *
 * #654 — the write is a durable compare-and-swap, and it is AWAITED before this
 * function resolves: `expectedRevision` is the revision the caller read, a stale
 * one is refused with `model_selection_conflict` (the row keeps the winner), and
 * a legacy call without it still bumps the revision so a straggler is detectable.
 * A resolution here therefore means "the selection is on disk", not "the op was
 * queued" — which is what the caller's ACK asserts.
 */
import type { AllowlistView } from '../config/allowlistCheck'
import { isModelAllowed } from '../config/modelResolution'
import type { ConversationManager } from '../core/conversation/conversation'
import { logger } from '../logger'
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
  model: string,
  expectedRevision?: number
): Promise<SetModelResult> {
  const { modelCfg, allowlistView, convManager } = deps
  const provider = modelCfg?.provider ?? 'unknown'
  if (model.length > MAX_MODEL_LEN) {
    logger.info(
      {
        event: 'set_model_rejected',
        userId: userSub,
        chatId,
        provider,
        reason: 'model_too_long',
        modelLength: model.length,
      },
      'set_model_rejected'
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
    logger.info(
      {
        event: 'set_model_rejected',
        userId: userSub,
        chatId,
        provider,
        model,
      },
      'set_model_rejected'
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
  // #654 — the durable CAS write is AWAITED here: this promise resolving is what
  // lets the route (and the piggybacked `message.model` path) ACK a selection.
  // A losing CAS leaves the row and the in-RAM map on the winner's value and is
  // reported as `model_selection_conflict` so the caller can re-read and retry
  // with the revision that won, instead of silently reverting to the default.
  const outcome = await convManager.setModelSelection(
    conversation,
    provider,
    model,
    expectedRevision
  )
  if (!outcome.applied) {
    logger.info(
      {
        event: 'set_model_conflict',
        userId: userSub,
        chatId,
        provider,
        modelSelectionRevision: outcome.modelSelectionRevision,
      },
      'set_model_conflict'
    )
    return {
      ok: false as const,
      reason: 'model_selection_conflict' as const,
      provider,
      model,
      modelSelectionRevision: outcome.modelSelectionRevision,
    }
  }
  logger.info(
    {
      event: 'set_model',
      userId: userSub,
      chatId,
      provider,
      model,
      modelSelectionRevision: outcome.modelSelectionRevision,
    },
    'set_model'
  )
  return {
    ok: true as const,
    provider,
    model,
    modelSelectionRevision: outcome.modelSelectionRevision,
  }
}
