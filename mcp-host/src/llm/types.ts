/**
 * Core LLM transport types.
 *
 * `SingleTurnProvider` and `ClassifiedError` live here (rather than in
 * `./index`) to break the import cycle introduced by the provider registry:
 * the factory (`registry.ts`) returns `SingleTurnProvider`, and the interface's
 * `getProviderType()` references `LlmProvider`, which `registryCore.ts` derives.
 * This module imports only `LlmProvider` (type-only) from `registryCore` and is
 * otherwise dependency-free, so `registryCore`, `registry`, and `index` can all
 * import these interfaces without a runtime cycle.
 *
 * `index.ts` re-exports both names so the ~11 existing import sites
 * (`import { SingleTurnProvider, ClassifiedError } from '../llm'`) stay
 * untouched.
 */
import { LlmErrorCode } from '../core/errors'
import type { SystemPromptParts } from '../core/reasoning/systemPrompt'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import type { LlmProvider } from './registryCore'

/**
 * A structured classification of an error thrown by a provider's SDK.
 * Produced by SingleTurnProvider.classifyError() and used by LlmPortAdapter
 * to construct the downstream LlmError.
 *
 * `message` is the raw provider message, passed through verbatim (no
 * reformatting).
 */
export interface ClassifiedError {
  code: LlmErrorCode
  retryable: boolean
  message: string
  /**
   * Additive diagnostics (spec 02, Pieza A). The provider's HTTP status and the
   * provider-native error code/type (e.g. `not_found_error`, `1211`,
   * `Model.AccessDenied`) when the classifier recovered them. Threaded verbatim
   * through `LlmError` → `TaskError` so downstream (desktop) can distinguish a
   * retired-model 404 from an ambiguous failure without re-parsing the raw SDK
   * error. Optional: transport/unknown errors leave them undefined.
   */
  httpStatus?: number
  providerCode?: string
  /**
   * Execution-phase signal. `false` means the classifier PROVED that no call
   * left this process (the attempt died before authorize or before the proxy
   * stream), so the physical attempt cannot have billed. `true` means a call
   * left the process or may have. `undefined` means the classifier does not
   * know — consumers must assume the expensive direction (dispatched).
   *
   * Only a classifier that can prove the negative may set `false`: marking a
   * dispatched attempt as `false` would leave the idempotency key revivable
   * and permit a second billable call.
   */
  providerDispatched?: boolean
}

/**
 * Single-turn LLM transport. No loop, no tool execution.
 */
export interface SingleTurnProvider {
  completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse>

  completeSingleTurnWithTools(
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse>

  getProviderType(): LlmProvider

  /**
   * Classify an error thrown by this provider's SDK into a structured
   * ClassifiedError. Must never throw. Must always return a valid value —
   * fall back to classifyUnknown(err) if the error shape is unrecognized.
   */
  classifyError(err: unknown): ClassifiedError

  /**
   * T2.2 — Optional cache-aware completion. When the provider implements it,
   * `LlmPortAdapter` forwards `request.systemPromptParts` here so the
   * provider can emit native cache markers (Anthropic `cache_control` on the
   * `system` array). Providers without explicit cache support (OpenAI / ZAI /
   * Bailian) leave it undefined; the adapter concats the parts into a single
   * `system` string and calls `completeSingleTurnWithTools` instead.
   */
  completeSingleTurnWithToolsAndCache?(
    parts: SystemPromptParts,
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse>

  /**
   * T2.2 — Optional cache-aware completion without tools. Symmetric to
   * `completeSingleTurnWithToolsAndCache` but for the tool-less path.
   */
  completeSingleTurnAndCache?(
    parts: SystemPromptParts,
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse>
}
