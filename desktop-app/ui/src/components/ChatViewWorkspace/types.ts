import type { ReactNode } from 'react'
import type { ChatTabsProps } from '../ChatTabs/types'

export type ChatViewWorkspaceProps = ChatTabsProps & {
  children: ReactNode
  localSearch?: ReactNode
  surfaceId?: string
}
