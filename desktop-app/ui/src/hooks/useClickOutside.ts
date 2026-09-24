import { useEffect } from 'react'
import type { RefObject } from 'react'

// Accepts either a single ref or a list of refs. A click counts as "outside"
// only when it lands outside EVERY provided ref. This matters for portaled
// menus: the menu panel and its portaled submenu are separate DOM subtrees, so a
// mousedown on a submenu item would otherwise register as outside the panel ref,
// close the menu before the click fires, and swallow the action. Passing both
// refs keeps the menu mounted through the click. The single-ref form is
// unchanged for the existing consumers.
export function useClickOutside<T extends HTMLElement>(
  refs: RefObject<T | null> | Array<RefObject<T | null>>,
  isActive: boolean,
  onOutside: () => void
) {
  useEffect(() => {
    if (!isActive) return

    const refList = Array.isArray(refs) ? refs : [refs]
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const insideAny = refList.some(ref => ref.current?.contains(target))
      if (!insideAny) {
        onOutside()
      }
    }

    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
    // Depend on each resolved ref (spread) rather than the array literal itself,
    // which a caller re-creates every render — keeping the dep on stable ref
    // objects. The deps length is stable because a given call site always passes
    // the same shape (one ref, or the same-length array).
  }, [isActive, onOutside, ...(Array.isArray(refs) ? refs : [refs])])
}
