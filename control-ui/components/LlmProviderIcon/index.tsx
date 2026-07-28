'use client'

import React from 'react'
import type { LlmProviderIconProps } from './types'

export type { LlmProviderIconProps } from './types'

/**
 * The provider brand mark used by every LLM provider picker (agents LLM config,
 * the additive secrets editor). Purely decorative — the option/button label
 * carries the accessible name — so the wrapper stays `aria-hidden`. When the SVG
 * under `/provider-icons/` is missing or fails to load it degrades to the
 * provider label's initial; the failure flag resets whenever the provider
 * changes so a recycled icon slot retries the new asset.
 */
export function LlmProviderIcon({ provider, label }: LlmProviderIconProps) {
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => setFailed(false), [provider])

  return (
    <span className="cu-llm-provider-icon" aria-hidden="true" data-provider={provider}>
      {failed ? (
        <span>{label.slice(0, 1).toUpperCase()}</span>
      ) : (
        <img src={`/provider-icons/${provider}.svg`} alt="" onError={() => setFailed(true)} />
      )}
    </span>
  )
}
