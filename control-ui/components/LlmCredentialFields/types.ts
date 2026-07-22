import type { LlmProvider } from '@/lib/llm'

// An operator-created extra credential slot (spec R4.5.6). The slot OWNS its
// name draft and value; only a validated, non-colliding key is ever projected
// into the parent `draft` (`committedKey`). This guarantees editing an extra
// slot can never write to — and clobber — a real provider slot, and that an
// invalid/colliding key never reaches submit.
export type ExtraSlot = {
  id: string
  provider: LlmProvider
  nameInput: string
  value: string
  committedKey: string | null
  // The stored Secret key this slot was seeded from (edit mode, additive
  // editor spec B1) — exempted from the "already exists" collision check so
  // the operator can keep the name while rewriting the value. Null for slots
  // created in this session.
  existingKey: string | null
}

export type LlmCredentialFieldsProps = {
  // dataKey -> value. Write-only: existing values are NEVER passed in here (the
  // status-only listing returns names only, spec R4.5.3).
  draft: Record<string, string>
  onChange: (dataKey: string, value: string) => void
  disabled?: boolean
  // Keys already stored in the Secret (edit mode) — light up the present chips
  // without ever exposing a value. Create flows omit it.
  existingKeys?: string[]
}
