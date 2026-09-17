import type { LlmPort } from '../interfaces'

/** A late provider result must not re-enter a task that has already stopped. */
export function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return operation()
      })
      .then(
        value => {
          cleanup()
          resolve(value)
        },
        error => {
          cleanup()
          reject(error)
        }
      )
  })
}

/** Reasoning and compaction share the same task cancellation boundary. */
export function bindTaskSignal(inner: LlmPort, taskSignal: AbortSignal): LlmPort {
  const signalFor = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, taskSignal]) : taskSignal
  return {
    modelName: () => inner.modelName(),
    ...(inner.getTokenCounter ? { getTokenCounter: () => inner.getTokenCounter!() } : {}),
    complete: request => {
      const signal = signalFor(request.signal)
      return withAbort(() => inner.complete({ ...request, signal }), signal)
    },
    completeWithTools: request => {
      const signal = signalFor(request.signal)
      return withAbort(() => inner.completeWithTools({ ...request, signal }), signal)
    },
  }
}
