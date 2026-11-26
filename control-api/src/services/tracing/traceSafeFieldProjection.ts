import type { SafeEventPayloadV1 } from './contracts.js'

export type TraceSafeFieldProfile = 'session' | 'administrative' | 'infrastructure'

const PROFILE_KEYS: Record<TraceSafeFieldProfile, ReadonlySet<keyof SafeEventPayloadV1>> = {
  session: new Set([
    'reason_code',
    'error_class',
    'phase',
    'state',
    'status',
    'transition',
    'resource_class',
    'unit',
    'tool_name',
    'tool_kind',
    'tool_source_ref',
    'model',
    'attempt',
    'count',
    'config_hash',
  ]),
  administrative: new Set([
    'reason_code',
    'status',
    'resource_class',
    'summary',
    'detail_ref',
    'target_label',
    'target_principal_kind',
    'target_principal_ref',
    'count',
    'config_hash',
  ]),
  infrastructure: new Set([
    'reason_code',
    'error_class',
    'state',
    'status',
    'transition',
    'resource_class',
    'unit',
    'count',
    'config_hash',
  ]),
}

const SHORT_TOKEN_KEYS = new Set<keyof SafeEventPayloadV1>([
  'reason_code',
  'error_class',
  'phase',
  'state',
  'status',
  'transition',
  'resource_class',
  'unit',
])
const LONG_TOKEN_KEYS = new Set<keyof SafeEventPayloadV1>([
  'detail_ref',
  'target_label',
  'target_principal_kind',
  'target_principal_ref',
  'tool_name',
  'tool_kind',
  'tool_source_ref',
  'model',
])
const INTEGER_KEYS = new Set<keyof SafeEventPayloadV1>(['attempt', 'count'])
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
/**
 * The longest `summary` the administrative profile discloses. The Host
 * approval audit keeps its summaries within it
 * (`MAX_APPROVAL_CHANGE_SUMMARY_LENGTH` in services/hostApprovalAudit.ts).
 */
export const MAX_TRACE_SUMMARY_LENGTH = 4096
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/
const SHA256_RE = /^[0-9a-f]{64}$/
const SENSITIVE_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|bearer\s|basic\s|private[_ -]?key|^sk-|^ghp_|^xox[baprs]-|^eyJ[A-Za-z0-9_-]*\.)/i

function disclosedValue(key: keyof SafeEventPayloadV1, value: unknown): string | number | null {
  if (key === 'target_label') {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{3,64}$/.test(value) ? value : null
  }
  if (key === 'target_principal_kind') {
    return typeof value === 'string' && ['operator', 'host', 'context', 'service'].includes(value)
      ? value
      : null
  }
  if (key === 'target_principal_ref') {
    return typeof value === 'string' && value.length <= 256 && TOKEN_RE.test(value) ? value : null
  }
  if (SHORT_TOKEN_KEYS.has(key) || LONG_TOKEN_KEYS.has(key)) {
    if (typeof value !== 'string') return null
    const maxLength = SHORT_TOKEN_KEYS.has(key) ? 64 : 128
    if (
      value.length === 0 ||
      value.length > maxLength ||
      !TOKEN_RE.test(value) ||
      SENSITIVE_RE.test(value)
    ) {
      return null
    }
    return value
  }
  if (key === 'summary') {
    // The administrative profile only (spec §6.8): the intended Host approval
    // change as JSON. Free text, so it is bounded, not token-checked.
    return typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_TRACE_SUMMARY_LENGTH &&
      !CONTROL_CHARACTER_RE.test(value)
      ? value
      : null
  }
  if (INTEGER_KEYS.has(key)) {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 2_147_483_647
      ? value
      : null
  }
  if (key === 'config_hash') {
    return typeof value === 'string' && SHA256_RE.test(value) ? value : null
  }
  return null
}

export function projectTraceSafeFields(
  value: unknown,
  profile: TraceSafeFieldProfile
): SafeEventPayloadV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = PROFILE_KEYS[profile]
  const projected: SafeEventPayloadV1 = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey as keyof SafeEventPayloadV1
    if (!allowed.has(key)) continue
    const disclosed = disclosedValue(key, rawValue)
    if (disclosed !== null) (projected as Record<string, string | number>)[key] = disclosed
  }
  if (
    !projected.target_principal_kind ||
    !projected.target_principal_ref ||
    (projected.target_principal_kind === 'operator'
      ? projected.target_principal_ref !== 'operator:'
      : !projected.target_principal_ref.startsWith(`${projected.target_principal_kind}:`))
  ) {
    delete projected.target_principal_kind
    delete projected.target_principal_ref
  }
  return projected
}
