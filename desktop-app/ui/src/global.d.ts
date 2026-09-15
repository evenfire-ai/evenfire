// The canonical `window.clerum` shape is declared in `desktop-app/src/renderer.d.ts`
// (a single source of truth shared by the Electron main/preload and the UI; the UI
// picks it up via `../src/renderer.d.ts` in `ui/tsconfig.json`'s `include`). Do NOT
// re-declare `Window.clerum` here — two module augmentations of the same property
// shadow each other and break `tsc`. This file only carries UI-local ambient types.

declare global {
  const __DESKTOP_APP_VERSION__: string
}

/**
 * Augment React's CSSProperties so we can pass our design-system CSS custom
 * properties via `style={{ ... }}` without `as CSSProperties` casts. Each entry
 * here is a token we set inline (consumed by classes in `src/styles.css` /
 * `src/styles/tokens.css`). Document the consumer in the comment so future
 * contributors know who reads it.
 */
declare module 'react' {
  interface CSSProperties {
    /** Column template for `.da-grid` (consumed by `.da-grid__head` / `.da-grid__row`). */
    '--da-grid-cols'?: string
    /** Session-only chat-drawer width, set inline on `.content-panel` and read by
     *  `.chat-drawer` + its embed gutter (see `useChatDrawerResize`). */
    '--chat-drawer-width'?: string
  }
}

export {}
