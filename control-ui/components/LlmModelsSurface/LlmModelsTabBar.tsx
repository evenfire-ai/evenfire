'use client'

import React from 'react'
import { TabBar } from '@components/TabBar'
import type { TabBarOption } from '@components/TabBar/types'
import { CONTROL_ROUTES } from '@constants/routes'

export type LlmModelsTabValue = 'catalog' | 'discovery' | 'codex-subscription'

export type LlmModelsTabBarProps = {
  activeTab: LlmModelsTabValue
  catalogCount?: number
  codexEnabled?: boolean
  discoveryReviewCount?: number
}

/**
 * Shared LLM Models section tabs. Subscriptions are broker-backed OAuth flows,
 * not API-key catalog rows, so Codex appears as its own tab beside Catalog.
 */
export function LlmModelsTabBar({
  activeTab,
  catalogCount,
  codexEnabled = false,
  discoveryReviewCount = 0,
}: LlmModelsTabBarProps) {
  const options: TabBarOption<LlmModelsTabValue>[] = [
    {
      value: 'catalog' as const,
      href: CONTROL_ROUTES.llmModels.root,
      label:
        catalogCount !== undefined && catalogCount > 0 ? `Catalog (${catalogCount})` : 'Catalog',
    },
    {
      value: 'discovery' as const,
      href: CONTROL_ROUTES.llmModels.discovery,
      label:
        discoveryReviewCount > 0
          ? `Discovery review (${discoveryReviewCount})`
          : 'Discovery review',
    },
  ]

  if (codexEnabled) {
    options.push({
      value: 'codex-subscription' as const,
      href: CONTROL_ROUTES.llmModels.codexSubscription,
      label: 'Codex subscription',
    })
  }

  return (
    <TabBar<LlmModelsTabValue>
      activeValue={activeTab}
      ariaLabel="LLM model management"
      options={options}
    />
  )
}
