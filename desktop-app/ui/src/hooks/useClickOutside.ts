import { useEffect } from 'react'
import type { RefObject } from 'react'

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  isActive: boolean,
  onOutside: () => void
) {
  useEffect(() => {
    if (!isActive) return

    const handleClickOutside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onOutside()
      }
    }

    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [isActive, onOutside, ref])
}
