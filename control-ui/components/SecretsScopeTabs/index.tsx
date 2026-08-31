'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { TabBar } from '../TabBar'

export type SecretsTabScope = 'llm' | 'llm-subscriptions' | 'mcp' | 'recipe'

export function SecretsScopeTabs({ activeValue }: { activeValue: SecretsTabScope }) {
  return (
    <TabBar<SecretsTabScope>
      ariaLabel="Secret scopes"
      activeValue={activeValue}
      className="cu-tabs--flush"
      options={[
        { value: 'llm', href: CONTROL_ROUTES.secrets.llm, label: 'LLM API keys' },
        {
          value: 'llm-subscriptions',
          href: CONTROL_ROUTES.secrets.llmSubscriptions,
          label: 'LLM subscriptions',
        },
        { value: 'mcp', href: CONTROL_ROUTES.secrets.connector, label: 'Connector' },
        { value: 'recipe', href: CONTROL_ROUTES.secrets.recipe, label: 'Recipe' },
      ]}
    />
  )
}
