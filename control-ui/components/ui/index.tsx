'use client'

import React from 'react'
import { cn } from '@lib/cn'
import type {
  ButtonProps,
  CheckboxFieldProps,
  FieldProps,
  FormSectionProps,
  SelectInputProps,
  TextAreaInputProps,
  TextInputProps,
} from './types'

export function Button({
  block = false,
  className,
  size = 'md',
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'cu-btn',
        variant === 'primary' && 'cu-btn--primary',
        variant === 'ghost' && 'cu-btn--ghost',
        variant === 'danger' && 'cu-btn--danger',
        size === 'sm' && 'cu-btn--sm',
        block && 'cu-btn--block',
        className
      )}
      type={type}
      {...props}
    />
  )
}

export function Field({ children, description, error, htmlFor, label, required }: FieldProps) {
  return (
    <div className="cu-field">
      {label ? (
        <label htmlFor={htmlFor}>
          {label}
          {required ? <span className="cu-field__required"> *</span> : null}
        </label>
      ) : null}
      {children}
      {description ? <span className="cu-field__hint">{description}</span> : null}
      {error ? <span className="cu-field__error">{error}</span> : null}
    </div>
  )
}

export function FormSection({ children, description, title }: FormSectionProps) {
  return (
    <section className="cu-form-section">
      <div className="cu-form-section__header">
        <h3 className="cu-form-section__title">{title}</h3>
        {description ? <p className="cu-form-section__description">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function TextInput({
  className,
  compact = false,
  invalid = false,
  monospace = false,
  narrow = false,
  ...props
}: TextInputProps) {
  return (
    <input
      className={cn(
        'cu-input',
        monospace && 'cu-input--monospace',
        compact && 'cu-input--compact',
        narrow && 'cu-input--narrow',
        invalid && 'cu-input--invalid',
        className
      )}
      {...props}
    />
  )
}

export function SelectInput({
  children,
  className,
  compact = false,
  invalid = false,
  narrow = false,
  ...props
}: SelectInputProps) {
  return (
    <select
      className={cn(
        'cu-input',
        compact && 'cu-input--compact',
        narrow && 'cu-input--narrow',
        invalid && 'cu-input--invalid',
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export function TextAreaInput({
  className,
  invalid = false,
  monospace = false,
  ...props
}: TextAreaInputProps) {
  return (
    <textarea
      className={cn(
        'cu-input',
        monospace && 'cu-input--monospace',
        invalid && 'cu-input--invalid',
        className
      )}
      {...props}
    />
  )
}

export function CheckboxField({
  checked,
  className,
  description,
  disabled,
  label,
  onChange,
  ...props
}: CheckboxFieldProps) {
  return (
    <label
      className={cn('cu-checkbox-field', disabled && 'cu-checkbox-field--disabled', className)}
    >
      <input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" {...props} />
      <span className="cu-checkbox-field__content">
        <span className="cu-checkbox-field__label">{label}</span>
        {description ? <span className="cu-checkbox-field__description">{description}</span> : null}
      </span>
    </label>
  )
}
