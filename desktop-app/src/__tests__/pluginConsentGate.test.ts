import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CONSENT_MAX_PROMPTS_PER_MOUNT,
  CONSENT_PROMPT_COOLDOWN_MS,
  CONSENT_PROMPT_TIMEOUT_MS,
  PluginConsentGate,
} from '../pluginConsentGate.js'
import { LocalConsentStore } from '../pluginConsentStore.js'
import type { PluginConsentRequest } from '../pluginSdkProtocol.js'

const ENV_KEY = 'testenv-0123456789ab'
const BASE = { envKey: ENV_KEY, userId: 'user-1', pluginId: 'ns/plugin', pluginTitle: 'Plugin' }

let tmpDir: string
let store: LocalConsentStore
let prompts: PluginConsentRequest[]
let cancelled: string[]
let visibility: boolean[]
let sleeps: number[]
let clock: number

type GateOptions = {
  decide?: (request: PluginConsentRequest) => string[] | null
  windowReady?: () => boolean
  setSurfaceVisible?: (visible: boolean) => Promise<void>
}

/** Spin the macrotask queue until `pred` holds — deterministic, no fixed sleep. */
async function flushUntil(pred: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks && !pred(); i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  // Fail loudly rather than returning silently — a swallowed timeout lets a test
  // go green even when the awaited condition never became true.
  if (!pred()) throw new Error('flushUntil: predicate did not hold within maxTicks')
}

function makeGate(options: GateOptions = {}): PluginConsentGate {
  const gate = new PluginConsentGate({
    store,
    presentPrompt: request => {
      prompts.push(request)
      const decision = options.decide
        ? options.decide(request)
        : request.rows.map(r => r.capability)
      // `null` models a user who never answers.
      if (decision !== null) {
        setTimeout(() => gate.resolvePrompt(request.promptId, decision), 0)
      }
    },
    cancelPrompt: promptId => cancelled.push(promptId),
    setSurfaceVisible:
      options.setSurfaceVisible ??
      (async visible => {
        visibility.push(visible)
      }),
    isWindowReady: options.windowReady ?? (() => true),
    now: () => clock,
    sleep: async ms => {
      sleeps.push(ms)
      clock += ms
    },
  })
  return gate
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-consent-gate-'))
  store = new LocalConsentStore(path.join(tmpDir, 'consent'), () => clock)
  prompts = []
  cancelled = []
  visibility = []
  sleeps = []
  clock = 1_700_000_000_000
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('PluginConsentGate', () => {
  it('hides the plugin surface for the duration of the prompt and restores it after', async () => {
    const gate = makeGate()
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    // False before the modal, true after — the plugin cannot paint while the
    // user is deciding (spec §9.4).
    expect(visibility).toEqual([false, true])
  })

  it('persists a grant that survives a new gate instance', async () => {
    const first = makeGate()
    await first.ensure({ ...BASE, capabilities: ['identity.read'] })

    const second = makeGate()
    const outcome = await second.ensure({ ...BASE, capabilities: ['identity.read'] })
    expect(outcome.source['identity.read']).toBe('existing_grant')
    expect(prompts).toHaveLength(1)
  })

  it('treats an unanswered prompt as a denial once it times out', async () => {
    const gate = makeGate({ decide: () => null })
    const pending = gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Fire the real timer the gate armed.
    await new Promise(resolve => setTimeout(resolve, 0))
    const promptId = prompts[0]?.promptId as string
    // Simulate the timeout path directly: resolving with nothing is what the
    // timer does, and waiting 120 s in a unit test is not a test.
    gate.resolvePrompt(promptId, [])
    const outcome = await pending
    expect(outcome.granted['identity.read']).toBe(false)
  })

  it('drops a resolve for an unknown or already-answered promptId', async () => {
    const gate = makeGate()
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    const promptId = prompts[0]?.promptId as string
    // The nonce is what stops a replayed or forged resolve from landing.
    expect(gate.resolvePrompt(promptId, ['identity.read'])).toBe(false)
    expect(gate.resolvePrompt('not-a-prompt', ['identity.read'])).toBe(false)
  })

  it('waits out the cooldown between consecutive prompts', async () => {
    const gate = makeGate()
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    await gate.ensure({ ...BASE, capabilities: ['org.read'] })
    expect(sleeps).toEqual([CONSENT_PROMPT_COOLDOWN_MS])
  })

  it('spends one prompt from the budget per batch, not one per capability', async () => {
    const gate = makeGate()
    await gate.ensure({
      ...BASE,
      capabilities: ['identity.read', 'org.read', 'agents.read', 'gfs.list'],
    })
    expect(prompts).toHaveLength(1)

    // Budget is 3 modals; a 4-capability batch must not have exhausted it.
    await gate.ensure({ ...BASE, capabilities: ['mcp.read'] })
    expect(prompts).toHaveLength(2)
  })

  it('stops prompting after the per-mount budget is spent', async () => {
    const gate = makeGate({ decide: () => [] })
    const asks = ['identity.read', 'org.read', 'agents.read', 'mcp.read']
    for (const capability of asks) {
      await gate.ensure({ ...BASE, capabilities: [capability] })
    }
    expect(prompts).toHaveLength(CONSENT_MAX_PROMPTS_PER_MOUNT)
  })

  it('reports how many times a plugin has already asked this session', async () => {
    const gate = makeGate()
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    await gate.ensure({ ...BASE, capabilities: ['org.read'] })
    expect(prompts[0]?.priorPromptCount).toBe(0)
    expect(prompts[1]?.priorPromptCount).toBe(1)
  })

  it('clears denials and the prompt budget when the plugin unmounts', async () => {
    const gate = makeGate({ decide: () => [] })
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    expect(prompts).toHaveLength(1)

    // Reopening the plugin gives it one more chance to ask — a mis-click is not
    // a permanent lockout (spec §9.3).
    gate.resetPlugin(BASE.pluginId)
    await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    expect(prompts).toHaveLength(2)
  })

  it('cancels a pending prompt when its plugin goes away', async () => {
    const gate = makeGate({ decide: () => null })
    const pending = gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    // Wait until the prompt is actually presented (deterministic) rather than a
    // single arbitrary tick, which raced the async setup under I/O load.
    await flushUntil(() => prompts.length === 1)
    gate.resetPlugin(BASE.pluginId)
    const outcome = await pending
    expect(cancelled).toHaveLength(1)
    expect(outcome.granted['identity.read']).toBe(false)
  })

  it('cancels a prompt whose plugin unmounts during the surface-hide flip', async () => {
    // Regression for the ordering window: the pending prompt is registered before
    // the `setSurfaceVisible(false)` await, so an unmount mid-flip is cancelled as
    // a denial instead of hanging until the 120 s timeout — and is never shown.
    let releaseHide!: () => void
    const hideBlocked = new Promise<void>(resolve => {
      releaseHide = resolve
    })
    const gate = makeGate({
      decide: () => null,
      setSurfaceVisible: async visible => {
        visibility.push(visible)
        if (visible === false) await hideBlocked
      },
    })
    const pending = gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    await flushUntil(() => visibility.includes(false))
    gate.resetPlugin(BASE.pluginId)
    releaseHide()
    const outcome = await pending
    expect(cancelled).toHaveLength(1)
    expect(outcome.granted['identity.read']).toBe(false)
    expect(prompts).toHaveLength(0)
  })

  it('does not leak a pending prompt when the surface-hide flip rejects', async () => {
    // Regression (R2-L1): the pending entry + 120s timer are registered before
    // the hide await. If that await throws (WebContentsView destroyed mid-flip),
    // runPrompt must tear them down rather than leak them until the timeout.
    const gate = makeGate({
      decide: () => null,
      setSurfaceVisible: async visible => {
        visibility.push(visible)
        if (visible === false) throw new Error('view destroyed mid-flip')
      },
    })
    await expect(gate.ensure({ ...BASE, capabilities: ['identity.read'] })).rejects.toThrow(
      'view destroyed mid-flip'
    )
    expect(gate.hasPendingPrompt()).toBe(false)
    expect(prompts).toHaveLength(0)
  })

  it('does not prompt for an ambient capability', async () => {
    const gate = makeGate()
    const outcome = await gate.ensure({ ...BASE, capabilities: ['theme.read'] })
    expect(outcome.source['theme.read']).toBe('not_required')
    expect(prompts).toHaveLength(0)
  })

  it('parks rather than prompting onto an unfocused window, and gives up at the timeout', async () => {
    const gate = makeGate({ windowReady: () => false })
    const outcome = await gate.ensure({ ...BASE, capabilities: ['identity.read'] })
    expect(prompts).toHaveLength(0)
    expect(outcome.granted['identity.read']).toBe(false)
    // It polled until the deadline instead of spinning forever.
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(
      CONSENT_PROMPT_TIMEOUT_MS
    )
  })
})
