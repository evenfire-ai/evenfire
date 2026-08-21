'use client'

import React from 'react'
import { LlmProviderIcon } from '@components/LlmProviderIcon'
import { IconChevronRight } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'

/**
 * Catalog entry for the broker-backed Codex subscription provider. Shown on the
 * LLM Models catalog tab only after Control API proves the feature flag.
 */
export function CodexSubscriptionCatalogLink() {
  return (
    <a
      href={CONTROL_ROUTES.llmModels.codexSubscription}
      className="cu-codex-subscription-entry"
      aria-label="Codex subscription"
      data-testid="codex-subscription-catalog-link"
    >
      <span className="cu-codex-subscription-entry__brand" aria-hidden="true">
        <LlmProviderIcon provider="openai" label="OpenAI" />
        <LlmProviderIcon provider="codex-subscription" label="Codex subscription" />
      </span>
      <span className="cu-codex-subscription-entry__copy">
        <span className="cu-codex-subscription-entry__title">Codex subscription</span>
        <span className="cu-codex-subscription-entry__subtitle">
          Connect OpenAI Codex through the OAuth broker — no API keys in the browser.
        </span>
      </span>
      <IconChevronRight
        className="cu-codex-subscription-entry__chevron"
        width={18}
        height={18}
        aria-hidden
      />
    </a>
  )
}
