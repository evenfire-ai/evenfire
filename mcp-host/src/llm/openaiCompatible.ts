/**
 * Generic OpenAI-compatible LLM provider.
 *
 * Many providers (z.ai / ZhipuAI, Alibaba Cloud Model Studio / Bailian, and the
 * R6 additions openrouter/gemini/deepseek/groq/together/fireworks/mistral/xai/
 * cerebras/deepinfra/perplexity/moonshot/nebius/novita) expose an
 * OpenAI-compatible chat/completions API and differ only in their `baseURL`,
 * default model, and the string reported by `getProviderType()`. Rather than a
 * bespoke subclass per provider, this single parameterized class captures that
 * shape — adding a new OpenAI-compatible provider is now a single data entry in
 * `PROVIDERS` (`registryCore.ts`).
 *
 * PORTABILITY (R6 param audit): the base OpenAIProvider already sends only the
 * portable core — model + messages + tools + tool_choice + max_tokens +
 * temperature. It never emits the params the stricter third parties reject
 * (Groq: n>1 / logprobs / logit_bias; Cerebras: frequency_penalty /
 * presence_penalty), so nothing there needs trimming. The two remaining params
 * still need normalizing for the third-party arm:
 *   - temperature: the OpenAI-compatible range is [0,2], but Moonshot restricts
 *     it to [0,1]. We clamp to the provider's real ceiling ({@link
 *     temperatureCeiling}) — capping only what the provider would actually 400
 *     on, rather than silently degrading a valid [1,2] value on providers that
 *     accept it. (DeepSeek's reasoner ignores sampling params rather than
 *     erroring, so no clamp is needed to keep it happy.)
 *   - tool_choice: Moonshot rejects 'required', so for MOONSHOT ONLY we downgrade
 *     it to 'auto' (the model still sees the tools; we just don't force a call).
 *     Every other compat provider honors 'required' and passes it through — the
 *     downgrade is provider-gated so a forced-tool-call guarantee isn't silently
 *     weakened on providers that support it (incl. the pre-existing zai/bailian).
 * Native OpenAI (the base class) and Azure keep full fidelity — only this shared
 * third-party arm is conservative.
 */
import OpenAI from 'openai'
import type {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { OpenAIProvider } from './openai'
import type { LlmProvider } from './registryCore'

/**
 * Clamp/normalize call options to the portable subset every OpenAI-compatible
 * third party accepts (see class doc). `temperatureCeiling` is the provider's
 * upper bound (2 for the OpenAI-compatible default, 1 for Moonshot). Preserves
 * all other fields (max_tokens, signal, …) untouched.
 */
function toPortableOptions<T extends { temperature?: number; tool_choice?: string }>(
  options: T | undefined,
  temperatureCeiling: number,
  downgradeRequiredToolChoice: boolean
): T | undefined {
  if (!options) return options
  const next = { ...options }
  if (typeof next.temperature === 'number') {
    next.temperature = Math.min(temperatureCeiling, Math.max(0, next.temperature))
  }
  // Only providers that actually 400 on tool_choice:'required' get the downgrade
  // — otherwise we'd silently weaken a forced-tool-call guarantee (reachable via
  // a workflow step's toolChoice:'required') on the providers that honor it.
  if (downgradeRequiredToolChoice && next.tool_choice === 'required') {
    next.tool_choice = 'auto'
  }
  return next
}

export class OpenAICompatibleProvider extends OpenAIProvider {
  /** Provider temperature upper bound — 1 for Moonshot, else the [0,2] default. */
  private readonly temperatureCeiling: number
  /**
   * Whether this provider rejects `tool_choice: 'required'`. Only Moonshot does;
   * every other OpenAI-compatible provider honors it, so the downgrade is
   * provider-gated (mirrors {@link temperatureCeiling}).
   */
  private readonly downgradesRequiredToolChoice: boolean

  constructor(
    // `id` is a provider id from the registry (a `LlmProvider`); it arrives typed
    // as `string` because `CoreProviderDescriptor.id` is `string`. Construction
    // only ever happens via `makeProvider` from registry descriptors, so the cast
    // in getProviderType() is sound.
    private cfg: { id: string; baseURL: string; defaultModel: string },
    apiKey: string,
    model?: string
  ) {
    // Thread cfg.defaultModel as the fallback. Without it, model=undefined would
    // fall through to OpenAIProvider's own default ('gpt-5.4-mini'), and this
    // provider would request a non-existent model against its baseURL.
    super(new OpenAI({ apiKey, baseURL: cfg.baseURL }), model ?? cfg.defaultModel)
    this.temperatureCeiling = cfg.id === 'moonshot' ? 1 : 2
    this.downgradesRequiredToolChoice = cfg.id === 'moonshot'
  }

  override getProviderType(): LlmProvider {
    return this.cfg.id as LlmProvider
  }

  override completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    return super.completeSingleTurn(
      messages,
      toPortableOptions(options, this.temperatureCeiling, this.downgradesRequiredToolChoice)
    )
  }

  override completeSingleTurnWithTools(
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse> {
    return super.completeSingleTurnWithTools(
      messages,
      tools,
      toPortableOptions(options, this.temperatureCeiling, this.downgradesRequiredToolChoice)
    )
  }
}
