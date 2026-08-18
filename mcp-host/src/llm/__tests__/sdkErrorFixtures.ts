/**
 * Test fixtures DERIVED from the real provider SDK error constructors (T1) —
 * never hand-built object literals. This matters because the SDKs shape the
 * error body differently, and hand-writing the shape encodes a belief about
 * that shape rather than the truth:
 *
 *   - `Anthropic.APIError.generate(...)` stores the FULL response envelope on
 *     `.error` → `{ type:'error', error:{ type, message } }` (modeled type at
 *     `.error.error.type`).
 *   - `OpenAI.APIError.generate(...)` stores only the INNER error object on
 *     `.error` → `{ code, message, type }` (code at `.error.code`).
 *   - `new ApiError(...)` (`@google/genai`) is FLAT: numeric `.status` plus a
 *     stringified `.message` envelope, no structured gRPC status field.
 *   - `new ResourceNotFoundException(...)` (`@aws-sdk/client-bedrock-runtime`)
 *     fixes `.name` and `$fault`, exposing `.message` and `.$metadata`.
 *
 * Deriving from the producers guarantees the classifiers under test consume the
 * exact shape the SDKs emit.
 */
import Anthropic from '@anthropic-ai/sdk'
import { ResourceNotFoundException } from '@aws-sdk/client-bedrock-runtime'
import { ApiError } from '@google/genai'
import OpenAI from 'openai'

/**
 * A real `Anthropic.APIError` (e.g. `NotFoundError`) carrying the modeled
 * `error.type` nested inside the response envelope, exactly as the SDK builds
 * it from an HTTP response.
 */
export function anthropicApiError(status: number, type: string, message: string): unknown {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message } },
    undefined,
    {}
  )
}

/**
 * A real `OpenAI.APIError` carrying the provider-native `error.code` (used by
 * OpenAI-compatible providers such as z.ai / Bailian). `OpenAI.APIError.generate`
 * returns an `APIConnectionError` unless `headers` is truthy, so a truthy
 * headers object (the SDK types it as `Record<string, string>`) is always passed.
 */
export function openaiApiError(
  status: number,
  body: { code?: string; message: string; type?: string }
): unknown {
  return OpenAI.APIError.generate(
    status,
    { error: { code: body.code, message: body.message, type: body.type } },
    undefined,
    {}
  )
}

/**
 * A real `@google/genai` `ApiError` as thrown by the Vertex driver's SDK. The
 * SDK's throw path constructs it as `new ApiError({ status, message })` where
 * `message` is `JSON.stringify(errorBody)` — the whole HTTP error envelope
 * (e.g. `{"error":{"code":404,"message":"...","status":"NOT_FOUND"}}`).
 *
 * `ApiError` is FLAT: it carries only a numeric `.status` and the stringified
 * `.message`. It does NOT expose the nested gRPC `status` string
 * (`error.status: 'NOT_FOUND'`) as a structured field — that lives buried
 * inside `.message`. So `classifyGoogleError`, which reads `providerCode` only
 * from structured fields (`e.status`/`e.code`/`e.error?.status`), sees no gRPC
 * status string and leaves `providerCode` undefined — exactly as with the real
 * producer.
 */
export function vertexApiError(status: number, envelope: object): unknown {
  return new ApiError({ status, message: JSON.stringify(envelope) })
}

/**
 * A real `@aws-sdk/client-bedrock-runtime` `ResourceNotFoundException` as the
 * Bedrock Converse client throws for a retired/invalid model id. The class
 * fixes `name === 'ResourceNotFoundException'` and `$fault === 'client'`
 * internally; the constructor opts only carry `{ message, $metadata }` (all
 * other base-exception fields are excluded by the SDK's `ExceptionOptionType`).
 * `classifyBedrockError` reads `.name` and `.$metadata.httpStatusCode`, both of
 * which the resulting instance exposes.
 */
export function bedrockResourceNotFound(message: string): unknown {
  return new ResourceNotFoundException({
    message,
    $metadata: { httpStatusCode: 404 },
  })
}
