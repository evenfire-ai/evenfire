'use client'

import { Children, isValidElement, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

function getDescriptionText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement<{ children?: ReactNode }>(node)) return ''
  return Children.toArray(node.props.children).map(getDescriptionText).join('')
}

export function ClampedDescription({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLSpanElement>(null)
  const descriptionId = useId()
  const [isTruncated, setIsTruncated] = useState(false)

  const tooltipText = Children.toArray(children).map(getDescriptionText).join('')

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
  }, [children])

  return (
    <span
      aria-describedby={isTruncated ? descriptionId : undefined}
      className="cu-table-panel__description"
      tabIndex={isTruncated ? 0 : undefined}
    >
      <span ref={contentRef} className="cu-table-panel__description-value">
        {children}
      </span>
      {isTruncated ? (
        <>
          <span className="sr-only" id={descriptionId}>
            {tooltipText}
          </span>
          <span aria-hidden="true" className="cu-table-panel__description-tooltip" role="tooltip">
            {tooltipText}
          </span>
        </>
      ) : null}
    </span>
  )
}
