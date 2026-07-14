import type { TextInputProps } from './types'

export function TextInput({ className = '', ...props }: TextInputProps) {
  const classes = ['cu-input', className].filter(Boolean).join(' ')

  return <input className={classes} {...props} />
}
