import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { TextInputProps } from './types'

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, dense = false, ...props },
  ref
) {
  return (
    <input
      className={joinClasses('ui-control', dense && 'ui-control--dense', className)}
      ref={ref}
      {...props}
    />
  )
})

export type { TextInputProps } from './types'
