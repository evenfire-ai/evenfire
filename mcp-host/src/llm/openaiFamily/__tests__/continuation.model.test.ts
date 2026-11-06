/**
 * Model-based oracle for Responses continuity (A6). Random sequences of the A2
 * events run on the real stack — `runToolUseLoop` → `HookedLlmPort` (content
 * hooks + token-trim) → `FailoverLlmPort` → `FailoverEngine` → `LlmPortAdapter`
 * → `OpenAIProvider` (official profile and one compatible) — and the
 * invariants are checked at rest against what crossed the two boundaries the
 * test doubles: the SDK client and the hook HTTP transport.
 *
 * The reference model is deliberately trivial: which driver instance produced
 * each pushed tool turn, which driver instance served each attempt, and which
 * events took the replay away. It never re-derives an owner or a digest.
 *
 * Every SDK answer is a recorded response. Per turn the item ids (`id`,
 * `call_id`) are relabeled and a per-turn suffix is appended to each opaque
 * `encrypted_content`, so that several turns of the same recording stay
 * distinguishable by id and by blob value; nothing else in the recording
 * changes. Failures are real SDK errors built by the SDK's own constructors.
 *
 * Limits of this oracle, and what covers them instead:
 * - I15 is checked on every persisted snapshot, but the recorded blobs are
 *   about 2 KB: the 256 KiB bound is discriminated by T-P4, not here.
 * - No recording interleaves `[r1, fc1, r2, fc2]`, so `interleaved` exercises
 *   the preamble shape only; reordering reasoning first is discriminated by
 *   T-C11 alone until a V-2c interleaved recording exists.
 * - The approval pause is replicated by hand in `persist` (the executor's
 *   budget stamp and SQLite round trip); T-P3 covers the executor's own path.
 *
 * Commands that cannot be expressed on the real stack exactly as A6 names them,
 * and what runs instead:
 * - `mistakenTrigger`: no recording calls `workflow_trigger`. The closest real
 *   discard of a decoded tool turn without a push is a `post_call` substitute
 *   that drops every call.
 * - `compactCut`: the cut decision is the real InLoopContextManager's; the
 *   reference model only copies which turns it kept. The aligned cut never
 *   archives past the last user message, so it reaches a tool turn of the
 *   current run only after the loop injected a user nudge (R-06 scenario);
 *   otherwise it removes the earlier text-only history. The `prune` variant
 *   runs the context manager's `prePrune` (E7b).
 * - `failTo(otherModel)`: production builds a same-provider fallback with the
 *   session model, so the other-model Responses target is built directly
 *   through the factory.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import OpenAI from 'openai'
import { TaskExecutionBudget } from '../../../agent/taskExecutionBudget'
import { bindTaskSignal } from '../../../core/adapters/abortableLlmPort'
import { maybeWrapFailover } from '../../../core/adapters/failoverLlmPort'
import { HookedLlmPort } from '../../../core/adapters/hookedLlmPort'
import { LlmPortAdapter } from '../../../core/adapters/llmPortAdapter'
import { makeFakeConversation } from '../../../core/conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../../core/conversation/persistence/__tests__/testHelpers'
import { SqliteConversationStore } from '../../../core/conversation/persistence/sqliteConversationStore'
import { LlmError, LlmErrorCode } from '../../../core/errors'
import { InLoopContextManager } from '../../../core/extensions/contextManager'
import { UnifiedApprovalGateController } from '../../../core/extensions/mcpApprovalGateController'
import { prePrune } from '../../../core/extensions/prePrune'
import { type FetchLike, type HookDescriptor, buildLlmLaneHooks } from '../../../core/guardrails'
import { buildLlmBuiltinChain } from '../../../core/guardrails/llm/builtinChain'
import type { ContextManager, LlmPort, Tool, ToolRegistry } from '../../../core/interfaces'
import { SimpleEventEmitter } from '../../../core/orchestration/eventEmitter'
import { buildLoopConfig } from '../../../core/orchestration/loopConfig'
import { runToolUseLoop, validateToolLinkages } from '../../../core/orchestration/toolUseLoop'
import { DefaultReasoningPort } from '../../../core/reasoning/port'
import { DefaultPromptBuilder } from '../../../core/reasoning/promptBuilder'
import { BasicSafety } from '../../../core/safety/safety'
import { createTokenCounter } from '../../../core/tokenizer'
import type { ChatMessage, PendingApproval, ToolOutput } from '../../../core/types'
import { openaiApiError } from '../../__tests__/sdkErrorFixtures'
import { FailoverEngine } from '../../failover/engine'
import type { LlmPolicy } from '../../failover/types'
import { makeProvider } from '../../registry'
import { descriptorFor } from '../../registryCore'
import type { SingleTurnProvider } from '../../types'
import { continuationDigest } from '../protocols/responses'
import { buildFamilyProvider } from './familyHarness'
import {
  RESPONSES_MODEL,
  type RecordedItem,
  deepFreeze,
  recordedResponse,
} from './responsesFixtures'

type Item = RecordedItem
type Role = 'primary' | 'otherModel' | 'compat' | 'sameKey'

const OTHER_MODEL = 'gpt-5.4-mini'
const COMPAT: 'deepseek' = 'deepseek'
const COOLDOWN_SECONDS = 60
const MAX_ATTEMPTS_PER_CALL = 4
const PROMPT = 'Which city, and its weather?'

const CHAT_TOOLS = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'chatCompletion.tools.recorded.json'), 'utf8')
)
const CHAT_TEXT = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'chatCompletion.text.recorded.json'), 'utf8')
)

/** Recorded tool turns, by the output shape they exercise. */
const TOOL_SHAPES = {
  rfc: 'v1-rfc-gpt-6.1-terra',
  rfcParallel: 'v1-rfc-parallel-gpt-6.1-terra',
  rfcPreamble: 'v1-rfc-preamble-gpt-6.1-terra',
  fc: 'v1-fc-gpt-6.1-terra',
  fcParallel: 'v1-fc-parallel-gpt-6.1-terra',
  fcPreamble: 'v1-fc-preamble-gpt-6.1-terra',
  threeCalls: 'v5-strictfalse-gpt-6.1-terra',
} as const
type ToolShape = keyof typeof TOOL_SHAPES
const INTERLEAVED: ToolShape[] = ['rfcPreamble', 'fcPreamble']

const TOOL_NAMES = [
  'get_weather',
  'get_time',
  'brave_web_search',
  'resolve-library-id',
  'search_papers',
]

// ─── Reference model ──────────────────────────────────────────────

interface TurnRef {
  id: number
  /** Driver instance whose response the loop pushed. */
  producer: string
  responses: boolean
  callIds: string[]
  /** `[type, id]` of the recorded output, the exact replay. */
  layoutShape: { type: unknown; id: unknown }[]
  /** E7b or E21 took the replay away from this message for good. */
  tainted: boolean
}

interface TurnSnapshot extends Omit<TurnRef, 'callIds' | 'layoutShape'> {
  callIds: string[]
  layoutShape: TurnRef['layoutShape']
}

interface LogicalCall {
  id: number
  runId: number
  /** E8: token-trim rewrote this request's arguments. */
  pruned: boolean
  /** E10: a pre_call patch replaced this request's messages. */
  patched: boolean
  /** E21: a post_call substitute dropped every call of this call's answer. */
  emptied: boolean
}

interface SdkRecord {
  seq: number
  runId: number
  logical: LogicalCall
  label: string
  kind: 'responses' | 'chat'
  payload: Record<string, unknown>
  lineage: TurnSnapshot[]
  /** What the test did with the parked send; `failed` is an injected failure. */
  outcome: 'pending' | 'answered' | 'failed' | 'aborted'
}

// ─── The real system, doubled only at the SDK client and hook transport ─────

interface Parked {
  label: string
  record: SdkRecord
  resolve: (value: unknown) => void
}

type LoopResult = Awaited<ReturnType<typeof runToolUseLoop>>

interface Run {
  id: number
  abort: AbortController
  lineage: TurnRef[]
  settled: boolean
  result?: LoopResult
  error?: unknown
  aborted: boolean
}

interface Suspension {
  run: Run
  approval: PendingApproval
  warm: ChatMessage[]
  cold: ChatMessage[]
}

const POLICY: LlmPolicy = {
  cooldownSeconds: COOLDOWN_SECONDS,
  // A transport failure is not a failover trigger here, so it reaches the
  // loop's own retry (E6); a 429 switches targets (E4/E5).
  triggerOn: ['rate_limited'],
  fallbacks: [
    { provider: 'openai', model: OTHER_MODEL },
    { provider: COMPAT, model: 'deepseek-chat' },
    { provider: 'openai', model: RESPONSES_MODEL },
  ],
}
const FALLBACK_ROLES: Role[] = ['otherModel', 'compat', 'sameKey']

function hookDescriptor(over: Partial<HookDescriptor>): HookDescriptor {
  return {
    id: 'h',
    endpoint: 'http://hooks.unit',
    path: '',
    lifecyclePoints: [],
    capabilities: [],
    failMode: 'open',
    order: 100,
    ...over,
  }
}

const HOOK_PROFILE: HookDescriptor[] = [
  hookDescriptor({
    id: 'content-pre',
    lifecyclePoints: ['pre_call'],
    contentAccess: 'content',
    capabilities: ['may_rewrite'],
    order: 100,
  }),
  hookDescriptor({ id: 'moderation', lifecyclePoints: ['moderate'], order: 200 }),
  hookDescriptor({
    id: 'redactor',
    lifecyclePoints: ['post_call'],
    capabilities: ['may_substitute_result'],
    order: 300,
  }),
  hookDescriptor({ id: 'error-observer', lifecyclePoints: ['on_error'], order: 400 }),
]

const TOKEN_TRIM = buildLlmBuiltinChain([
  {
    type: 'token-trim',
    config: {
      protectedTailTurns: 0,
      maxArgsBytes: 8,
      dedupEnabled: false,
      oneLineSummariesEnabled: false,
      stripMediaEnabled: false,
    },
  },
])

/** `CONTINUITY_MODEL_TRACE=1` prints how often each event and check was exercised. */
const STATS: Record<string, number> = {}
function trace(key: string) {
  if (process.env.CONTINUITY_MODEL_TRACE) STATS[key] = (STATS[key] ?? 0) + 1
}
afterAll(() => {
  if (process.env.CONTINUITY_MODEL_TRACE) process.stderr.write(`${JSON.stringify(STATS)}\n`)
})

/** Per property: which of a call's send and its moderation landed first. */
const ORDERS = { 'sdk-before-moderate': 0, 'moderate-before-sdk': 0 }
let maxScheduled = 0

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

class World {
  readonly violations: string[] = []
  readonly records: SdkRecord[] = []
  readonly hookBodies: { point: string; raw: string; logical: number | undefined }[] = []
  readonly logicalCalls: LogicalCall[] = []
  /** Reasoning items as the SDK delivered them: id → encrypted content. */
  readonly delivered = new Map<string, string>()
  readonly turnByCall = new Map<string, TurnRef>()
  readonly turnByReasoning = new Map<string, TurnRef>()
  readonly toolRuns: number[] = []
  readonly pending: Parked[] = []

  private clock = 1_000_000
  private seq = 0
  private turnSeq = 0
  private labelSeq = 0
  private runSeq = 0
  private logicalSeq = 0
  private engine: FailoverEngine
  private primary: { driver: SingleTurnProvider; label: string }
  private current: LogicalCall | null = null
  private run: Run | null = null
  private suspension: Suspension | null = null
  private store: StoreHandle | null = null
  private checked = 0
  /** Largest number of answers that were ever in flight together. */
  maxScheduled = 0
  private readonly firstLanded = new Map<number, 'sdk' | 'moderate'>()
  private checkedHooks = 0

  // Arms consumed by the next event that can apply them.
  private pruneArmed = false
  private patchArmed: 'echo' | 'forge' | null = null
  postMode: 'redact' | 'dropCall' | 'dropAll' | null = null
  private compactArmed: 'cut' | 'prune' | null = null
  private approvalArmed = false

  private readonly tools: ToolRegistry
  private readonly hooks

  constructor(private readonly s: Pick<fc.Scheduler, 'schedule' | 'count' | 'waitOne'>) {
    this.engine = this.newEngine()
    this.primary = this.newDriver('primary', 'openai', RESPONSES_MODEL)
    this.tools = this.registry()
    const fetchImpl: FetchLike = async (url, init) => {
      const point = url.slice(url.lastIndexOf('/') + 1)
      this.hookBodies.push({ point, raw: init.body, logical: this.current?.id })
      const answer = this.hookAnswer(point, JSON.parse(init.body))
      return this.compete(
        point === 'moderate' ? 'moderate' : 'hook',
        Promise.resolve({ status: 200, text: async () => JSON.stringify(answer) })
      )
    }
    this.hooks = buildLlmLaneHooks(HOOK_PROFILE, { getAuthToken: () => '', fetchImpl })
  }

  // ── construction ───────────────────────────────────────────────

  private newEngine(): FailoverEngine {
    return new FailoverEngine(POLICY, { now: () => this.clock, metricInc: () => {} })
  }

  private newDriver(role: Role, provider: 'openai' | typeof COMPAT, model: string) {
    const label = `${role}#${++this.labelSeq}`
    const driver =
      provider === 'openai'
        ? makeProvider('openai', { 'openai-api-key': `sk-${label}` }, model)
        : buildFamilyProvider(provider, model)
    const kind = provider === 'openai' ? 'responses' : 'chat'
    const create = (payload: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
      this.park(label, kind, payload, options?.signal)
    const forbidden = () => {
      this.violations.push(`I1/I2: ${label} used the other protocol`)
      throw new Error('wrong protocol')
    }
    ;(driver as unknown as { client: unknown }).client =
      kind === 'responses'
        ? {
            baseURL: 'https://api.openai.com/v1',
            responses: { create },
            chat: { completions: { create: forbidden } },
          }
        : {
            baseURL: descriptorFor(COMPAT).baseURL,
            chat: { completions: { create } },
            responses: { create: forbidden },
          }
    return { driver, label }
  }

  private adapter(driver: SingleTurnProvider, model: string): LlmPortAdapter {
    return new LlmPortAdapter(
      driver,
      model,
      driver.getProviderType(),
      undefined,
      undefined,
      undefined,
      createTokenCounter(driver, model, { offline: true })
    )
  }

  private registry(): ToolRegistry {
    const tools: Tool[] = TOOL_NAMES.map(name => ({
      name: () => name,
      description: () => `Fake ${name}`,
      parametersSchema: () => ({ type: 'object', properties: {} }),
      execute: async (): Promise<ToolOutput> => {
        this.toolRuns.push(this.run?.id ?? -1)
        return { content: '18C, cloudy', duration_ms: 1, is_error: false }
      },
      requiresSanitization: () => false,
      requiresApproval: () => this.approvalArmed,
    }))
    const map = new Map(tools.map(t => [t.name(), t]))
    return {
      get: (name: string) => map.get(name) ?? null,
      listDefinitions: () =>
        tools.map(t => ({
          name: t.name(),
          description: t.description(),
          parameters: t.parametersSchema(),
        })),
      register: () => {},
    }
  }

  /** The context manager of every run: passthrough unless E7 is armed. */
  private contextManager(run: Run): ContextManager {
    return {
      manage: (messages, conversation, options) => {
        const armed = this.compactArmed
        if (!armed) return messages
        this.compactArmed = null
        if (armed === 'cut') {
          const kept = new InLoopContextManager(0, 1).manage(messages, conversation, options)
          // R-06: a turn the cut archived leaves with its message (and its blob).
          const keptCalls = new Set(kept.flatMap(m => (m.tool_calls ?? []).map(c => c.id)))
          const survivors = run.lineage.filter(t => t.callIds.every(id => keptCalls.has(id)))
          if (survivors.length < run.lineage.length) trace('cut:archived-a-tool-turn')
          run.lineage.splice(0, run.lineage.length, ...survivors)
          return kept
        }
        const pruned = prePrune(messages, {
          protectedTailTurns: 0,
          summaryThresholdTokens: 200,
          maxArgsBytes: 8,
          dedupEnabled: false,
          oneLineSummariesEnabled: false,
          jsonSafeTruncateEnabled: true,
          stripMediaEnabled: false,
        }).messages
        validateToolLinkages(pruned)
        // E7b: every argument here is over 8 bytes, so every pushed turn changed.
        for (const turn of run.lineage) turn.tainted = true
        return pruned
      },
    }
  }

  // ── SDK boundary ───────────────────────────────────────────────

  private park(
    label: string,
    kind: 'responses' | 'chat',
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const run = this.run!
    const record: SdkRecord = {
      seq: ++this.seq,
      runId: run.id,
      logical: this.current!,
      label,
      kind,
      payload: structuredClone(payload),
      lineage: run.lineage.map(t => ({
        ...t,
        callIds: [...t.callIds],
        layoutShape: t.layoutShape,
      })),
      outcome: 'pending',
    }
    this.records.push(record)
    return new Promise((resolve, reject) => {
      const parked: Parked = { label, record, resolve }
      this.pending.push(parked)
      const onAbort = () => {
        const i = this.pending.indexOf(parked)
        if (i >= 0) this.pending.splice(i, 1)
        if (record.outcome === 'pending') record.outcome = 'aborted'
        reject(new OpenAI.APIUserAbortError())
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private take(): Parked {
    const parked = this.pending.shift()
    if (!parked) throw new Error('no pending SDK call')
    return parked
  }

  private answer(parked: Parked, raw: unknown) {
    parked.record.outcome = 'answered'
    parked.resolve(this.compete('sdk', Promise.resolve(deepFreeze(raw))))
  }

  private fail(parked: Parked, error: unknown) {
    parked.record.outcome = 'failed'
    parked.resolve(
      this.compete('sdk', Promise.resolve()).then(() => {
        throw error
      })
    )
  }

  /**
   * Hands a boundary answer to the scheduler, which decides when it lands
   * relative to everything else in flight (H3/H4/H5/H7), and records the order
   * the send and the concurrent moderation of one logical call resolved in.
   */
  private compete<T>(kind: 'sdk' | 'moderate' | 'hook' | 'foreign', value: Promise<T>): Promise<T> {
    const logical = this.current?.id
    const scheduled = this.s.schedule(value, kind)
    this.maxScheduled = Math.max(this.maxScheduled, this.s.count())
    if (logical !== undefined && (kind === 'sdk' || kind === 'moderate')) {
      void scheduled.then(
        () => this.landed(logical, kind),
        () => this.landed(logical, kind)
      )
    }
    return scheduled
  }

  private landed(logical: number, kind: 'sdk' | 'moderate') {
    const first = this.firstLanded.get(logical)
    if (first === undefined) this.firstLanded.set(logical, kind)
    else if (first !== kind) ORDERS[`${first}-before-${kind}` as keyof typeof ORDERS]++
  }

  // ── hook transport ─────────────────────────────────────────────

  private hookAnswer(point: string, body: Record<string, unknown>): unknown {
    if (point === 'pre_call') {
      const mode = this.patchArmed
      if (!mode) return { action: 'continue' }
      this.patchArmed = null
      this.current!.patched = true
      const messages = (body.messages as Record<string, unknown>[]).map(m =>
        mode === 'forge' && m.role === 'assistant' && Array.isArray(m.tool_calls)
          ? { ...m, provider_continuation: this.forged(m) }
          : m
      )
      return { action: 'continue', patch: { messages } }
    }
    if (point === 'post_call') {
      const mode = this.postMode
      if (!mode) return {}
      this.postMode = null
      const response = body.response as { tool_calls?: unknown[] | null }
      if (mode === 'redact') return { response: { ...response, content: '[redacted]' } }
      const calls = response.tool_calls ?? []
      return {
        response: { ...response, tool_calls: mode === 'dropAll' ? [] : calls.slice(0, -1) },
      }
    }
    return {}
  }

  /**
   * The strongest forgery a hook could send: the primary's real owner and a
   * digest computed by the production function over the calls it can see.
   */
  private forged(m: Record<string, unknown>) {
    const calls = m.tool_calls as { id: string; name: string; arguments: Record<string, unknown> }[]
    return {
      owner: {
        provider: 'openai',
        protocol: 'openai-responses',
        model: RESPONSES_MODEL,
        epoch: (this.primary.driver as unknown as { epoch: string }).epoch,
      },
      layout: [
        {
          kind: 'reasoning',
          item: { type: 'reasoning', id: 'rs_forged', summary: [], encrypted_content: 'forged' },
        },
        ...calls.map(c => ({ kind: 'function_call', call_id: c.id, id: `fc_forged_${c.id}` })),
      ],
      digest: continuationDigest(calls, m.content),
    }
  }

  // ── runs ───────────────────────────────────────────────────────

  async startRun(messages: ChatMessage[], lineage: TurnRef[], resumed: boolean): Promise<void> {
    const run: Run = {
      id: ++this.runSeq,
      abort: new AbortController(),
      lineage,
      settled: false,
      aborted: false,
    }
    this.run = run
    const fallbacks = FALLBACK_ROLES.map(() => null as LlmPort | null)
    const failover = maybeWrapFailover({
      primaryPort: this.adapter(this.primary.driver, RESPONSES_MODEL),
      primaryPair: { provider: 'openai', model: RESPONSES_MODEL },
      engine: this.engine,
      policy: POLICY,
      buildFallbackPort: index => {
        const entry = POLICY.fallbacks[index]!
        const role = FALLBACK_ROLES[index]!
        const built = this.newDriver(role, entry.provider as 'openai', entry.model)
        fallbacks[index] = this.adapter(built.driver, entry.model)
        return fallbacks[index]
      },
    })
    const shaper = (request: Parameters<typeof TOKEN_TRIM>[0]) => {
      if (!this.pruneArmed) return request
      this.pruneArmed = false
      this.current!.pruned = true
      return TOKEN_TRIM(request)
    }
    const port = bindTaskSignal(new HookedLlmPort(failover, shaper, this.hooks), run.abort.signal)
    const probe: LlmPort = {
      modelName: () => port.modelName(),
      getTokenCounter: () => port.getTokenCounter!(),
      complete: request => port.complete(request),
      completeWithTools: request => {
        // R-35: nothing below the loop may write to the loop's messages.
        for (const m of request.messages) deepFreeze(m)
        this.current = {
          id: ++this.logicalSeq,
          runId: run.id,
          pruned: false,
          patched: false,
          emptied: false,
        }
        this.logicalCalls.push(this.current)
        return port.completeWithTools(request)
      },
    }
    const config = buildLoopConfig({
      reasoning: new DefaultReasoningPort(
        probe,
        new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
      ),
      toolRegistry: this.tools,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      loopController: new UnifiedApprovalGateController(this.tools),
      contextManager: this.contextManager(run),
      maxIterations: 60,
    })
    config.abortSignal = run.abort.signal
    if (resumed) config.skipContextManager = true
    runToolUseLoop(config, messages).then(
      result => {
        run.settled = true
        run.result = result
      },
      error => {
        run.settled = true
        run.error = error
      }
    )
    await this.settle()
  }

  async freshRun(rebuildPrimary: boolean): Promise<void> {
    // E16: the next task starts from text-only history, maybe on a new instance.
    if (rebuildPrimary) this.primary = this.newDriver('primary', 'openai', RESPONSES_MODEL)
    await this.startRun(
      [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: PROMPT },
      ],
      [],
      false
    )
  }

  /** Waits until the system is at rest: a parked SDK call, or the run ended. */
  async settle(): Promise<void> {
    let idle = 0
    for (let spin = 0; spin < 5_000; spin++) {
      await tick()
      if (this.pending.length > 0) {
        // The parked send stays in competition with what is still scheduled
        // (moderation, another session): the next command's answer joins it.
        for (let i = 0; i < 10; i++) await tick()
        return
      }
      if (this.s.count() > 0) {
        idle = 0
        await this.s.waitOne()
        continue
      }
      const run = this.run
      if (!run) return
      if (run.settled) {
        await this.onRunEnd(run)
        return
      }
      // Only a timer is left (the loop's retry delay, E6): let it fire.
      if (++idle > 20 && vi.getTimerCount() > 0) {
        idle = 0
        await vi.advanceTimersToNextTimerAsync()
      }
    }
    throw new Error('system never came to rest')
  }

  private async onRunEnd(run: Run): Promise<void> {
    if (this.run !== run) return
    this.run = null
    trace(`end:${run.result?.type ?? 'throw'}`)
    if (run.error) throw run.error
    this.checkEnding(run)
    if (run.result?.type !== 'need_approval') return
    this.approvalArmed = false
    await this.persist(run, run.result.approval)
  }

  /**
   * A run ends only for a reason the test caused. An `error` must come from a
   * failure the test injected into the last send (or from an answer a hook
   * emptied), never from something production threw before reaching the SDK.
   */
  private checkEnding(run: Run) {
    const last = this.records.filter(r => r.runId === run.id).at(-1)
    const type = run.result?.type
    const ok =
      type === 'cancelled'
        ? last?.outcome === 'aborted'
        : type === 'error'
          ? last?.outcome === 'failed' || (last?.outcome === 'answered' && last.logical.emptied)
          : last?.outcome === 'answered'
    if (!ok) {
      this.violations.push(
        `run ${run.id} ended '${type}' after its last send was ${last?.outcome ?? 'never made'}`
      )
    }
  }

  /** E12: the approval goes to SQLite exactly as the executor writes it, then is read back. */
  private async persist(run: Run, approval: PendingApproval): Promise<void> {
    this.store ??= makeSqliteStore()
    const sessionKey = `continuity-model-${run.id}`
    const manager = new ConversationManager(this.store.store)
    const conversation = await manager.getOrCreate(sessionKey)
    await manager.startTurn(conversation, PROMPT, `task-${run.id}`)
    // The executor stamps its budget on every pause; the reader requires it.
    approval.task_budget = new TaskExecutionBudget(300_000, 60).pause()
    await manager.suspendForApproval(conversation, approval)
    const s7 = conversation.pending_approval!
    const reread = await new ConversationManager(
      new SqliteConversationStore(this.store.persistQueue, { cacheSize: 8 })
    ).getOrCreate(sessionKey)
    const s8 = reread.pending_approval!
    this.checkSnapshot(s7.context_snapshot, s8.context_snapshot)
    const toolMessages = (completed: typeof s7.completed_results) =>
      (completed ?? []).map(r => ({
        role: 'tool' as const,
        content: r.content,
        tool_call_id: r.tool_call_id,
        name: r.name,
      }))
    deepFreeze(s7)
    deepFreeze(s8)
    this.suspension = {
      run,
      approval: s7,
      warm: [...s7.context_snapshot, ...toolMessages(s7.completed_results)],
      cold: [...s8.context_snapshot, ...toolMessages(s8.completed_results)],
    }
  }

  async resume(mode: 'warm' | 'cold'): Promise<void> {
    const suspension = this.suspension!
    this.suspension = null
    if (mode === 'cold') {
      // E14: another process — a new primary instance and a new engine.
      this.engine = this.newEngine()
      this.primary = this.newDriver('primary', 'openai', RESPONSES_MODEL)
    }
    const { approval } = suspension
    const tool = this.tools.get(approval.tool_name)!
    const output = await tool.execute(approval.parameters)
    const messages: ChatMessage[] = [
      ...(mode === 'warm' ? suspension.warm : suspension.cold),
      {
        role: 'tool',
        content: output.content,
        tool_call_id: approval.tool_call_id,
        name: approval.tool_name,
      },
    ]
    validateToolLinkages(messages)
    await this.startRun(messages, suspension.run.lineage, true)
  }

  // ── commands ───────────────────────────────────────────────────

  phase(): 'pending' | 'suspended' | 'idle' {
    if (this.pending.length > 0) return 'pending'
    return this.suspension ? 'suspended' : 'idle'
  }

  pendingRole(): Role {
    return this.pending[0]!.label.split('#')[0] as Role
  }

  async respondToolCall(shape: ToolShape): Promise<void> {
    const parked = this.take()
    const run = this.run!
    const turnId = ++this.turnSeq
    const responses = parked.record.kind === 'responses'
    const output = responses ? relabelResponses(recordedResponse(TOOL_SHAPES[shape]), turnId) : null
    const chat = responses ? null : relabelChat(CHAT_TOOLS, turnId)
    const raw: unknown = output ?? chat
    const outputItems: Item[] = output?.output ?? []
    let callIds = output
      ? outputItems.filter(o => o.type === 'function_call').map(o => o.call_id as string)
      : chat!.choices[0]!.message.tool_calls.map(c => c.id)
    const hasMessage = output
      ? outputItems.some(o => o.type === 'message')
      : chat!.choices[0]!.message.content != null
    let tainted = false
    // E21: what the pending post_call substitute does to the pushed message.
    if (this.postMode === 'dropAll' || (this.postMode === 'dropCall' && callIds.length < 2)) {
      parked.record.logical.emptied = true
      callIds = []
    } else if (this.postMode === 'dropCall') {
      callIds = callIds.slice(0, -1)
      tainted = true
    } else if (this.postMode === 'redact' && !hasMessage) {
      tainted = true
    }
    for (const o of outputItems) {
      if (o.type === 'reasoning') this.delivered.set(o.id as string, o.encrypted_content as string)
    }
    if (callIds.length > 0) {
      const turn: TurnRef = {
        id: turnId,
        producer: parked.label,
        responses,
        callIds,
        layoutShape: outputItems.map(o => ({ type: o.type, id: o.id })),
        tainted,
      }
      run.lineage.push(turn)
      for (const id of callIds) this.turnByCall.set(id, turn)
      for (const o of outputItems) {
        if (o.type === 'reasoning') this.turnByReasoning.set(o.id as string, turn)
      }
    }
    this.answer(parked, raw)
    await this.settle()
  }

  async finish(): Promise<void> {
    const parked = this.take()
    const n = ++this.turnSeq
    const raw =
      parked.record.kind === 'responses'
        ? relabelResponses(recordedResponse('v1-text-gpt-6.1-terra'), n)
        : CHAT_TEXT
    if (parked.record.kind === 'responses') {
      for (const o of raw.output as Item[]) {
        if (o.type === 'reasoning')
          this.delivered.set(o.id as string, o.encrypted_content as string)
      }
    }
    this.answer(parked, raw)
    await this.settle()
  }

  /** E4/E5: 429 on every attempt of this call until `target` is the one in flight. */
  async failTo(target: Role): Promise<void> {
    const logical = this.pending[0]!.record.logical
    for (let i = 0; i < MAX_ATTEMPTS_PER_CALL; i++) {
      this.fail(this.take(), rateLimited())
      await this.settle()
      if (this.pending.length === 0 || this.pending[0]!.record.logical !== logical) return
      if (this.pendingRole() === target) return
    }
  }

  /** E6: a transport failure is no failover trigger; the loop retries once. */
  async retry(): Promise<void> {
    this.fail(this.take(), new OpenAI.APIConnectionError({ message: 'socket hang up' }))
    await this.settle()
  }

  async abort(): Promise<void> {
    const run = this.run!
    run.aborted = true
    const recordsAtAbort = this.records.filter(r => r.runId === run.id).length
    const toolsAtAbort = this.toolRuns.filter(id => id === run.id).length
    run.abort.abort()
    await this.settle()
    // I9: an abort during the send leaves no second send and runs no tool.
    if (this.records.filter(r => r.runId === run.id).length !== recordsAtAbort) {
      this.violations.push(`I9: run ${run.id} sent again after its abort`)
    }
    if (this.toolRuns.filter(id => id === run.id).length !== toolsAtAbort) {
      this.violations.push(`I9: run ${run.id} executed a tool after its abort`)
    }
    if (run.result?.type !== 'cancelled') {
      this.violations.push(`I9: run ${run.id} ended ${run.result?.type} after its abort`)
    }
  }

  recoverPrimary(): void {
    this.clock += (COOLDOWN_SECONDS + 1) * 1000
  }

  /** E4 of another session: a 429 on the shared primary, or a credential fix clearing it. */
  async foreignCooldown(op: 'set' | 'clear'): Promise<void> {
    if (op === 'clear') {
      this.engine.clearCooldown()
      return
    }
    const foreign = this.engine.run(
      { provider: 'openai', model: RESPONSES_MODEL },
      target => () =>
        this.compete('foreign', Promise.resolve()).then(() => {
          if (target.kind === 'primary') {
            throw new LlmError('rate limited', 'openai', LlmErrorCode.RateLimited, true)
          }
          return 'served'
        }),
      err =>
        err instanceof LlmError
          ? { code: err.code as LlmErrorCode, retryable: err.retryable }
          : null
    )
    foreign.catch(() => {})
    await this.settle()
  }

  armPrune() {
    this.pruneArmed = true
  }
  armPatch(forge: boolean) {
    this.patchArmed = forge ? 'forge' : 'echo'
  }
  armPost(mode: 'redact' | 'dropCall' | 'dropAll') {
    this.postMode = mode
  }
  armCompact(mode: 'cut' | 'prune') {
    this.compactArmed = mode
  }
  armApproval() {
    this.approvalArmed = true
  }

  async shutdown(): Promise<void> {
    while (this.pending.length > 0) await this.finish()
    await this.store?.shutdown()
  }

  // ── invariants at rest ─────────────────────────────────────────

  /** I15 and D-snap on the approval snapshot, in memory (S7) and persisted (S8). */
  private checkSnapshot(s7: ChatMessage[], s8: ChatMessage[]) {
    for (const [i, m] of s8.entries()) {
      const c = m.provider_continuation
      if (!c) continue
      const bytes = Buffer.byteLength(
        JSON.stringify(c.layout.filter(e => e.kind === 'reasoning').map(e => e.item)),
        'utf8'
      )
      if (bytes > 256 * 1024) {
        this.violations.push(`I15: snapshot message ${i} carries ${bytes} bytes of reasoning`)
      }
      if (JSON.stringify(s7[i]?.provider_continuation) !== JSON.stringify(c)) {
        this.violations.push(`D-snap: snapshot message ${i} differs between memory and SQLite`)
      }
    }
  }

  checkAtRest(): void {
    for (const record of this.records.slice(this.checked)) this.checkRecord(record)
    this.checked = this.records.length
    for (const { point, raw } of this.hookBodies.slice(this.checkedHooks)) {
      // I11: no projection to a hook carries opaque provider state, by key or by value.
      if (/provider_continuation|encrypted_content|"rs_/.test(raw) || this.carriesBlob(raw)) {
        this.violations.push(`I11: a ${point} hook body carries continuity`)
      }
    }
    this.checkedHooks = this.hookBodies.length
    // E9 really happened: every logical call reached its pre_call and moderate
    // hooks once. A projection that throws is swallowed by the fail-open hook,
    // which would otherwise hide a write to the frozen history (R-35).
    for (const call of this.logicalCalls) {
      const hooks = (point: string) =>
        this.hookBodies.filter(b => b.logical === call.id && b.point === point).length
      for (const point of ['pre_call', 'moderate']) {
        const n = hooks(point)
        if (n !== 1) this.violations.push(`E9: logical call ${call.id} reached ${point} ${n} times`)
      }
      const sends = this.records.filter(r => r.logical === call)
      const last = sends.at(-1)
      // on_error sees the call once when its last attempt failed, never on success.
      const onError = hooks('on_error')
      if (
        (last?.outcome === 'failed' && onError !== 1) ||
        (last?.outcome === 'answered' && onError !== 0)
      ) {
        this.violations.push(`E9: logical call ${call.id} reached on_error ${onError} times`)
      }
      // Every logical call reaches the SDK: nothing below the loop may fail it first.
      if (sends.length === 0) {
        this.violations.push(`I13: logical call ${call.id} never reached the SDK`)
        continue
      }
      // I14: one send, plus exactly one more per failure the test injected
      // (each is a failover attempt); the continuity adds none.
      const injected = sends.filter(r => r.outcome === 'failed').length
      const expected = last!.outcome === 'failed' ? injected : injected + 1
      if (sends.length !== expected || sends.slice(0, -1).some(r => r.outcome !== 'failed')) {
        this.violations.push(
          `I14: logical call ${call.id} sent ${sends.length} times for ${injected} injected failures`
        )
      }
      if (sends.length > MAX_ATTEMPTS_PER_CALL) {
        this.violations.push(`I14: logical call ${call.id} sent more than its targets`)
      }
    }
  }

  /** Whether `serialized` carries any reasoning blob the API delivered, by value. */
  private carriesBlob(serialized: string, allowedProducer?: string): boolean {
    for (const [id, blob] of this.delivered) {
      if (!serialized.includes(blob)) continue
      if (allowedProducer === undefined) return true
      if (this.turnByReasoning.get(id)?.producer !== allowedProducer) return true
    }
    return false
  }

  private checkRecord(r: SdkRecord): void {
    const where = `request ${r.seq} (${r.label})`
    trace(`sdk:${r.label.split('#')[0]}`)
    const expectedCalls = r.lineage.flatMap(t => t.callIds)
    const byCall = new Map(r.lineage.flatMap(t => t.callIds.map(id => [id, t] as const)))

    if (r.kind === 'chat') {
      const raw = JSON.stringify(r.payload)
      // I6′: no Chat request carries the field or any provider item.
      if (
        /provider_continuation|encrypted_content|"reasoning"|"rs_|"fc_/.test(raw) ||
        this.carriesBlob(raw)
      ) {
        this.violations.push(`I6′: ${where} (Chat) carries continuity`)
      }
      const messages = r.payload.messages as Record<string, unknown>[]
      const calls = messages.flatMap(m =>
        Array.isArray(m.tool_calls) ? (m.tool_calls as { id: string }[]).map(c => c.id) : []
      )
      const outputs = messages.filter(m => m.role === 'tool').map(m => m.tool_call_id as string)
      this.checkCallIds(where, calls, outputs, expectedCalls)
      return
    }

    const input = r.payload.input as Item[]
    // I6′ by value: a blob only ever travels back to the instance that produced it.
    if (this.carriesBlob(JSON.stringify(r.payload), r.label)) {
      this.violations.push(`I6′: ${where} carries a blob another instance produced`)
    }
    const calls = input.filter(i => i.type === 'function_call').map(i => i.call_id as string)
    const outputs = input
      .filter(i => i.type === 'function_call_output')
      .map(i => i.call_id as string)
    this.checkCallIds(where, calls, outputs, expectedCalls)

    for (const item of input) {
      if (item.type !== 'reasoning') continue
      // I12: every reasoning item sent is one the API delivered, unchanged.
      if (this.delivered.get(item.id as string) !== item.encrypted_content) {
        this.violations.push(
          `I12: ${where} carries reasoning ${String(item.id)} no decode produced`
        )
      }
    }

    for (const group of assistantGroups(input)) {
      const replayed = group.items.some(i => i.type === 'reasoning' || i.id !== undefined)
      if (group.callIds.length === 0) {
        if (replayed) this.violations.push(`I16: ${where} replays items with no call`)
        continue
      }
      const turn = byCall.get(group.callIds[0]!)
      if (!turn) {
        this.violations.push(`I3: ${where} carries call ${group.callIds[0]} no turn pushed`)
        continue
      }
      if (group.callIds.join() !== turn.callIds.join()) {
        this.violations.push(`I3: ${where} regrouped the calls of turn ${turn.id}`)
      }
      if (replayed) {
        // I16: all or nothing, in the recorded order with the recorded ids.
        const shape = group.items.map(i => ({ type: i.type, id: i.id }))
        if (JSON.stringify(shape) !== JSON.stringify(turn.layoutShape)) {
          this.violations.push(
            `I16: ${where} turn ${turn.id} replays ${JSON.stringify(shape)}, recorded ${JSON.stringify(turn.layoutShape)}`
          )
        }
        // I6′: reasoning only goes back to the instance that produced it.
        if (turn.producer !== r.label) {
          this.violations.push(`I6′: ${where} replays turn ${turn.id} of ${turn.producer}`)
        }
        for (const i of group.items) {
          if (i.type === 'reasoning' && this.turnByReasoning.get(i.id as string)?.id !== turn.id) {
            this.violations.push(
              `I6′: ${where} attaches reasoning ${String(i.id)} to turn ${turn.id}`
            )
          }
        }
      }
      // I13: the owner's untouched turns are replayed on every request it sends.
      const expected =
        turn.responses &&
        turn.producer === r.label &&
        !turn.tainted &&
        !r.logical.pruned &&
        !r.logical.patched
      trace(`replay:${expected ? 'expected' : 'not-expected'}:${replayed}`)
      if (expected && !replayed) {
        this.violations.push(`I13: ${where} dropped the continuity of turn ${turn.id}`)
      }
      // I16: an altered turn (E7b, E8, E10, E21) leaves with no reasoning and no id.
      if (!expected && replayed && turn.producer === r.label) {
        this.violations.push(`I16: ${where} replays turn ${turn.id} after it was altered`)
      }
    }
  }

  /** I3: every output answers a pushed call and no pushed call is lost. */
  private checkCallIds(where: string, calls: string[], outputs: string[], expected: string[]) {
    const sorted = (ids: string[]) => [...ids].sort().join()
    if (new Set(calls).size !== calls.length) this.violations.push(`I3: ${where} repeats a call`)
    if (sorted(calls) !== sorted(expected)) {
      this.violations.push(
        `I3: ${where} sends calls [${calls}] where the loop pushed [${expected}]`
      )
    }
    if (sorted(outputs) !== sorted(expected)) {
      this.violations.push(
        `I3: ${where} sends outputs [${outputs}] where the loop pushed [${expected}]`
      )
    }
  }
}

function rateLimited(): unknown {
  return openaiApiError(429, {
    code: 'rate_limit_exceeded',
    type: 'requests',
    message: 'Rate limit reached.',
  })
}

/** Relabels the ids of a recording so each turn's ids are unique; nothing else changes. */
function relabelResponses(recorded: Item, turn: number) {
  const raw = structuredClone(recorded) as Item & { output: Item[] }
  raw.output.forEach((item, i) => {
    if (typeof item.id === 'string') item.id = `${item.id.split('_')[0]}_t${turn}x${i}`
    if (typeof item.call_id === 'string') item.call_id = `call_t${turn}x${i}`
    if (typeof item.encrypted_content === 'string') {
      item.encrypted_content = `${item.encrypted_content}:t${turn}x${i}`
    }
  })
  return raw
}

function relabelChat(recorded: unknown, turn: number) {
  const raw = structuredClone(recorded) as {
    choices: { message: { content: unknown; tool_calls: { id: string }[] } }[]
  }
  raw.choices[0]!.message.tool_calls.forEach((c, i) => {
    c.id = `call_t${turn}x${i}`
  })
  return raw
}

/** The assistant turns of a Responses input: maximal runs of assistant-side items. */
function assistantGroups(input: Item[]): { items: Item[]; callIds: string[] }[] {
  const groups: { items: Item[]; callIds: string[] }[] = []
  let current: Item[] | null = null
  for (const item of input) {
    const assistantSide =
      item.type === 'reasoning' ||
      item.type === 'function_call' ||
      (item.type === 'message' && item.role === 'assistant')
    if (!assistantSide) {
      current = null
      continue
    }
    if (!current) {
      current = []
      groups.push({ items: current, callIds: [] })
    }
    current.push(item)
  }
  for (const g of groups) {
    g.callIds = g.items.filter(i => i.type === 'function_call').map(i => i.call_id as string)
  }
  return groups
}

// ─── Commands ─────────────────────────────────────────────────────

interface Model {
  phase: 'pending' | 'suspended' | 'idle'
}

type Cmd = fc.AsyncCommand<Model, World>

function command(
  name: string,
  when: (m: Model) => boolean,
  act: (w: World) => Promise<void> | void
): Cmd {
  return {
    check: m => when(m),
    run: async (m, w) => {
      trace(name.split('(')[0]!)
      await act(w)
      // Per-command check over boundary captures; `moderate` may still be
      // scheduled here. The strict at-rest evaluation (A4) is the final one
      // in runModel, after shutdown.
      w.checkAtRest()
      m.phase = w.phase()
      expect(w.violations, `after ${name}`).toEqual([])
    },
    toString: () => name,
  }
}

const pending = (m: Model) => m.phase === 'pending'
const always = () => true

const respond = fc
  .constantFrom(...(Object.keys(TOOL_SHAPES) as ToolShape[]))
  .map(shape => command(`respondToolCall(${shape})`, pending, w => w.respondToolCall(shape)))
const interleaved = fc
  .constantFrom(...INTERLEAVED)
  .map(shape => command(`interleaved(${shape})`, pending, w => w.respondToolCall(shape)))
const finish = fc.constant(command('finish', pending, w => w.finish()))
const prePruneCmd = fc.constant(command('prePrune', always, w => w.armPrune()))
const hookPatch = fc
  .boolean()
  .map(forge => command(`hookPatch(forge=${forge})`, always, w => w.armPatch(forge)))
const hookPostSubstitute = fc
  .constantFrom('redact' as const, 'dropCall' as const)
  .map(mode => command(`hookPostSubstitute(${mode})`, always, w => w.armPost(mode)))
const mistakenTrigger = fc.constantFrom(...(Object.keys(TOOL_SHAPES) as ToolShape[])).map(shape =>
  command(`mistakenTrigger(${shape})`, pending, w => {
    w.armPost('dropAll')
    return w.respondToolCall(shape)
  })
)
const suspend = fc.constant(command('suspend', always, w => w.armApproval()))
const resumeWarm = fc.constant(
  command(
    'resumeWarm',
    m => m.phase === 'suspended',
    w => w.resume('warm')
  )
)
const resumeCold = fc.constant(
  command(
    'resumeCold',
    m => m.phase === 'suspended',
    w => w.resume('cold')
  )
)
const compactCut = fc
  .constantFrom('cut' as const, 'prune' as const)
  .map(mode => command(`compactCut(${mode})`, always, w => w.armCompact(mode)))
const retry = fc.constant(command('retry', pending, w => w.retry()))
const abort = fc.constant(command('abort', pending, w => w.abort()))
const newTurn = fc.boolean().map(rebuild =>
  command(
    `newTurn(rebuildPrimary=${rebuild})`,
    m => m.phase === 'idle',
    w => w.freshRun(rebuild)
  )
)
const failTo = fc
  .constantFrom('otherModel' as const, 'compat' as const)
  .map(target => command(`failTo(${target})`, pending, w => w.failTo(target)))
const sameProviderOtherKey = fc.constant(
  command('sameProviderOtherKey', pending, w => w.failTo('sameKey'))
)
const recoverPrimary = fc.constant(command('recoverPrimary', always, w => w.recoverPrimary()))
const foreignCooldown = fc
  .constantFrom('set' as const, 'clear' as const)
  .map(op => command(`foreignCooldown(${op})`, always, w => w.foreignCooldown(op)))

const NUM_RUNS = Number(process.env.CONTINUITY_MODEL_RUNS ?? 400)
// Each property takes ~1 s alone and ~3 s inside the full suite; the default
// 5 s would flake on a slower runner and rule out deeper runs.
const PROPERTY_TIMEOUT_MS = Math.max(30_000, NUM_RUNS * 25)
/** Replays a reported failure: `CONTINUITY_MODEL_SEED` and `CONTINUITY_MODEL_PATH` from its report. */
const REPLAY: fc.Parameters<unknown> = process.env.CONTINUITY_MODEL_SEED
  ? {
      seed: Number(process.env.CONTINUITY_MODEL_SEED),
      path: process.env.CONTINUITY_MODEL_PATH,
      endOnFailure: true,
    }
  : {}

async function runModel(s: fc.Scheduler, commands: Iterable<Cmd>): Promise<void> {
  const world = new World(s)
  let failure: unknown
  try {
    await world.freshRun(false)
    await fc.asyncModelRun(() => ({ model: { phase: world.phase() }, real: world }), commands)
  } catch (err) {
    failure = err
  }
  try {
    await world.shutdown()
  } catch (err) {
    // A violated state can leave the system unable to settle; the shutdown
    // error must not replace the counterexample fast-check has to shrink.
    if (failure === undefined) failure = err
  }
  maxScheduled = Math.max(maxScheduled, world.maxScheduled)
  if (failure !== undefined) throw failure
  world.checkAtRest()
  expect(world.violations).toEqual([])
}

/**
 * The scheduler must really have chosen: two answers in flight together, and
 * both orders of a send against its concurrent moderation (H3/H5/H7). This
 * assumes production runs `moderate` in parallel with the send; if it ever
 * serializes them, this coverage check goes red without a continuity bug.
 */
async function assertModel(property: fc.IAsyncProperty<[fc.Scheduler, Iterable<Cmd>]>) {
  maxScheduled = 0
  ORDERS['sdk-before-moderate'] = 0
  ORDERS['moderate-before-sdk'] = 0
  await fc.assert(property, { numRuns: NUM_RUNS, ...REPLAY })
  trace(`max-scheduled:${maxScheduled}`)
  expect(maxScheduled).toBeGreaterThanOrEqual(2)
  expect(ORDERS['sdk-before-moderate']).toBeGreaterThan(0)
  expect(ORDERS['moderate-before-sdk']).toBeGreaterThan(0)
}

const savedLogLevel = process.env.LOG_LEVEL

beforeAll(() => {
  // Thousands of loop iterations: the service log would drown a failure report.
  process.env.LOG_LEVEL = 'silent'
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterAll(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (savedLogLevel === undefined) delete process.env.LOG_LEVEL
  else process.env.LOG_LEVEL = savedLogLevel
})

describe('Responses continuity against a reference model (A6)', () => {
  it(
    'T-P1 call_id mapping and replay on the official driver (I3, I11–I13, I15, I16)',
    async () => {
      await assertModel(
        fc.asyncProperty(
          fc.scheduler(),
          fc.commands(
            [
              respond,
              respond,
              respond,
              respond,
              interleaved,
              finish,
              prePruneCmd,
              hookPatch,
              hookPostSubstitute,
              mistakenTrigger,
              suspend,
              resumeWarm,
              resumeWarm,
              resumeCold,
              resumeCold,
              compactCut,
              retry,
              abort,
              newTurn,
              newTurn,
            ],
            { maxCommands: 40, size: 'max' }
          ),
          runModel
        )
      )
    },
    PROPERTY_TIMEOUT_MS
  )

  it(
    'T-P2 owner across model switch, failover to a compatible and back, and another key (I6′)',
    async () => {
      await assertModel(
        fc.asyncProperty(
          fc.scheduler(),
          fc.commands(
            [
              respond,
              respond,
              respond,
              respond,
              interleaved,
              finish,
              failTo,
              failTo,
              sameProviderOtherKey,
              recoverPrimary,
              recoverPrimary,
              foreignCooldown,
              hookPatch,
              hookPostSubstitute,
              suspend,
              resumeWarm,
              resumeWarm,
              resumeCold,
              resumeCold,
              retry,
              abort,
              newTurn,
              newTurn,
            ],
            { maxCommands: 40, size: 'max' }
          ),
          runModel
        )
      )
    },
    PROPERTY_TIMEOUT_MS
  )
})

// ─── A3 scenarios: one per row, asserting the request at the SDK boundary ───

/** Resolves every scheduled promise in creation order: one fixed interleaving. */
const IN_ORDER: Pick<fc.Scheduler, 'schedule' | 'count' | 'waitOne'> = {
  schedule: <T>(p: PromiseLike<T>) => Promise.resolve(p),
  count: () => 0,
  waitOne: async () => {},
}

async function scenario(steps: (w: World) => Promise<void>): Promise<World> {
  const world = new World(IN_ORDER)
  try {
    await world.freshRun(false)
    await steps(world)
  } finally {
    await world.shutdown()
  }
  world.checkAtRest()
  expect(world.violations).toEqual([])
  return world
}

const role = (r: SdkRecord) => r.label.split('#')[0] as Role
const inputOf = (r: SdkRecord) => r.payload.input as Item[]
const reasoningIds = (r: SdkRecord) =>
  inputOf(r)
    .filter(i => i.type === 'reasoning')
    .map(i => i.id)
const itemIds = (r: SdkRecord) =>
  inputOf(r)
    .map(i => i.id)
    .filter(id => id !== undefined)
const callIdsOf = (r: SdkRecord) =>
  r.kind === 'responses'
    ? inputOf(r)
        .filter(i => i.type === 'function_call')
        .map(i => i.call_id)
    : (r.payload.messages as { tool_calls?: { id: string }[] }[]).flatMap(m =>
        (m.tool_calls ?? []).map(c => c.id)
      )

describe('A3 scenarios on the real stack', () => {
  it('R-01 (T-P1, T-P2) the request after a tool turn replays its reasoning before the call', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
    })
    const [, next] = w.records
    expect(reasoningIds(next!)).toEqual(['rs_t1x0'])
    expect(
      inputOf(next!)
        .slice(-3)
        .map(i => i.type)
    ).toEqual(['reasoning', 'function_call', 'function_call_output'])
  })

  it('R-02 (T-P2) the same request failed over to another Responses model and to a compatible carries no continuity', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      await w.failTo('compat')
    })
    const attempts = w.records.filter(r => r.logical === w.records[1]!.logical)
    expect(attempts.map(role)).toEqual(['primary', 'otherModel', 'compat'])
    expect(reasoningIds(attempts[0]!)).toEqual(['rs_t1x0'])
    expect(reasoningIds(attempts[1]!)).toEqual([])
    expect(itemIds(attempts[1]!)).toEqual([])
    expect(JSON.stringify(attempts[2]!.payload)).not.toMatch(/provider_continuation|encrypted/)
    for (const a of attempts) expect(callIdsOf(a)).toEqual(['call_t1x1'])
  })

  it('R-03 (T-P2, A→B→A) the primary gets its own items back and none of the fallback', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc') // A
      await w.failTo('otherModel')
      await w.respondToolCall('rfcParallel') // B
      w.recoverPrimary()
      await w.respondToolCall('fc') // B again, the cooldown has expired
    })
    const back = w.records.filter(r => role(r) === 'primary').at(-1)!
    expect(back.seq).toBe(w.records.at(-1)!.seq)
    expect(reasoningIds(back)).toEqual(['rs_t1x0'])
    expect(itemIds(back)).toEqual(['rs_t1x0', 'fc_t1x1'])
    expect(callIdsOf(back)).toEqual(['call_t1x1', 'call_t2x1', 'call_t2x2', 'call_t3x0'])
  })

  it('R-04 (T-P2 sameProviderOtherKey) a fallback with another key never receives the blob', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      await w.failTo('sameKey')
    })
    const sameKey = w.records.find(r => role(r) === 'sameKey')!
    expect(sameKey.lineage.map(t => t.producer)).toEqual(['primary#1'])
    expect(reasoningIds(sameKey)).toEqual([])
    expect(itemIds(sameKey)).toEqual([])
  })

  it('R-05 (T-E2, I14) a transport retry resends the same replay once', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      await w.retry()
    })
    const [, first, second] = w.records
    expect(w.records).toHaveLength(3)
    expect(second!.logical).not.toBe(first!.logical)
    // The system prompt carries the current time; everything else is resent as is.
    const conversation = (r: SdkRecord) => inputOf(r).filter(i => i.role !== 'system')
    expect(conversation(second!)).toEqual(conversation(first!))
    expect(reasoningIds(second!)).toEqual(['rs_t1x0'])
  })

  it('R-06 (T-P1 compactCut) a cut that archives a tool turn takes its blob and outputs with it', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      // An empty answer after the tool result makes the loop add a user nudge,
      // the only way a later cut can reach a tool turn of the same run.
      w.armPost('dropAll')
      await w.respondToolCall('rfc')
      w.armCompact('cut')
      await w.respondToolCall('fc')
    })
    const beforeCut = w.records[2]!
    const afterCut = w.records[3]!
    expect(reasoningIds(beforeCut)).toEqual(['rs_t1x0'])
    expect(inputOf(beforeCut).at(-1)).toMatchObject({ type: 'message', role: 'user' })
    expect(callIdsOf(afterCut)).toEqual(['call_t3x0'])
    expect(reasoningIds(afterCut)).toEqual([])
    expect(
      inputOf(afterCut)
        .filter(i => i.type === 'function_call_output')
        .map(i => i.call_id)
    ).toEqual(['call_t3x0'])
  })

  it('R-08 (T-P1 prePrune) token-trim takes the replay from one request only', async () => {
    const w = await scenario(async w => {
      w.armPrune()
      await w.respondToolCall('rfc')
      await w.respondToolCall('fc')
    })
    const [, pruned, after] = w.records
    expect(pruned!.logical.pruned).toBe(true)
    expect(reasoningIds(pruned!)).toEqual([])
    expect(itemIds(pruned!)).toEqual([])
    expect(reasoningIds(after!)).toEqual(['rs_t1x0'])
    expect(itemIds(after!)).toEqual(['rs_t1x0', 'fc_t1x1', 'fc_t2x0'])
  })

  it('R-08b (T-P1 pressurePrune) the context manager prune takes it for every later request', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      w.armCompact('prune')
      await w.respondToolCall('fc')
      await w.respondToolCall('fc')
    })
    const [, before, pruned, after] = w.records
    expect(reasoningIds(before!)).toEqual(['rs_t1x0'])
    expect(itemIds(pruned!)).toEqual([])
    expect(reasoningIds(after!)).toEqual([])
    expect(itemIds(after!)).not.toContain('fc_t1x1')
  })

  it('R-16 (T-P1 mistakenTrigger) a tool turn discarded without a push leaves no orphan call', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      w.armPost('dropAll')
      await w.respondToolCall('rfcParallel')
    })
    for (const r of w.records) {
      expect(callIdsOf(r)).not.toContain('call_t2x1')
      expect(reasoningIds(r)).not.toContain('rs_t2x0')
    }
  })

  it('R-17 (T-P2, per turn) the next task replays nothing of the previous one', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      await w.finish()
      await w.freshRun(false)
    })
    const first = w.records.find(r => r.runId === 2)!
    expect(callIdsOf(first)).toEqual([])
    expect(itemIds(first)).toEqual([])
  })

  it('R-18 (T-P2 foreignCooldown) another session cools the primary down mid-call; the filter still runs per attempt', async () => {
    const w = await scenario(async w => {
      await w.respondToolCall('rfc')
      await w.foreignCooldown('set')
      await w.respondToolCall('fc') // served by the primary, already in flight
      await w.foreignCooldown('clear')
      await w.respondToolCall('fc') // served by otherModel
    })
    const roles = w.records.map(role)
    expect(roles).toEqual(['primary', 'primary', 'otherModel', 'primary'])
    expect(reasoningIds(w.records[2]!)).toEqual([])
    expect(itemIds(w.records[2]!)).toEqual([])
    expect(reasoningIds(w.records[3]!)).toEqual(['rs_t1x0'])
  })
})
