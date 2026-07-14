import type { SelectControlProps } from './types'

export function SelectControl({ className = '', ...props }: SelectControlProps) {
  const classes = ['cu-input', className].filter(Boolean).join(' ')

  return <select className={classes} {...props} />
}
