import type { ReactNode } from 'react'
import type { LlmAllowedModel } from '@lib/api'

export type LlmDiscoveryPanelProps = {
  items: LlmAllowedModel[]
  loading: boolean
  navigation?: ReactNode
  onRefresh: () => Promise<void>
}
