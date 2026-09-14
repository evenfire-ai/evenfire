'use client'

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export function ClampedDescription({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLSpanElement>(null)
  const tooltipId = useId()
  const [isTruncated, setIsTruncated] = useState(false)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return

    const measure = () => setIsTruncated(content.scrollHeight > content.clientHeight + 1)
    measure()

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(content)
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return (
    <span
      aria-describedby={isTruncated ? tooltipId : undefined}
      className="cu-table-panel__description"
      tabIndex={isTruncated ? 0 : undefined}
    >
      <span ref={contentRef} className="cu-table-panel__description-value">
        {children}
      </span>
      {isTruncated ? (
        <span className="cu-table-panel__description-tooltip" id={tooltipId} role="tooltip">
          {children}
        </span>
      ) : null}
    </span>
  )
}
