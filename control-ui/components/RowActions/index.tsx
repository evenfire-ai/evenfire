'use client'

import { IconChevronRight } from '@components/icons'
import { Button } from '@components/ui'
import { cn } from '@lib/cn'
import { RowActionsMenu } from '../RowActionsMenu'
import type { RowAction, RowActionKind, RowActionsProps } from './types'

const KIND_ORDER: RowActionKind[] = ['utility', 'edit', 'destructive', 'inspect']

/** Kinds that stay one click away even when the row overflows. */
const ALWAYS_INLINE: RowActionKind[] = ['destructive', 'inspect']

function byKind(a: RowAction, b: RowAction) {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
}

/**
 * The single row-action surface for route tables. It fixes the order and the
 * affordance vocabulary and leaves the set of actions to the caller, because
 * rows legitimately differ: a file row has more operations than a plugin row,
 * and an unpriced model row cannot be deleted at all.
 */
export function RowActions({ actions, className, overflowAfter = 3 }: RowActionsProps) {
  const ordered = actions.filter(action => !action.hidden).sort(byKind)
  const overflows = ordered.length > overflowAfter

  const collapsed = overflows ? ordered.filter(action => !ALWAYS_INLINE.includes(action.kind)) : []
  const inline = overflows ? ordered.filter(action => ALWAYS_INLINE.includes(action.kind)) : ordered

  return (
    <div className={cn('cu-row-actions', className)}>
      {collapsed.length > 0 ? (
        <RowActionsMenu
          ariaLabel="More actions"
          actions={collapsed.map(action => ({
            key: action.key,
            label: action.label,
            onClick: action.onSelect,
            disabled: action.disabled,
          }))}
        />
      ) : null}
      {inline.map(action => {
        const destructive = action.kind === 'destructive'
        return (
          <Button
            key={action.key}
            aria-label={action.label}
            disabled={action.disabled}
            icon
            onClick={action.onSelect}
            toolbar={!destructive}
            variant={destructive ? 'ghost-danger' : 'secondary'}
          >
            {action.kind === 'inspect' ? <IconChevronRight width={16} height={16} /> : action.icon}
          </Button>
        )
      })}
    </div>
  )
}
