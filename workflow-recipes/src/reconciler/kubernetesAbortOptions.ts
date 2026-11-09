import * as k8s from '@kubernetes/client-node'

/**
 * Per-call options that bind one Kubernetes API request to `signal`.
 *
 * `@kubernetes/client-node` sets no request timeout of its own; the signal is
 * the only bound on a call. The middleware is appended so any middleware the
 * client configuration already carries still runs. Same shape as control-api's
 * `cancellationOptions` (control-api/src/services/resourceService.ts).
 */
export function kubernetesAbortOptions(signal: AbortSignal): k8s.ConfigurationOptions {
  signal.throwIfAborted()
  const abortable = k8s.createConfiguration({
    promiseMiddleware: [
      {
        pre: async context => {
          signal.throwIfAborted()
          context.setSignal(signal)
          return context
        },
        post: async response => response,
      },
    ],
  })
  return { middleware: abortable.middleware, middlewareMergeStrategy: 'append' }
}
