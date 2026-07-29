import type { LlmAllowedModel } from '@lib/api'

export type LlmDiscoveryPanelProps = {
  items: LlmAllowedModel[]
  loading: boolean
  onRefresh: () => Promise<void>
}
