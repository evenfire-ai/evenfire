/**
 * Test fixtures DERIVED from the real provider SDK error constructors (T1) —
 * never hand-built object literals. This matters because the two SDKs nest the
 * error body differently, and hand-writing the shape encodes a belief about
 * that nesting rather than the truth:
 *
 *   - `Anthropic.APIError.generate(...)` stores the FULL response envelope on
 *     `.error` → `{ type:'error', error:{ type, message } }` (modeled type at
 *     `.error.error.type`).
 *   - `OpenAI.APIError.generate(...)` stores only the INNER error object on
 *     `.error` → `{ code, message, type }` (code at `.error.code`).
 *
 * Deriving from the producers guarantees the classifiers under test consume the
 * exact shape the SDKs emit.
 */
import Anthropic from '@anthropic-ai/sdk'
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
