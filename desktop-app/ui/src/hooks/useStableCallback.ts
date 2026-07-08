import { useCallback, useRef } from 'react'

/**
 * Returns a referentially-stable function whose identity never changes across
 * renders but which always invokes the latest `callback`. Use it for event-style
 * handlers exposed through context so that consumers don't re-render when the
 * handler's closure dependencies change (the wrapper is only ever called from
 * events/effects, after commit, so it reads the up-to-date implementation).
 */
export function useStableCallback<TArgs extends unknown[], TReturn>(
  callback: (...args: TArgs) => TReturn
): (...args: TArgs) => TReturn {
  const ref = useRef(callback)
  ref.current = callback
  return useCallback((...args: TArgs) => ref.current(...args), [])
}
