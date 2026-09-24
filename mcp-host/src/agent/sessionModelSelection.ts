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
 *
 * With `skipWriteWhenEffective` (message admission only), a request for the
 * session's current effective model (explicit selection, or the Host default
 * when there is none) is admitted WITHOUT a write: it returns the current
 * revision, after the same allowlist and revision checks.
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

export interface SessionModelSelectionOptions {
  /** Admit a request for the session's current effective model WITHOUT
   *  writing it. Only the message-admission piggyback sets this: an image send
   *  carries the model the client displays, which is not a user pick. An
   *  explicit pick (`POST /v1/runtime/model`) leaves it unset, so choosing the
   *  Host default pins it and the chat stays on it if the default changes. */
  skipWriteWhenEffective?: boolean
}

export async function applySessionModelSelection(
  deps: SessionModelSelectionDeps,
  userSub: string,
  hostRef: string,
  chatId: string | undefined,
  model: string,
  expectedRevision?: number,
  options: SessionModelSelectionOptions = {}
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
  // With `skipWriteWhenEffective`, asking for the model the session ALREADY
  // runs on is not a change, so it is not written. The effective model is the
  // explicit selection for this provider when there is one, otherwise the Host
  // default. Without this, every image send (which carries `model` = the model
  // the client displays, usually the Host default) would pin the default as an
  // explicit selection and bump the revision, so a later Host default change
  // would no longer reach the session. The revision gate still applies: a stale `expectedRevision` is a
  // conflict here exactly as it is in the store. The reported revision is the
  // one on this process's conversation mirror; if another writer moved the
  // durable row past it, the caller's next real write conflicts and carries
  // the winner.
  const currentRevision = conversation.modelSelectionRevision ?? 0
  const effectiveModel = conversation.modelSelections?.[provider] ?? modelCfg.name
  if (options.skipWriteWhenEffective === true && model === effectiveModel) {
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      logger.info(
        {
          event: 'set_model_conflict',
          userId: userSub,
          chatId,
          provider,
          modelSelectionRevision: currentRevision,
        },
        'set_model_conflict'
      )
      return {
        ok: false as const,
        reason: 'model_selection_conflict' as const,
        provider,
        model,
        modelSelectionRevision: currentRevision,
      }
    }
    logger.info(
      {
        event: 'set_model_unchanged',
        userId: userSub,
        chatId,
        provider,
        model,
        modelSelectionRevision: currentRevision,
      },
      'set_model_unchanged'
    )
    return {
      ok: true as const,
      provider,
      model,
      modelSelectionRevision: currentRevision,
    }
  }
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
