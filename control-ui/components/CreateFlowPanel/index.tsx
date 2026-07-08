import { cn } from '@lib/cn'
import type { CreateFlowPanelProps } from './types'

export function CreateFlowPanel({ children, className, header }: CreateFlowPanelProps) {
  return (
    <div className={cn('cu-agent-create-panel cu-agent-create-panel--with-header', className)}>
      <div className="cu-agent-create-panel__header">{header}</div>
      {children}
    </div>
  )
}
