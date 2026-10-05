import type { Readable } from 'node:stream'
import { EXECUTION_INPUT_MAX_BYTES } from './jobFactory'
import {
  EXECUTION_POD_UID_HEADER,
  type ExecutionPodTarget,
  executionPodAddress,
} from './resultTransport'

export const EXECUTION_INPUT_PORT = 9301

/** One-shot opaque input delivery; failed/ambiguous POSTs are never retried. */
export class ExecutionInputTransport {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetchResponse: typeof fetch = fetch
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('execution_input_timeout_invalid')
    }
  }

  async ready(target: ExecutionPodTarget): Promise<boolean> {
    let response: Response
    try {
      response = await this.fetchResponse(
        `http://${executionPodAddress(target)}:${EXECUTION_INPUT_PORT}/ready`,
        {
          method: 'GET',
          headers: { [EXECUTION_POD_UID_HEADER]: target.podUid },
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      )
    } catch (error) {
      // Running is visible before the init process has bound its listener.
      // Only that concrete connection refusal is a not-ready observation.
      if ((error as { cause?: { code?: string } })?.cause?.code === 'ECONNREFUSED') return false
      throw error
    }
    await response.body?.cancel()
    if (response.headers.get(EXECUTION_POD_UID_HEADER) !== target.podUid) {
      throw new Error('execution_input_binding_mismatch')
    }
    if (response.status !== 204) throw new Error('execution_input_unavailable')
    return true
  }

  async send(
    target: ExecutionPodTarget,
    input: Readable,
    byteLength: number,
    signal?: AbortSignal
  ): Promise<void> {
    const address = executionPodAddress(target)
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > EXECUTION_INPUT_MAX_BYTES
    ) {
      throw new Error('execution_input_contract_invalid')
    }
    const deadline = AbortSignal.timeout(this.timeoutMs)
    try {
      const response = await this.fetchResponse(`http://${address}:${EXECUTION_INPUT_PORT}/input`, {
        method: 'POST',
        headers: {
          [EXECUTION_POD_UID_HEADER]: target.podUid,
          'content-type': 'application/octet-stream',
          'content-length': String(byteLength),
        },
        body: input,
        duplex: 'half',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
      await response.body?.cancel()
      if (response.headers.get(EXECUTION_POD_UID_HEADER) !== target.podUid) {
        throw new Error('execution_input_binding_mismatch')
      }
      if (response.status !== 204) throw new Error('execution_input_rejected')
    } finally {
      // The input is an operation-owned stream from the protected file store.
      // Closing it does not delete the original or acknowledge physical purge.
      input.destroy()
    }
  }
}
