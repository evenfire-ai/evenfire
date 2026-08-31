'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { TabBar } from '../TabBar'

export type LlmSecretsSubTab = 'api-key' | 'subscriptions'

export function LlmSecretsSubTabs({ activeValue }: { activeValue: LlmSecretsSubTab }) {
  return (
    <TabBar<LlmSecretsSubTab>
      ariaLabel="LLM secret kinds"
      activeValue={activeValue}
      className="cu-tabs--flush cu-tabs--nested"
      options={[
        { value: 'api-key', href: CONTROL_ROUTES.secrets.llm, label: 'API-KEY' },
        {
          value: 'subscriptions',
          href: CONTROL_ROUTES.secrets.llmSubscriptions,
          label: 'Subscriptions',
        },
      ]}
    />
  )
}
