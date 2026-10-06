/**
 * Preload-side wiring for cancellable invokes (folder-zip Stop, R1-M1/R2-L3).
 * Pure with an injected ipcRenderer-shaped bridge so the abort ordering is
 * unit-testable without Electron:
 *
 * - an ALREADY-ABORTED signal starts NO producer work: the invoke is never
 *   sent and no abort event is fired (R2-L3) — the caller gets an AbortError
 *   immediately;
 * - a signal that aborts mid-flight fires `gfs:abort` with the invoke's
 *   requestId exactly once, and the listener detaches when the invoke settles.
 */
export interface CancellableIpcBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>
  send(channel: string, payload: unknown): void
}

export function cancellableInvoke<T>(
  bridge: CancellableIpcBridge,
  channel: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return bridge.invoke(channel, payload) as Promise<T>
  if (signal.aborted) {
    return Promise.reject(new DOMException('Request was stopped before it started.', 'AbortError'))
  }
  const requestId = crypto.randomUUID()
  const onAbort = () => bridge.send('gfs:abort', { requestId })
  signal.addEventListener('abort', onAbort, { once: true })
  return bridge
    .invoke(channel, { ...payload, requestId })
    .finally(() => signal.removeEventListener('abort', onAbort)) as Promise<T>
}
