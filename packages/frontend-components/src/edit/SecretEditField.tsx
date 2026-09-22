'use client'

import type { ChangeEvent } from 'react'
import type { SecretEditFieldProps } from './types'

export function SecretEditField({
  id,
  label,
  existingValue,
  state,
  onStateChange,
  disabled = false,
  placeholder = 'Enter a new value',
  helpText,
  clearLabel = 'Clear value',
  restoreLabel = 'Restore',
}: SecretEditFieldProps) {
  const inputValue = state.status === 'replaced' ? state.value : ''
  function change(event: ChangeEvent<HTMLInputElement>) {
    const next = event.currentTarget.value
    onStateChange(
      next
        ? { status: 'replaced', value: next }
        : state.status === 'replaced' || existingValue
          ? { status: 'cleared' }
          : { status: 'untouched' }
    )
  }

  return (
    <div className="eft-secret-field">
      <label className="eft-secret-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        autoComplete="new-password"
        className="eft-secret-field__input"
        disabled={disabled}
        id={id}
        onChange={change}
        placeholder={placeholder}
        type="password"
        value={inputValue}
      />
      {existingValue && state.status === 'untouched' ? (
        <p className="eft-secret-field__hint" id={`${id}-stored-hint`}>
          A value is stored. Leave this field blank to keep it.
        </p>
      ) : null}
      {helpText ? <div className="eft-secret-field__hint">{helpText}</div> : null}
      <div className="eft-secret-field__actions">
        <button
          className="eft-dialog__text-button"
          disabled={
            disabled ||
            state.status === 'cleared' ||
            (!existingValue && state.status === 'untouched')
          }
          onClick={() => onStateChange({ status: 'cleared' })}
          type="button"
        >
          {clearLabel}
        </button>
        <button
          className="eft-dialog__text-button"
          disabled={
            disabled ||
            !existingValue ||
            state.status === 'untouched' ||
            state.status === 'restored'
          }
          onClick={() => onStateChange({ status: 'restored' })}
          type="button"
        >
          {restoreLabel}
        </button>
      </div>
    </div>
  )
}
