import type { CheckboxFieldProps } from './types'

export function CheckboxField({
  checked,
  className = '',
  description,
  disabled,
  label,
  onChange,
  ...props
}: CheckboxFieldProps) {
  const classes = ['cu-checkbox-field', disabled ? 'cu-checkbox-field--disabled' : '', className]
    .filter(Boolean)
    .join(' ')

  return (
    <label className={classes}>
      <input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" {...props} />
      <span className="cu-checkbox-field__content">
        <span className="cu-checkbox-field__label">{label}</span>
        {description ? <span className="cu-checkbox-field__description">{description}</span> : null}
      </span>
    </label>
  )
}
