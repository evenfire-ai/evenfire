import type { FormFieldProps } from './types'

export function FormField({ label, children, className = '' }: FormFieldProps) {
  const classes = ['form-field', className].filter(Boolean).join(' ')

  return (
    <label className={classes}>
      <span className="form-field__label">{label}</span>
      {children}
    </label>
  )
}
