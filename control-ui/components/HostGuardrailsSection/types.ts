// Phases keying `Host.spec.guardrails.hooks`. Each maps to an ordered list of
// installed-hook references (id + pinned digest).
export type GuardrailPhase =
  | 'preToolUse'
  | 'postToolUse'
  | 'preCall'
  | 'moderate'
  | 'postCallSuccess'
  | 'onError'

export type GuardrailHookRef = { id: string; digest?: string }

// Built-in guardrails supported by the minimal add UI. The stored `type` is a
// free string on the CR; the picker offers this curated subset.
export type GuardrailBuiltinType = 'prompt-shaping' | 'token-trim'

export type GuardrailBuiltin = {
  type: string
  order?: number
  failMode?: 'open' | 'closed'
  timeoutMs?: number
  config?: Record<string, unknown>
}

// Structured view over `Host.spec.guardrails` (typed `AnyRecord` in lib/api).
// Fields this section does not edit (rules, trust level, ceiling, limits) are
// carried through untouched so a save never drops them.
export type HostGuardrails = {
  rules?: unknown[]
  hooks?: Partial<Record<GuardrailPhase, GuardrailHookRef[]>>
  builtins?: GuardrailBuiltin[]
  minInstalledHookTrustLevel?: string
  capabilityCeiling?: string[]
  limits?: Record<string, unknown>
}

export interface HostGuardrailsSectionProps {
  initialGuardrails: HostGuardrails | undefined
  // Persist the full guardrails object (parent merges it into the Host spec
  // under the resourceVersion precondition). Rejects on failure so the section
  // keeps the operator's draft.
  onSave: (next: HostGuardrails) => Promise<void>
  busy: boolean
  canWrite: boolean
  // Render the editable list immediately instead of the read-only summary.
  defaultEditing?: boolean
}
