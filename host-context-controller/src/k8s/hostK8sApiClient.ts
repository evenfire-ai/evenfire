import * as k8s from '@kubernetes/client-node'

export const HOST_K8S_REQUEST_TIMEOUT_CODE = 'HCC_HOST_K8S_REQUEST_TIMEOUT'

export class HostK8sRequestTimeoutError extends Error {
  readonly code = HOST_K8S_REQUEST_TIMEOUT_CODE

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
    options?: { cause?: unknown }
  ) {
    super(
      `Kubernetes request ${operation} exceeded its ${timeoutMs}ms deadline`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    )
    this.name = 'HostK8sRequestTimeoutError'
  }
}

type AbortSource = 'existing' | 'deadline'

type CombinedAbortSignal = {
  signal: AbortSignal
  source: () => AbortSource | undefined
  cleanup: () => void
}

type K8sCallOptions = k8s.ConfigurationOptions<k8s.ObservableMiddleware>

function combineAbortSignals(
  existingSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal
): CombinedAbortSignal {
  const controller = new AbortController()
  let abortSource: AbortSource | undefined

  const forwardAbort = (source: AbortSource, signal: AbortSignal): void => {
    if (controller.signal.aborted) return
    abortSource = source
    controller.abort(signal.reason)
  }
  const abortFromExisting = () => forwardAbort('existing', existingSignal!)
  const abortFromDeadline = () => forwardAbort('deadline', deadlineSignal)

  if (existingSignal?.aborted) {
    forwardAbort('existing', existingSignal)
  } else if (deadlineSignal.aborted) {
    forwardAbort('deadline', deadlineSignal)
  } else {
    existingSignal?.addEventListener('abort', abortFromExisting, { once: true })
    deadlineSignal.addEventListener('abort', abortFromDeadline, { once: true })
  }

  return {
    signal: controller.signal,
    source: () => abortSource,
    cleanup: () => {
      existingSignal?.removeEventListener('abort', abortFromExisting)
      deadlineSignal.removeEventListener('abort', abortFromDeadline)
    },
  }
}

function apiMethodNames(client: object): Set<PropertyKey> {
  const names = new Set<PropertyKey>()
  let current: object | null = client
  while (current && current !== Object.prototype) {
    for (const name of Reflect.ownKeys(current)) {
      if (name === 'constructor') continue
      const descriptor = Reflect.getOwnPropertyDescriptor(current, name)
      if (typeof descriptor?.value === 'function') names.add(name)
    }
    current = Reflect.getPrototypeOf(current)
  }
  return names
}

/**
 * Add an actual transport deadline to every finite request made by a generated
 * Kubernetes API client. The returned promise deliberately waits for the
 * underlying client to reject after abort; it does not race a detached timer.
 */
export function withHostK8sRequestDeadline<T extends object>(client: T, timeoutMs: number): T {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Host Kubernetes request timeout must be a positive integer, got ${timeoutMs}`)
  }

  const methodNames = apiMethodNames(client)
  const wrappedMethods = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>()
  const clientName = client.constructor.name.replace(/^Object(?=[A-Z])/, '') || 'KubernetesApi'

  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (!methodNames.has(property) || typeof value !== 'function') return value

      const cached = wrappedMethods.get(property)
      if (cached) return cached

      const wrapped = (...args: unknown[]): Promise<unknown> => {
        const operation = `${clientName}.${String(property)}`
        const timeoutError = new HostK8sRequestTimeoutError(operation, timeoutMs)
        const deadlineController = new AbortController()
        let combinedSignal: CombinedAbortSignal | undefined
        let cleanedUp = false

        const timer = setTimeout(() => deadlineController.abort(timeoutError), timeoutMs)
        timer.unref?.()

        const cleanup = (): void => {
          if (cleanedUp) return
          cleanedUp = true
          clearTimeout(timer)
          combinedSignal?.cleanup()
        }
        const deadlineMiddleware: k8s.ObservableMiddleware = {
          pre: context => {
            combinedSignal?.cleanup()
            combinedSignal = combineAbortSignals(context.getSignal(), deadlineController.signal)
            context.setSignal(combinedSignal.signal)
            return new k8s.Observable(Promise.resolve(context))
          },
          post: context => new k8s.Observable(Promise.resolve(context)),
        }
        const callOptions = (args[1] ?? {}) as K8sCallOptions
        const requestArgs = [...args]
        requestArgs[1] = {
          ...callOptions,
          middleware: [...(callOptions.middleware ?? []), deadlineMiddleware],
          // The deadline must run after static and call-specific middleware so
          // it can combine, rather than overwrite, the final existing signal.
          middlewareMergeStrategy: 'append',
        } satisfies K8sCallOptions

        let request: Promise<unknown>
        try {
          request = Reflect.apply(value, target, requestArgs) as Promise<unknown>
        } catch (error) {
          cleanup()
          return Promise.reject(error)
        }

        return Promise.resolve(request)
          .then(
            result => {
              if (combinedSignal?.source() === 'deadline') throw timeoutError
              return result
            },
            error => {
              if (combinedSignal?.source() === 'deadline') {
                throw new HostK8sRequestTimeoutError(operation, timeoutMs, { cause: error })
              }
              throw error
            }
          )
          .finally(cleanup)
      }

      wrappedMethods.set(property, wrapped)
      return wrapped
    },
  })
}

export function makeHostK8sApiClient<T extends k8s.ApiType>(
  kubeConfig: k8s.KubeConfig,
  apiClientType: k8s.ApiConstructor<T>,
  timeoutMs: number
): T {
  return withHostK8sRequestDeadline(kubeConfig.makeApiClient(apiClientType), timeoutMs)
}
