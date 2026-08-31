'use client'

import React, { Fragment, useState } from 'react'
import { LlmProviderIcon } from '@/components/LlmProviderIcon'
import { cn } from '@/lib/cn'
import type { LlmSecretSelectOption, LlmSecretSelectProps } from './types'

export type { LlmSecretSelectOption, LlmSecretSelectProps } from './types'

function ProviderSummary({
  providers,
}: {
  providers: NonNullable<LlmSecretSelectOption['providers']>
}) {
  if (providers.length === 0) return null

  return (
    <span className="cu-agent-select__providers">
      <span className="cu-agent-select__providers-label">Providers: </span>
      {providers.map((provider, index) => (
        <Fragment key={provider.id}>
          {index > 0 ? ', ' : null}
          <span className="cu-agent-select__provider">
            <LlmProviderIcon provider={provider.id} label={provider.label} />
            <span>{provider.label}</span>
          </span>
        </Fragment>
      ))}
    </span>
  )
}

/**
 * The shared custom picker for linking an agent to an LLM Secret. The provider
 * list is derived from Secret data-key names, so each option can show the same
 * enabled-provider SVGs as the LLM Secrets table without exposing values.
 */
export function LlmSecretSelect({
  ariaLabel,
  className,
  disabled = false,
  id,
  onChange,
  options,
  placeholder,
  value,
}: LlmSecretSelectProps) {
  const [open, setOpen] = useState(false)
  const selectedOption = options.find(option => option.value === value)

  return (
    <div
      className={cn('cu-agent-select', className)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <button
        id={id}
        type="button"
        className="cu-agent-select__button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen(previous => !previous)}
      >
        <span className="cu-agent-select__button-copy">
          <span>{selectedOption?.label || placeholder}</span>
          {selectedOption?.providers && selectedOption.providers.length > 0 ? (
            <ProviderSummary providers={selectedOption.providers} />
          ) : selectedOption?.meta ? (
            <span className="cu-agent-select__button-meta">{selectedOption.meta}</span>
          ) : null}
        </span>
        <span className="cu-agent-select__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="cu-agent-select__menu" role="listbox" aria-label={ariaLabel}>
          {options.length === 0 ? (
            <span className="cu-agent-select__empty">No options available.</span>
          ) : (
            options.map((option, index) => (
              <Fragment key={option.value}>
                {option.group && option.group !== options[index - 1]?.group ? (
                  <span className="cu-agent-select__empty">{option.group}</span>
                ) : null}
                <button
                  type="button"
                  className="cu-agent-select__option"
                  data-active={value === option.value ? 'true' : 'false'}
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="cu-agent-select__option-copy">
                    <span className="cu-agent-select__option-name">{option.label}</span>
                    {option.providers && option.providers.length > 0 ? (
                      <ProviderSummary providers={option.providers} />
                    ) : option.meta ? (
                      <span className="cu-agent-select__option-meta">{option.meta}</span>
                    ) : null}
                  </span>
                </button>
              </Fragment>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
