import { type CSSProperties, useLayoutEffect, useState } from 'react'

const MOBILE_SIDEBAR_QUERY = '(max-width: 900px)'

function readWorkspaceLeft(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0
  if (window.matchMedia?.(MOBILE_SIDEBAR_QUERY).matches) return 0

  const sidebar = document.querySelector<HTMLElement>('.left-nav')
  if (!sidebar) return 0

  const rect = sidebar.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0) return 0

  return Math.max(0, Math.min(rect.right, viewportWidth))
}

/**
 * Preview dialogs are portaled to document.body, outside the workspace layout.
 * Keep their fixed backdrop inset to the live right edge of the desktop sidebar
 * so the dialog remains centered in the visible workspace as navigation changes.
 */
export function useWorkspaceModalStyle(): CSSProperties | undefined {
  const [workspaceLeft, setWorkspaceLeft] = useState(0)

  useLayoutEffect(() => {
    const measure = (): void => {
      const next = readWorkspaceLeft()
      setWorkspaceLeft(current => (current === next ? current : next))
    }

    measure()
    const sidebar = document.querySelector<HTMLElement>('.left-nav')
    const resizeObserver =
      sidebar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (sidebar) resizeObserver?.observe(sidebar)

    const mutationObserver =
      sidebar && typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null
    if (sidebar) {
      mutationObserver?.observe(sidebar, { attributes: true, attributeFilter: ['class'] })
    }

    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [])

  return workspaceLeft > 0 ? { left: workspaceLeft, right: 0 } : undefined
}
