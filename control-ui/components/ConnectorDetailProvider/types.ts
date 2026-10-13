import type { ReactNode } from 'react'
import type { McpServerResource } from '@lib/api'

export type ConnectorDetailState = {
  server: McpServerResource | null
  loading: boolean
  error: string
  load: () => Promise<void>
}

export type ConnectorDetailProviderProps = {
  children: ReactNode
}
