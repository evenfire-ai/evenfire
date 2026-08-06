import { useId } from 'react'
import { IconInfoCircle } from '@components/icons'
import type { GuideImageTooltipProps } from './types'

export function GuideImageTooltip({ alt, image, label = 'Show example' }: GuideImageTooltipProps) {
  const tooltipId = useId()
  return (
    <span className="cu-guide-image-tooltip">
      <button
        type="button"
        className="cu-guide-image-tooltip__trigger"
        aria-label={label}
        aria-describedby={tooltipId}
        title={label}
      >
        <IconInfoCircle width={15} height={15} />
      </button>
      <span id={tooltipId} className="cu-guide-image-tooltip__preview" role="tooltip">
        <img src={image} alt={alt} />
      </span>
    </span>
  )
}
