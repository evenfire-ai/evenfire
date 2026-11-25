/** The panel takes nothing: it reads its values from the page's fragment, in the browser. */
export type DesktopLoginPanelProps = Record<string, never>

/**
 * What the panel shows. `loading` is the first render, on the server and in the browser, before
 * the fragment is read. `invalid` is a fragment the package parser refuses; `unavailable` is a
 * valid fragment with no provider label (member sign-in off, or the configuration unreachable).
 */
export type DesktopLoginView =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; challenge: string; state: string; label: string }
