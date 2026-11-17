/**
 * What a Desktop build may declare it draws in an agent reply. The Host only
 * adds guidance for these values, so any other value is dropped here.
 */
const KNOWN_DISPLAY_CAPABILITIES: readonly string[] = ['mermaid']

/** The known capabilities named in a client-declared list, once each, in a fixed order. */
export function knownDisplayCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return KNOWN_DISPLAY_CAPABILITIES.filter(capability => value.includes(capability))
}
