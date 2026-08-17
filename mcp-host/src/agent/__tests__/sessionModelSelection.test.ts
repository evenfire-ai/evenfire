/**
 * R2 — piggybacked per-session model selection core.
 *
 * `applySessionModelSelection` is the shared core behind BOTH the
 * `POST /v1/runtime/model` route and the `message.model` that rides WITH a
 * message (the path that lets a model picked while the Host was suspended land
 * on the very task that wakes it). These tests assert the two properties that
 * matter for the wake-and-hold path:
 *   (a) an allowlisted model PERSISTS the selection so the per-task resolver
 *       (`taskModelResolver` over `conv.modelSelections`) resolves to it;
 *   (b) a non-allowlisted model is REJECTED (ok:false) and leaves any existing
 *       selection untouched — the caller (`handleIncomingMessage`) uses that
 *       signal to WARN + process the message with the default (fail-open).
 *
 * The route regression (identical `{ effective, provider, model }` / 403 shape)
 * stays covered by `server/__tests__/modelRoutes.test.ts`, which drives the
 * route with a mocked handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AllowlistView } from '../../config/allowlistCheck'
import type { AllowedModelEntry } from '../../config/configStore'
import { hostSubsetAllowlistView, resolveSessionModel } from '../../config/modelResolution'
import { ConversationManager } from '../../core/conversation/conversation'
import { serializeSessionKey } from '../../session'
import {
  type SessionModelSelectionDeps,
  applySessionModelSelection,
} from '../sessionModelSelection'

// Allowlist stub: `claude` provider permits the host default + `claude-haiku-4-5`.
function makeAllowlistView(): AllowlistView {
  const allowed = new Map<string, AllowedModelEntry[]>([
    ['claude', [{ model: 'claude-opus-4-8' }, { model: 'claude-haiku-4-5' }]],
  ])
  return {
    allowlistAvailable: () => true,
    allowedModels: () => allowed,
  }
}

function makeDeps(convManager: ConversationManager): SessionModelSelectionDeps {
  return {
    modelCfg: { provider: 'claude', name: 'claude-opus-4-8' },
    allowlistView: makeAllowlistView(),
    convManager,
  }
}

const USER = 'user-1'
const HOST = 'chatllm'
const CHAT = 'c-9'
// Same key the task's `resolveTaskSessionKey` builds: agent slot = hostRef,
// thread slot = chatId.
const sessionKey = serializeSessionKey({
  userId: USER,
  channelType: 'rpc',
  channelId: HOST,
  threadId: CHAT,
})

describe('applySessionModelSelection (R2 shared core)', () => {
  let cm: ConversationManager

  beforeEach(() => {
    vi.clearAllMocks()
    cm = new ConversationManager()
  })

  it('(a) persists an allowlisted model so the per-task resolver resolves to it', async () => {
    const result = await applySessionModelSelection(
      makeDeps(cm),
      USER,
      HOST,
      CHAT,
      'claude-haiku-4-5'
    )

    expect(result).toEqual({ ok: true, provider: 'claude', model: 'claude-haiku-4-5' })

    // The selection landed on the exact row the next task reads.
    const conv = await cm.getOrCreate(sessionKey)
    expect(conv.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })

    // And the per-task resolution (same primitive the state machine uses) picks it.
    const resolved = resolveSessionModel(
      makeAllowlistView(),
      'claude',
      'claude-opus-4-8',
      conv.modelSelections
    )
    expect(resolved).toEqual({ model: 'claude-haiku-4-5' })
  })

  it('fails closed when an exact session key is already owned by another subject', async () => {
    await cm.getOrCreate(sessionKey, { userId: 'different-owner' })

    await expect(
      applySessionModelSelection(makeDeps(cm), USER, HOST, CHAT, 'claude-haiku-4-5')
    ).rejects.toMatchObject({
      name: 'ConversationError',
      code: 'CONV_OWNERSHIP_MISMATCH',
    })
  })

  it('(b) rejects a non-allowlisted model and leaves the existing selection unchanged', async () => {
    // Seed a valid prior selection on the session.
    const seeded = await cm.getOrCreate(sessionKey, {
      userId: USER,
      channelType: 'rpc',
      channelId: HOST,
      threadId: CHAT,
      source: 'rpc',
    })
    cm.setModelSelection(seeded, 'claude', 'claude-haiku-4-5')

    const result = await applySessionModelSelection(makeDeps(cm), USER, HOST, CHAT, 'gpt-5')

    expect(result).toEqual({
      ok: false,
      reason: 'model_not_allowed',
      provider: 'claude',
      model: 'gpt-5',
    })

    // Prior selection survives — the caller processes the message with it/default.
    const conv = await cm.getOrCreate(sessionKey)
    expect(conv.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })
  })

  it('rejects an oversized model string up front and returns it truncated (log-bloat defense)', async () => {
    const huge = 'x'.repeat(300)
    const result = await applySessionModelSelection(makeDeps(cm), USER, HOST, CHAT, huge)
    // toMatchObject avoids narrowing the {ok:true} | {ok:false, reason} union by
    // hand; `model` is present on both arms so its length can be read directly.
    expect(result).toMatchObject({ ok: false, reason: 'model_not_allowed' })
    // Echoed model is capped at 256 chars, never the full oversized value.
    expect(result.model.length).toBe(256)
    // Nothing persisted.
    const conv = await cm.getOrCreate(sessionKey)
    expect(conv.modelSelections ?? {}).toEqual({})
  })

  it('rejects with model_not_allowed when the Host has no resolvable model config', async () => {
    const deps: SessionModelSelectionDeps = { ...makeDeps(cm), modelCfg: undefined }
    const result = await applySessionModelSelection(deps, USER, HOST, CHAT, 'claude-haiku-4-5')
    expect(result).toEqual({
      ok: false,
      reason: 'model_not_allowed',
      provider: 'unknown',
      model: 'claude-haiku-4-5',
    })
  })

  it('(T3a) rejects a globally-allowed model that the host subset excludes', async () => {
    // Global permits opus + haiku, but this host's spec.allowedModels offers
    // only opus. Selecting haiku (global-allowed, not host-offered) is rejected.
    const deps: SessionModelSelectionDeps = {
      ...makeDeps(cm),
      allowlistView: hostSubsetAllowlistView(makeAllowlistView(), [
        { provider: 'claude', model: 'claude-opus-4-8' },
      ]),
    }
    const result = await applySessionModelSelection(deps, USER, HOST, CHAT, 'claude-haiku-4-5')
    expect(result).toEqual({
      ok: false,
      reason: 'model_not_allowed',
      provider: 'claude',
      model: 'claude-haiku-4-5',
    })
    // Nothing persisted.
    const conv = await cm.getOrCreate(sessionKey)
    expect(conv.modelSelections ?? {}).toEqual({})

    // The host-offered model still persists through the same subset view.
    const ok = await applySessionModelSelection(deps, USER, HOST, CHAT, 'claude-opus-4-8')
    expect(ok).toEqual({ ok: true, provider: 'claude', model: 'claude-opus-4-8' })
  })

  it('applies under a threadless (default) session key, matching resolveTaskSessionKey', async () => {
    // A message with no threadId serializes its session under `…:default`; the
    // helper must write the same row when chatId is undefined.
    const result = await applySessionModelSelection(
      makeDeps(cm),
      USER,
      HOST,
      undefined,
      'claude-haiku-4-5'
    )
    expect(result.ok).toBe(true)

    const defaultKey = serializeSessionKey({
      userId: USER,
      channelType: 'rpc',
      channelId: HOST,
      threadId: undefined,
    })
    const conv = await cm.getOrCreate(defaultKey)
    expect(conv.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })
  })
})
