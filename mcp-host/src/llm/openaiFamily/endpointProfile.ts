/**
 * Everything that varies per OpenAI-family endpoint (who is called and its
 * quirks), as data the single driver composes instead of subclass overrides.
 */
import type OpenAI from 'openai'
import type { VisualDeliveryLimits } from '../../visualInput/deliveryLimits'
import type { ImageTransportOperation } from '../imageInput'
import type { LlmProvider } from '../registryCore'
import type { ToolNameEnvelopeKey } from '../toolWireNames'
import type { ClassifiedError } from '../types'
import type { ModelParamPolicy } from './modelParamPolicy'
import type { WireProtocolId } from './protocols/types'

/** Call-option normalization for endpoints narrower than the OpenAI contract. */
export interface OptionPolicy {
  /** Temperature is clamped to `[0, temperatureCeiling]`. */
  readonly temperatureCeiling: number
  /** Endpoint rejects `tool_choice: 'required'`; it is sent as `'auto'`. */
  readonly downgradeRequiredToolChoice: boolean
}

export interface EndpointProfile {
  /** Reported by `getProviderType()`. */
  readonly id: LlmProvider
  readonly protocol: WireProtocolId
  /**
   * Builds the SDK client once, at driver construction. The profile never
   * keeps it: the driver owns the client and reads it on every call.
   */
  createClient(keyOrClient: string | OpenAI): OpenAI
  /** `null` passes caller options through untouched. */
  readonly options: OptionPolicy | null
  readonly reasoningContent: boolean
  /** Tool-name pattern the endpoint accepts; names outside it travel aliased. */
  readonly toolNameEnvelope: ToolNameEnvelopeKey
  /** Endpoint-native error codes; `null` (or a `null` result) falls back to the shared chain. */
  readonly classify: ((err: unknown) => ClassifiedError | null) | null
  /** Evaluated per call against the driver's current client base URL. */
  visualLimits(baseURL: unknown, operation: ImageTransportOperation): VisualDeliveryLimits | null
  readonly params: ModelParamPolicy
}
