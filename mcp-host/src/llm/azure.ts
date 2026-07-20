/**
 * Azure OpenAI provider (light driver).
 *
 * Azure speaks the OpenAI chat/completions wire shape, but diverges from the
 * vanilla OpenAI-compatible arm in three ways the data-driven baseURL arm cannot
 * express — hence its own factory case rather than a `PROVIDERS.baseURL` entry:
 *   1. the base URL is PER-RESOURCE, supplied by the operator as the non-secret
 *      env `AZURE_OPENAI_ENDPOINT` (not a fixed registry constant);
 *   2. auth is the `api-key: <key>` header, NOT `Authorization: Bearer <key>`;
 *   3. the `model` string is the Azure DEPLOYMENT name (passed through as-is).
 *
 * We target Azure's v1 GA surface (`<endpoint>/openai/v1/`), which a vanilla
 * OpenAI client speaks directly. So this is a thin subclass of OpenAIProvider
 * that only swaps the client's base URL + auth header and reuses all of the
 * request / message-conversion / error-classification logic.
 *
 * No new SDK: it reuses the `openai` client already on the common path.
 */
import OpenAI from 'openai'
import { OpenAIProvider } from './openai'
import type { LlmProvider } from './registryCore'

export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(apiKey: string, model: string) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim()
    if (!endpoint) {
      // Fail-closed: without the per-resource endpoint there is no correct host
      // to reach. Throwing lets createLLMProvider return null so the R5 failover
      // / degraded path takes over — never silently fall back to a wrong host.
      throw new Error(
        '[Azure] AZURE_OPENAI_ENDPOINT is required (per-resource host) but was not set'
      )
    }
    // Fail-closed on a non-https endpoint: the API key travels in the `api-key`
    // header, so an `http://` typo would send the secret in cleartext. Azure
    // OpenAI is always https; reject anything else rather than leak. (Host is
    // NOT allowlisted — sovereign clouds use .azure.us / .azure.cn and operators
    // may front a custom domain; the operator already controls this trusted env.)
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      throw new Error(`[Azure] AZURE_OPENAI_ENDPOINT is not a valid URL: '${endpoint}'`)
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `[Azure] AZURE_OPENAI_ENDPOINT must be https (got '${parsed.protocol}') — refusing to send the api-key over a non-TLS transport`
      )
    }
    // Azure v1 GA path; a vanilla OpenAI client speaks it directly (no
    // per-deployment path segment — the model IS the deployment name).
    const baseURL = `${endpoint.replace(/\/+$/, '')}/openai/v1/`
    // Optional; only the classic (non-v1) path needs `api-version` (a query
    // param there). Read for forward-compat and thread it as a default query so
    // a switch back to the classic surface keeps working; harmless on v1.
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim()
    const client = new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: apiVersion ? { 'api-version': apiVersion } : undefined,
      defaultHeaders: {
        // Azure authenticates via `api-key`, not `Authorization: Bearer`.
        'api-key': apiKey,
        // Neutralize the SDK's default Bearer header (a null value deletes it).
        Authorization: null,
      },
    })
    super(client, model)
  }

  override getProviderType(): LlmProvider {
    return 'azure'
  }
}
