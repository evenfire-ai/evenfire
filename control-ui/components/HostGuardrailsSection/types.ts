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

export type GuardrailBuiltin = {
  type: string
  order?: number
  failMode?: 'open' | 'closed'
  timeoutMs?: number
  config?: Record<string, unknown>
}

// Structured view over `Host.spec.guardrails` (typed `AnyRecord` in lib/api).
// This section edits `hooks` and nothing else — `builtins`, rules, trust level,
// ceiling and limits are carried through untouched so a save never drops them.
export type HostGuardrails = {
  rules?: unknown[]
  hooks?: Partial<Record<GuardrailPhase, GuardrailHookRef[]>>
  builtins?: GuardrailBuiltin[]
  minInstalledHookTrustLevel?: string
  capabilityCeiling?: string[]
  limits?: Record<string, unknown>
}

// One table row: a single hook reference under a single phase. A hook that runs
// at two phases is two rows, which is also how it is stored.
export type GuardrailHookRow = {
  phase: GuardrailPhase
  ref: GuardrailHookRef
}

export interface HostGuardrailsSectionProps {
  initialGuardrails: HostGuardrails | undefined
  // Persist the full guardrails object (parent merges it into the Host spec
  // under the resourceVersion precondition). Rejects on failure so the section
  // can leave the operator's view untouched.
  onSave: (next: HostGuardrails) => Promise<void>
  busy: boolean
  canWrite: boolean
}
