'use client'

import React from 'react'
import { TabBar } from '@components/TabBar'
import type { TabBarOption } from '@components/TabBar/types'
import { CONTROL_ROUTES } from '@constants/routes'

export type LlmModelsTabValue = 'catalog' | 'discovery'

export type LlmModelsTabBarProps = {
  activeTab: LlmModelsTabValue
  catalogCount?: number
  discoveryReviewCount?: number
}

/**
 * Shared LLM Models section tabs. Subscriptions are broker-backed OAuth flows,
 * not API-key catalog rows, so Codex appears as its own tab beside Catalog.
 */
export function LlmModelsTabBar({
  activeTab,
  catalogCount,
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

  return (
    <TabBar<LlmModelsTabValue>
      activeValue={activeTab}
      ariaLabel="LLM model management"
      options={options}
    />
  )
}
