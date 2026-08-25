'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { TabBar } from '../TabBar'

export type SecretsTabScope = 'llm' | 'mcp' | 'recipe'

export function SecretsScopeTabs({ activeValue }: { activeValue: SecretsTabScope }) {
  return (
    <TabBar<SecretsTabScope>
      ariaLabel="Secret scopes"
      activeValue={activeValue}
      className="cu-tabs--flush"
      options={[
        { value: 'llm', href: CONTROL_ROUTES.secrets.llm, label: 'LLM' },
        { value: 'mcp', href: CONTROL_ROUTES.secrets.connector, label: 'Connector' },
        { value: 'recipe', href: CONTROL_ROUTES.secrets.recipe, label: 'Recipe' },
      ]}
    />
  )
}
