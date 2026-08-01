'use client'

import React, { useId } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { getProviderDisplayLabel } from '@lib/llm'
import { IconAlertTriangle } from '../icons'
import type { MissingPriceWarningProps } from './types'

export function MissingPriceWarning({ model, priceId, provider }: MissingPriceWarningProps) {
  const descriptionId = useId()
  const providerLabel = provider ? getProviderDisplayLabel(provider) : null
  const modelLabel = providerLabel ? `${providerLabel}/${model}` : model
  const actionHref = priceId
    ? CONTROL_ROUTES.costAndUsage.editLlmPrice(priceId)
    : CONTROL_ROUTES.costAndUsage.newLlmPrice({ provider, model })

  return (
    <span className="cu-missing-price">
      <button
        type="button"
        className="cu-missing-price__trigger"
        aria-label={`${modelLabel} has no enabled price`}
        aria-describedby={descriptionId}
      >
        <IconAlertTriangle width={15} height={15} />
      </button>
      <span id={descriptionId} className="cu-missing-price__popover" role="note">
        <strong>No enabled price</strong>
        <span>Cost budgets may under-count spend for this model.</span>
        <Link href={actionHref} className="cu-link cu-missing-price__cta">
          {priceId ? 'Review price' : 'Add price'}
        </Link>
      </span>
    </span>
  )
}
