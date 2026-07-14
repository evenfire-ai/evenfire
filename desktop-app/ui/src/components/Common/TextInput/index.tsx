import { joinClasses } from '@lib/classNames'
import type { TextInputProps } from './types'

export function TextInput({ className, dense = false, ...props }: TextInputProps) {
  return (
    <input
      className={joinClasses('ui-control', dense && 'ui-control--dense', className)}
      {...props}
    />
  )
}

export type { TextInputProps } from './types'
