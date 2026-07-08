import { joinClasses } from '@lib/classNames'
import type { SelectInputProps } from './types'

export function SelectInput({ children, className, dense = false, ...props }: SelectInputProps) {
  return (
    <select
      className={joinClasses('ui-control', dense && 'ui-control--dense', className)}
      {...props}
    >
      {children}
    </select>
  )
}

export type { SelectInputProps } from './types'
