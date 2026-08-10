/**
 * The consent gate (spec §9).
 *
 * Owns everything between "a plugin wants a capability" and "the broker may
 * call the provider": grant lookup, session-sticky denials, the prompt budget,
 * the single-prompt-at-a-time queue, and the modal round-trip to the trusted
 * renderer.
 *
 * Two asymmetries are deliberate:
 *   - A GRANT is permanent until revoked (decision D4).
 *   - A DENIAL is in-memory and dies with the mount, so a mis-click is not a
 *     permanent lockout — reopening the plugin gives it one more chance to ask.
 *
 * The prompt itself renders in the trusted renderer while the plugin surface is
 * HIDDEN, because a WebContentsView paints above renderer DOM regardless of
 * z-index (spec §9.4). Hiding it is the only way to guarantee the plugin can
 * neither fake a modal nor paint over the real one.
 */
import { randomUUID } from 'node:crypto'
import type { ConsentGrant, ConsentStore } from './pluginConsentStore.js'
import { getCapability, sortCapabilitiesForPrompt } from './pluginSdkCapabilities.js'
import type { PluginConsentRequest, PluginConsentRow } from './pluginSdkProtocol.js'

export const CONSENT_PROMPT_TIMEOUT_MS = 120_000
export const CONSENT_PROMPT_COOLDOWN_MS = 10_000
/** Modals — not capabilities — per plugin per mount (spec §9.5). */
export const CONSENT_MAX_PROMPTS_PER_MOUNT = 3

export type ConsentDecisionSource =
  | 'existing_grant'
  | 'prompt_allowed'
  | 'prompt_denied'
  | 'not_required'

export type ConsentOutcome = {
  granted: Record<string, boolean>
  /** How each id was decided, for the audit line. */
  source: Record<string, ConsentDecisionSource>
}

export type ConsentGateDeps = {
  store: ConsentStore
  /** Push the prompt to the trusted renderer. */
  presentPrompt: (request: PluginConsentRequest) => void
  /** Withdraw a prompt the user never answered (timeout, embed died). */
  cancelPrompt: (promptId: string) => void
  /** Hide/show the active plugin surface around the modal. */
  setSurfaceVisible: (visible: boolean) => Promise<void>
  /** True when a Desktop window is visible and focused. */
  isWindowReady: () => boolean
  now?: () => number
  /**
   * Injectable delay. Real code sleeps; tests assert the requested duration
   * without spending it, so the cooldown stays a tested behaviour rather than a
   * behaviour tests have to disable.
   */
  sleep?: (ms: number) => Promise<void>
}

type PendingPrompt = {
  promptId: string
  pluginId: string
  capabilities: Set<string>
  resolve: (allowed: Set<string>) => void
  timer: ReturnType<typeof setTimeout> | null
}

type PluginSessionState = {
  denials: Set<string>
  promptCount: number
  lastPromptAt: number
}

export class PluginConsentGate {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly sessions = new Map<string, PluginSessionState>()
  private pending: PendingPrompt | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ConsentGateDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  private session(pluginId: string): PluginSessionState {
    const existing = this.sessions.get(pluginId)
    if (existing) return existing
    const created: PluginSessionState = { denials: new Set(), promptCount: 0, lastPromptAt: 0 }
    this.sessions.set(pluginId, created)
    return created
  }

  /** Called on unmount: denials and the prompt budget are per-mount state. */
  resetPlugin(pluginId: string): void {
    this.sessions.delete(pluginId)
    if (this.pending?.pluginId === pluginId) {
      const pending = this.pending
      this.pending = null
      if (pending.timer) clearTimeout(pending.timer)
      this.deps.cancelPrompt(pending.promptId)
      pending.resolve(new Set())
    }
  }

  resetAll(): void {
    this.sessions.clear()
  }

  /**
   * Is this capability already granted, at a descriptor version that still
   * covers today's payload? A grant recorded before the payload widened does
   * NOT carry over (spec §9.6) — silently widening an existing grant is the
   * easiest way to turn consent into theatre.
   */
  async isGranted(key: {
    envKey: string
    userId: string
    pluginId: string
    capability: string
  }): Promise<boolean> {
    const descriptor = getCapability(key.capability)
    if (!descriptor) return false
    if (!descriptor.requiresConsent) return true
    const grant = await this.deps.store.get(key)
    if (!grant) return false
    return grant.descriptorVersion >= descriptor.descriptorVersion
  }

  /**
   * Resolve consent for a set of capabilities, prompting at most once for
   * whatever is still undecided. This is the single entry point — a lone
   * capability call is just a batch of one.
   */
  async ensure(input: {
    envKey: string
    userId: string
    pluginId: string
    pluginTitle: string
    capabilities: string[]
  }): Promise<ConsentOutcome> {
    const granted: Record<string, boolean> = {}
    const source: Record<string, ConsentDecisionSource> = {}
    const session = this.session(input.pluginId)
    const toPrompt: string[] = []

    for (const capability of input.capabilities) {
      const descriptor = getCapability(capability)
      if (!descriptor) {
        granted[capability] = false
        source[capability] = 'prompt_denied'
        continue
      }
      if (!descriptor.requiresConsent) {
        granted[capability] = true
        source[capability] = 'not_required'
        continue
      }
      if (await this.isGranted({ ...input, capability })) {
        granted[capability] = true
        source[capability] = 'existing_grant'
        continue
      }
      if (session.denials.has(capability)) {
        // Session-sticky: one refusal buys silence for the rest of the mount.
        granted[capability] = false
        source[capability] = 'prompt_denied'
        continue
      }
      toPrompt.push(capability)
    }

    if (toPrompt.length === 0) return { granted, source }

    const allowed = await this.promptFor(input, toPrompt)
    for (const capability of toPrompt) {
      const isAllowed = allowed.has(capability)
      granted[capability] = isAllowed
      source[capability] = isAllowed ? 'prompt_allowed' : 'prompt_denied'
      if (!isAllowed) session.denials.add(capability)
    }
    return { granted, source }
  }

  private async promptFor(
    input: { envKey: string; userId: string; pluginId: string; pluginTitle: string },
    capabilities: string[]
  ): Promise<Set<string>> {
    // Serialize: one modal at a time, globally. A second request whose rows are
    // already in flight joins that prompt rather than opening another.
    const run = this.queue.then(
      () => this.runPrompt(input, capabilities),
      () => this.runPrompt(input, capabilities)
    )
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runPrompt(
    input: { envKey: string; userId: string; pluginId: string; pluginTitle: string },
    capabilities: string[]
  ): Promise<Set<string>> {
    const session = this.session(input.pluginId)

    // Re-check: a queued request may have been answered by the prompt ahead of
    // it, or denied while it waited.
    const stillNeeded: string[] = []
    for (const capability of capabilities) {
      if (session.denials.has(capability)) continue
      if (await this.isGranted({ ...input, capability })) continue
      stillNeeded.push(capability)
    }
    if (stillNeeded.length === 0) {
      const resolved = new Set<string>()
      for (const capability of capabilities) {
        if (await this.isGranted({ ...input, capability })) resolved.add(capability)
      }
      return resolved
    }

    if (session.promptCount >= CONSENT_MAX_PROMPTS_PER_MOUNT) {
      // Budget spent. Everything left is denied until the user reopens the
      // plugin. Not recorded as a session denial: the user never saw this ask.
      return new Set()
    }

    const cooldownRemaining = CONSENT_PROMPT_COOLDOWN_MS - (this.now() - session.lastPromptAt)
    if (session.lastPromptAt > 0 && cooldownRemaining > 0) {
      await this.sleep(cooldownRemaining)
    }

    const ready = await this.waitForWindow()
    if (!ready) return new Set()

    const rows: PluginConsentRow[] = sortCapabilitiesForPrompt(stillNeeded).flatMap(capability => {
      const descriptor = getCapability(capability)
      if (!descriptor) return []
      return [
        {
          capability,
          title: descriptor.consent.title,
          dataDescription: descriptor.consent.dataDescription,
          tier: descriptor.consent.tier,
        },
      ]
    })
    if (rows.length === 0) return new Set()

    const promptId = randomUUID()
    const request: PluginConsentRequest = {
      promptId,
      pluginId: input.pluginId,
      pluginTitle: input.pluginTitle,
      rows,
      priorPromptCount: session.promptCount,
    }

    session.promptCount += 1
    session.lastPromptAt = this.now()

    // Register the pending prompt BEFORE the surface-visibility await. If the
    // plugin unmounts during that await (unpin → releasePlugin → resetPlugin),
    // resetPlugin must be able to find and cancel this prompt; otherwise it sees
    // `pending === null`, cancels nothing, and the await below hangs until the
    // 120 s timeout.
    let resolvePrompt!: (allowed: Set<string>) => void
    const promptResult = new Promise<Set<string>>(resolve => {
      resolvePrompt = resolve
    })
    const timer = setTimeout(() => {
      if (this.pending?.promptId !== promptId) return
      this.pending = null
      this.deps.cancelPrompt(promptId)
      // A prompt nobody answered counts as a denial (spec §9.3).
      resolvePrompt(new Set())
    }, CONSENT_PROMPT_TIMEOUT_MS)
    this.pending = {
      promptId,
      pluginId: input.pluginId,
      capabilities: new Set(stillNeeded),
      resolve: resolvePrompt,
      timer,
    }

    let allowed = new Set<string>()
    try {
      await this.deps.setSurfaceVisible(false)
      // If the plugin unmounted during the await, resetPlugin already cleared
      // `this.pending` and resolved the prompt as a denial — never present it.
      if (this.pending?.promptId === promptId) {
        this.deps.presentPrompt(request)
      }
      allowed = await promptResult
    } finally {
      await this.deps.setSurfaceVisible(true).catch(() => undefined)
    }

    const grantedNow = new Set<string>()
    for (const capability of stillNeeded) {
      if (!allowed.has(capability)) continue
      const descriptor = getCapability(capability)
      if (!descriptor) continue
      const grant: ConsentGrant = {
        envKey: input.envKey,
        userId: input.userId,
        pluginId: input.pluginId,
        capability,
        grantedAt: new Date(this.now()).toISOString(),
        lastUsedAt: null,
        descriptorVersion: descriptor.descriptorVersion,
        revision: 0,
      }
      await this.deps.store.put(grant)
      grantedNow.add(capability)
    }

    // Capabilities the caller asked about that were already granted before this
    // prompt still belong in the answer.
    for (const capability of capabilities) {
      if (grantedNow.has(capability)) continue
      if (await this.isGranted({ ...input, capability })) grantedNow.add(capability)
    }
    return grantedNow
  }

  /**
   * Park until a Desktop window is visible and focused, so a modal never races
   * onto a screen the user is not looking at. Polls rather than subscribing to
   * window events: the gate must stay Electron-free for tests, and the wait is
   * bounded by the prompt timeout anyway.
   */
  private async waitForWindow(): Promise<boolean> {
    if (this.deps.isWindowReady()) return true
    const deadline = this.now() + CONSENT_PROMPT_TIMEOUT_MS
    while (this.now() < deadline) {
      await this.sleep(500)
      if (this.deps.isWindowReady()) return true
    }
    return false
  }

  /**
   * The trusted renderer's answer. A resolve for an unknown, stale, or
   * already-answered promptId is dropped — the nonce is what stops an embed
   * from answering its own prompt even if it could reach the channel.
   */
  resolvePrompt(promptId: string, allowed: string[]): boolean {
    const pending = this.pending
    if (!pending || pending.promptId !== promptId) return false
    this.pending = null
    if (pending.timer) clearTimeout(pending.timer)
    const accepted = new Set(allowed.filter(capability => pending.capabilities.has(capability)))
    pending.resolve(accepted)
    return true
  }

  hasPendingPrompt(): boolean {
    return this.pending !== null
  }
}
