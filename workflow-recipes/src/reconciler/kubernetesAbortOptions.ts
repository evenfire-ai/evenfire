import * as k8s from '@kubernetes/client-node'

/**
 * Per-call options that bind one Kubernetes API request to `signal`.
 *
 * `@kubernetes/client-node` sets no request timeout of its own; the signal is
 * the only bound on a call. node-fetch rejects a request whose signal has
 * already fired with the same `AbortError` it uses for one cut in flight. The
 * middleware is appended so any middleware the client configuration already
 * carries still runs. Same shape as control-api's `cancellationOptions`
 * (control-api/src/services/resourceService.ts), without its abort checks.
 */
export function kubernetesAbortOptions(signal: AbortSignal): k8s.ConfigurationOptions {
  const abortable = k8s.createConfiguration({
    promiseMiddleware: [
      {
        pre: async context => {
          context.setSignal(signal)
          return context
        },
        post: async response => response,
      },
    ],
  })
  return { middleware: abortable.middleware, middlewareMergeStrategy: 'append' }
}
