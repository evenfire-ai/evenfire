import { useSyncExternalStore } from 'react'
import type { ThemeMode } from '@/uiTypes'

/** The theme App applies to the document; the stylesheet's `:root` default is dark. */
function readDocumentTheme(): ThemeMode {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/** The current light or dark theme, updated when the user switches it. */
export function useDocumentTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, readDocumentTheme, readDocumentTheme)
}
