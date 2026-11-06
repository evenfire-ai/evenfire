/**
 * Which request parameters a model accepts, per endpoint and wire protocol.
 * Declarative tables: the first matching row wins; no row means the endpoint
 * does not speak that protocol, which is a wiring bug, so `resolve` throws.
 */
import type { WireProtocolId } from './protocols/types'

export type TokenField = 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'

export interface ResolvedModelParams {
  readonly tokenField: TokenField
  readonly temperature: 'pass' | 'omit'
}

export interface ModelParamPolicy {
  resolve(model: string, protocol: WireProtocolId): ResolvedModelParams
}

interface ParamRow extends ResolvedModelParams {
  readonly protocol: WireProtocolId
  /** `null` matches any model. */
  readonly family: RegExp | null
}

/**
 * OpenAI's reasoning/latest families reject the legacy `max_tokens` field and
 * require `max_completion_tokens`. The core contract keeps `max_tokens`; only
 * the wire field changes.
 */
export const OPENAI_REASONING_FAMILY = /^(?:gpt-5(?:[.-]|$)|o[1-9](?:[.-]|$))/i

function tablePolicy(name: string, rows: readonly ParamRow[]): ModelParamPolicy {
  return {
    resolve(model, protocol) {
      const row = rows.find(r => r.protocol === protocol && (r.family?.test(model) ?? true))
      if (!row) {
        throw new Error(`[LLM] ${name} param policy has no row for protocol '${protocol}'`)
      }
      return { tokenField: row.tokenField, temperature: row.temperature }
    },
  }
}

const OFFICIAL_CHAT_ROWS: readonly ParamRow[] = [
  {
    protocol: 'openai-chat',
    family: OPENAI_REASONING_FAMILY,
    tokenField: 'max_completion_tokens',
    temperature: 'pass',
  },
  { protocol: 'openai-chat', family: null, tokenField: 'max_tokens', temperature: 'pass' },
]

/**
 * Separate from the Chat family so Chat requests stay byte-identical to what
 * they were; Responses adds `gpt-6*`.
 *
 * On Responses the reasoning families answer 400 `Unsupported parameter:
 * 'temperature'`, so it is omitted rather than forwarded. Unknown models fall
 * through to the permissive row: a reasoning model still applies its own
 * defaults there, it only loses the omission.
 */
export const OPENAI_RESPONSES_REASONING_FAMILY =
  /^(?:gpt-5(?:[.-]|$)|gpt-6(?:[.-]|$)|o[1-9](?:[.-]|$))/i

const OFFICIAL_RESPONSES_ROWS: readonly ParamRow[] = [
  {
    protocol: 'openai-responses',
    family: OPENAI_RESPONSES_REASONING_FAMILY,
    tokenField: 'max_output_tokens',
    temperature: 'omit',
  },
  {
    protocol: 'openai-responses',
    family: null,
    tokenField: 'max_output_tokens',
    temperature: 'pass',
  },
]

export const officialParamPolicy: ModelParamPolicy = tablePolicy('official', [
  ...OFFICIAL_CHAT_ROWS,
  ...OFFICIAL_RESPONSES_ROWS,
])

/** Azure serves OpenAI's own model families, so it follows the official token field. */
export const azureParamPolicy: ModelParamPolicy = tablePolicy('azure', OFFICIAL_CHAT_ROWS)

/** Third-party OpenAI-compatible APIs only accept the portable legacy field. */
export const compatibleParamPolicy: ModelParamPolicy = tablePolicy('compatible', [
  { protocol: 'openai-chat', family: null, tokenField: 'max_tokens', temperature: 'pass' },
])
