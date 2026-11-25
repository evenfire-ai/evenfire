import type { ToastOptions } from '../components/Toast/types'

export type RootToastListener = (message: string, options?: ToastOptions) => void

/**
 * Bridge from code outside React to the app's root `ToastProvider`.
 *
 * A save can finish after the user left the tab; the component that started it is
 * gone, so the continuation reports through the root toast instead of component state.
 * The provider subscribes in an effect and unsubscribes on unmount, so this set holds
 * only providers that are mounted right now.
 *
 * Several providers: the app mounts one, but if more are mounted every one of them
 * receives the toast and shows it once. Each listener is called once per emit.
 */
const listeners = new Set<RootToastListener>()

export function subscribeRootToast(listener: RootToastListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitRootToast(message: string, options?: ToastOptions): void {
  // Iterate a copy: a listener that unsubscribes while handling must not skip the others.
  for (const listener of Array.from(listeners)) listener(message, options)
  // With no provider mounted the toast is dropped on purpose: the root toast only exists
  // while the page is loaded, and there is no other place to show it.
}

/** Test-only: how many providers are subscribed right now. Production code must not use it. */
export function __rootToastListenerCountForTests(): number {
  return listeners.size
}
