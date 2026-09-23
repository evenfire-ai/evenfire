'use client'

import { useId } from 'react'
import { classNames } from './utils'

export function TruncatedText({
  className,
  maxLength = 80,
  value,
}: {
  className?: string
  maxLength?: number
  value: string | null | undefined
}) {
  const text = String(value || '').trim()
  const display = text || '-'
  const isTruncated = text.length > maxLength
  const visible = isTruncated ? `${text.slice(0, maxLength).trimEnd()}...` : display
  const tooltipId = useId()

  return (
    <span
      aria-describedby={isTruncated ? tooltipId : undefined}
      className={classNames('eft-truncated-text', className)}
      tabIndex={isTruncated ? 0 : undefined}
    >
      <span className="eft-truncated-text__value">{visible}</span>
      {isTruncated ? (
        <span className="eft-truncated-text__tooltip" id={tooltipId} role="tooltip">
          {text}
        </span>
      ) : null}
    </span>
  )
}
