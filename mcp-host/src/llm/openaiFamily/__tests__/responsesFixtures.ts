/**
 * Shared helpers for tests that need Responses continuity produced by the real
 * driver: every continuation comes from the protocol decoding a response
 * recorded from the real API, never from an object written by hand.
 */
import { vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCompletionResponse } from '../../../core/types'
import { OpenAIProvider } from '../../openai'
import { responsesProtocol } from '../protocols/responses'
import type { DriverIdentity } from '../protocols/types'

export type RecordedItem = Record<string, unknown>
export type RecordedResponse = RecordedItem & { output: RecordedItem[] }

const FIXTURES = join(__dirname, '__fixtures__', 'responses')

export const RESPONSES_MODEL = 'gpt-6.1-terra'

export function recordedResponse(name: string): RecordedResponse {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).res
}

/**
 * The continuity epoch of a real driver, read from its private field. Throws
 * if the field is gone or no longer a UUID, so a rename turns the forgery
 * tests red instead of letting them forge an owner with `epoch: undefined`.
 */
export function driverEpoch(driver: unknown): string {
  const epoch = (driver as { epoch?: unknown }).epoch
  if (typeof epoch !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(epoch)) {
    throw new Error(`driver has no continuity epoch (got ${typeof epoch})`)
  }
  return epoch
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/** A recorded response decoded by the real protocol, as a tool turn. */
export function decodedResponse(
  name: string,
  identity: DriverIdentity = {
    provider: 'openai',
    protocol: 'openai-responses',
    model: RESPONSES_MODEL,
    epoch: 'fixture-epoch',
  }
): ToolCompletionResponse {
  return responsesProtocol.decodeTools(
    recordedResponse(name) as unknown as Parameters<typeof responsesProtocol.decodeTools>[0],
    identity
  )
}

/**
 * An official OpenAI driver (default profile, which speaks Responses) whose
 * SDK client answers each `responses.create` with the next recorded response,
 * in order.
 */
export function responsesDriver(fixtureNames: string[]) {
  const provider = new OpenAIProvider('unit-key', RESPONSES_MODEL)
  const queue = fixtureNames.map(recordedResponse)
  const create = vi.fn(async (_payload: unknown) => {
    const next = queue.shift()
    if (!next) throw new Error('no more recorded responses')
    return next
  })
  ;(provider as unknown as { client: unknown }).client = {
    baseURL: 'https://api.openai.com/v1',
    responses: { create },
    chat: { completions: { create: vi.fn() } },
  }
  /** The `input` items of the n-th payload sent to `responses.create`. */
  const sentInput = (n: number): RecordedItem[] =>
    (create.mock.calls[n]![0] as { input: RecordedItem[] }).input
  return { provider, create, sentInput }
}
