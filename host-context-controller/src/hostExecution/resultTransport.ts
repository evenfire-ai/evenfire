import { isIP } from 'node:net'
import { EXECUTION_RESULT_MAX_BYTES } from './result'

export const EXECUTION_RESULT_PORT = 9300
export const EXECUTION_POD_UID_HEADER = 'x-execution-pod-uid'

/** Address must come from the exact, live, API-validated execution Pod. */
export interface ExecutionPodTarget {
  podUid: string
  podIp: string
}

export function executionPodAddress(target: ExecutionPodTarget): string {
  const { podIp, podUid } = target
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(podUid)) {
    throw new Error('execution_result_target_invalid')
  }
  const kind = isIP(podIp)
  const canonical =
    kind === 6 && !podIp.includes('%')
      ? new URL(`http://[${podIp}]/`).hostname.slice(1, -1).toLowerCase()
      : podIp
  const ipv4 = kind === 4 ? podIp : ''
  const first = Number(ipv4.split('.')[0])
  if (
    !kind ||
    podIp.includes('%') ||
    canonical === '::' ||
    canonical === '::1' ||
    /^fe[89ab]/i.test(canonical) ||
    /^ff/i.test(canonical) ||
    canonical.startsWith('::ffff:') ||
    (ipv4 && (first === 0 || first === 127 || first >= 224 || ipv4.startsWith('169.254.')))
  ) {
    throw new Error('execution_result_target_invalid')
  }
  return kind === 6 ? `[${canonical}]` : podIp
}

/**
 * Private Pod-to-HCC result transport. It neither reads container logs nor
 * forwards credentials. Network policy must admit only HCC to this port.
 * The Pod UID header prevents delivery from a subsequently reused Pod IP.
 */
export class ExecutionResultTransport {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetchResponse: typeof fetch = fetch
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('execution_result_timeout_invalid')
    }
  }

  private async request(
    target: ExecutionPodTarget,
    method: 'GET' | 'DELETE',
    signal?: AbortSignal
  ): Promise<Response> {
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const response = await this.fetchResponse(
      `http://${executionPodAddress(target)}:${EXECUTION_RESULT_PORT}/result`,
      {
        method,
        headers: { [EXECUTION_POD_UID_HEADER]: target.podUid, 'cache-control': 'no-store' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }
    )
    if (response.headers.get(EXECUTION_POD_UID_HEADER) !== target.podUid) {
      await response.body?.cancel()
      throw new Error('execution_result_binding_mismatch')
    }
    return response
  }

  async read(target: ExecutionPodTarget, signal?: AbortSignal): Promise<string | null> {
    const response = await this.request(target, 'GET', signal)
    if (response.status === 425) {
      await response.body?.cancel()
      return null
    }
    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json' ||
      !response.body
    ) {
      await response.body?.cancel()
      throw new Error('execution_result_unavailable')
    }
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > EXECUTION_RESULT_MAX_BYTES)) {
      await response.body.cancel()
      throw new Error('execution_result_invalid')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > EXECUTION_RESULT_MAX_BYTES) throw new Error('execution_result_invalid')
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }

  /** A result-clear acknowledgement is not a physical workload/store receipt. */
  async clear(target: ExecutionPodTarget, signal?: AbortSignal): Promise<void> {
    const response = await this.request(target, 'DELETE', signal)
    await response.body?.cancel()
    if (response.status !== 204) throw new Error('execution_result_clear_pending')
  }
}
