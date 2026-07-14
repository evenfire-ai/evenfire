import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react'

export type ReferenceTagKind = 'agent' | 'connector' | 'context' | 'team' | 'user'

export type ReferenceTagProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  children: ReactNode
  className?: string
  disabled?: boolean
  kind?: ReferenceTagKind
  onClick?: MouseEventHandler<HTMLButtonElement>
}
