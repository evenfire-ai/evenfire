/**
 * Core interfaces for the Clerum agent architecture.
 *
 * Seven layer boundaries + extension points + supporting types.
 * Each interface represents a clean boundary between architectural layers.
 *
 * Phase 1: Pure interface definitions — no implementations.
 */
import type { TokenCounter } from './tokenizer/tokenCounter'
import {
  AgentEvent,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  Conversation,
  IncomingMessage,
  OutgoingResponse,
  PendingApproval,
  ReasoningContext,
  RespondResult,
  SanitizedOutput,
  StatusUpdate,
  ToolCompletionRequest,
  ToolCompletionResponse,
  ToolDefinition,
  ToolOutput,
  ToolResult,
  ValidationResult,
} from './types'

// ─── LLM Port ───────────────────────────────────────────────

export interface LlmPort {
  complete(request: CompletionRequest): Promise<CompletionResponse>
  completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse>
  modelName(): string
  /**
   * Provider-aware token counter. Optional only for legacy callers in tests
   * that build a minimal `LlmPort`; production wiring (P.2) always provides
   * one. Consumers that need an authoritative pre-flight count call
   * `getTokenCounter()?.count(...)` and fall back to the heuristic when
   * absent.
   */
  getTokenCounter?(): TokenCounter
}

// ─── Reasoning ──────────────────────────────────────────────

export interface ReasoningPort {
  respondWithTools(context: ReasoningContext): Promise<RespondResult>
  continueWithToolResults(context: ReasoningContext, results: ToolResult[]): Promise<RespondResult>
}

export interface ReasoningFactory {
  create(systemPrompt?: string): ReasoningPort
}

// ─── Tool Registry ──────────────────────────────────────────

export interface ToolRegistry {
  get(name: string): Tool | null
  listDefinitions(): ToolDefinition[]
  register(tool: Tool): void
}

export type ToolTraceKind = 'internal_tool' | 'mcp_server_tool' | 'workflow'

export interface ToolTraceDescriptor {
  kind: ToolTraceKind
  sourceRef: string | null
}

/**
 * Passed to Tool.execute() for tools that stream output during execution.
 * Tools that opt in (via supportsProgressOutput() === true) call onOutput()
 * as stdout/stderr chunks become available. The consumer (the tool-use loop's
 * progress watcher) buffers these into a RingBuffer and publishes periodic
 * `tool_progress` SSE events.
 */
export interface ExecutionContext {
  /**
   * Tool calls this as output becomes available (not required to be line-aligned
   * — the ring buffer handles line boundaries).
   */
  onOutput(chunk: string): void
}

export interface Tool {
  name(): string
  description(): string
  parametersSchema(): Record<string, unknown>
  execute(params: Record<string, unknown>, context?: ExecutionContext): Promise<ToolOutput>
  requiresSanitization(): boolean
  requiresApproval(): boolean
  /**
   * Safe, producer-owned classification for governed replay. This must never
   * include tool arguments or output. Native tools may omit it and are then
   * classified as internal by the orchestration layer.
   */
  traceDescriptor?(params: Record<string, unknown>, output?: ToolOutput): ToolTraceDescriptor
  /**
   * Optional. Return true if this tool writes to `context.onOutput()` during
   * execute(). Signals the tool-use loop to attach a progress watcher.
   * Tools that don't opt in get zero runtime overhead from this feature.
   */
  supportsProgressOutput?(): boolean
}

// ─── Channel ────────────────────────────────────────────────

export interface Channel {
  receive(): AsyncIterable<IncomingMessage>
  respond(original: IncomingMessage, response: OutgoingResponse): Promise<void>
  sendStatus(status: StatusUpdate): void
}

// ─── Safety ─────────────────────────────────────────────────

export interface Safety {
  validateInput(input: string): ValidationResult
  validateToolParams(toolName: string, params: Record<string, unknown>): ValidationResult
  sanitizeOutput(toolName: string, output: string): SanitizedOutput
  wrapForLlm(toolName: string, content: string, wasSanitized: boolean): string
}

// ─── Storage ────────────────────────────────────────────────

export interface Storage {
  loadConversation(id: string): Promise<Conversation | null>
  saveConversation(conversation: Conversation): Promise<void>
  loadSystemPrompt(): Promise<string | null>
}

// ─── Event Emitter ──────────────────────────────────────────

export interface AgentEventEmitter {
  emit(event: AgentEvent): void
  on(type: AgentEvent['type'], handler: (event: AgentEvent) => void): void
  off(type: AgentEvent['type'], handler: (event: AgentEvent) => void): void
}

// ─── Extension Points ───────────────────────────────────────

export interface PromptBuilder {
  buildSystemPrompt(
    tools: ToolDefinition[],
    identity?: string,
    metadata?: Record<string, unknown>
  ): ChatMessage
}

export interface ToolOutputProcessor {
  beforeExecution(toolName: string, params: Record<string, unknown>): ValidationResult
  afterExecution(toolName: string, output: ToolOutput): string
}

export interface LoopController {
  shouldAccept(content: string, iteration: number): boolean
  onTextRejected(content: string, iteration: number): ChatMessage | null
  beforeTool(
    toolName: string,
    params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval }
  onExhaustion(iteration: number): string
  refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]>
}

/**
 * Options bag accepted by `ContextManager.manage()`. All fields optional —
 * callers that don't need them keep using the binary `manage(messages, conv)`
 * form. P.5 introduces the slots; T1.1 / T3.2 fill them in.
 */
export interface ContextManageOptions {
  /**
   * Optional topic hint. When set, downstream summarizers (T1.1) bias roughly
   * 60% of the summary budget toward content related to this topic. Only
   * honored by the `Summarize` tier.
   */
  focus?: string

  /**
   * Forces a specific compaction tier instead of letting pressure decide.
   * Used by `POST /v1/runtime/compact` (T1.1) and integration tests that need
   * to exercise a single branch deterministically.
   */
  forceTier?: 'summarize' | 'truncate' | 'moveToWorkspace'

  /**
   * P1-012: when true, the `Summarize` tier (T1.1) bypasses the auxiliary LLM
   * (T3.2) and routes directly to the main provider. Used by the
   * `/v1/runtime/compact` endpoint when `focus` is supplied — Haiku-class aux
   * models may not respect the focus-topic budget allocation reliably, so
   * operator-triggered compactions with focus opt into the main LLM.
   * Automatic compactions (no focus) continue to use the auxiliary port.
   */
  useMainLlm?: boolean
}

export interface ContextManager {
  /**
   * P.5 canonical signature. `conversation` is required so downstream plans
   * (T1.4 anti-thrash counter, T2.2 prompt cache invalidation) can read/write
   * per-session state without a silent bypass. The defensive guard against
   * compaction during a pending approval (IronClaw invariant #1) lives in the
   * implementations — `manage()` returns a passthrough when
   * `conversation.pending_approval !== undefined`.
   */
  manage(
    messages: ChatMessage[],
    conversation: Conversation,
    options?: ContextManageOptions
  ): ChatMessage[] | Promise<ChatMessage[]>
}

// ─── Native Tool Config ─────────────────────────────────────

export interface NativeToolConfig {
  workspacePath: string
  shellTimeout: number
  toolTimeout: number
  toolProgressInterval: number
  httpAllowlist: string[]
  envAllowlist: string[]
  memoryMaxSize: number
  /** Cron×stateless (CLERUM_STATELESS_LIFECYCLE): steers the cron_manage
   *  stateless notice. Optional so existing construction sites stay valid. */
  statelessLifecycle?: boolean
}
