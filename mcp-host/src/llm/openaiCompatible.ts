/**
 * Generic OpenAI-compatible LLM provider.
 *
 * Many providers (z.ai / ZhipuAI, Alibaba Cloud Model Studio / Bailian, …)
 * expose an OpenAI-compatible chat/completions API and differ only in their
 * `baseURL`, default model, and the string reported by `getProviderType()`.
 * Rather than a bespoke subclass per provider, this single parameterized class
 * captures that shape — adding a new OpenAI-compatible provider is now a single
 * data entry in `PROVIDERS` (`registryCore.ts`).
 */
import OpenAI from 'openai'
import { OpenAIProvider } from './openai'
import type { LlmProvider } from './registryCore'

export class OpenAICompatibleProvider extends OpenAIProvider {
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
  }

  override getProviderType(): LlmProvider {
    return this.cfg.id as LlmProvider
  }
}
