/**
 * Legacy constructor for an OpenAI-compatible third-party driver.
 *
 * All behavior lives in `compatibleProfile` (`./openaiFamily/endpointProfiles`)
 * composed into `OpenAIProvider`; the registry builds that composition
 * directly. This subclass only keeps the historical `(cfg, apiKey, model?)`
 * construction shape working and must not grow members of its own.
 */
import { OpenAIProvider } from './openai'
import { compatibleProfile } from './openaiFamily/endpointProfiles'

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(
    cfg: { id: string; baseURL: string; defaultModel: string },
    apiKey: string,
    model?: string
  ) {
    // Fall back to the descriptor's model, never OpenAIProvider's own default:
    // an OpenAI model name would not exist on the third party's baseURL.
    super(apiKey, model ?? cfg.defaultModel, compatibleProfile(cfg))
  }
}
