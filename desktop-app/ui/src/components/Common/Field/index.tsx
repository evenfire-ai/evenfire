import { joinClasses } from '@lib/classNames'
import type { FieldProps } from './types'

export function Field({
  children,
  hint,
  label,
  htmlFor,
  labelClassName,
  wrapperClassName,
}: FieldProps) {
  return (
    <div className={joinClasses('ui-field', wrapperClassName)}>
      {label ? (
        <label className={joinClasses('ui-field__label', labelClassName)} htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {hint ? <span className="ui-field__hint">{hint}</span> : null}
    </div>
  )
}

export type { FieldProps } from './types'
