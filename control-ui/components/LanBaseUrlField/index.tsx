'use client'

import { Field, TextInput } from '@/components/ui'
import { LLM_LAN_BASE_URL_PLACEHOLDER, validateLlmLanBaseUrl } from '@/lib/llm'
import type { LanBaseUrlFieldProps } from './types'

/**
 * The LAN endpoint (`baseURL`) input for a local `openai-compatible` target —
 * the primary model block and every fallback row that selects the local
 * provider share this control. The endpoint must be a private-LAN IPv4 literal
 * (the CRD/CEL requires it and the control-api admission gate is authoritative);
 * `validateLlmLanBaseUrl` mirrors that rule inline for immediate feedback and
 * reuses the shared `@clerum/egress-policy` classifier so the UI can't drift
 * from the backend.
 */
export function LanBaseUrlField({
  id,
  value,
  onChange,
  disabled = false,
  label = 'LAN endpoint (baseURL)',
}: LanBaseUrlFieldProps) {
  const error = validateLlmLanBaseUrl(value)
  return (
    <Field
      htmlFor={id}
      label={label}
      description="A private-LAN IPv4 endpoint (e.g. an on-prem OpenAI-compatible server). DNS names, localhost, and cluster-internal addresses are not allowed."
      error={error ?? undefined}
    >
      <TextInput
        id={id}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={LLM_LAN_BASE_URL_PLACEHOLDER}
        invalid={Boolean(error)}
        disabled={disabled}
      />
    </Field>
  )
}
