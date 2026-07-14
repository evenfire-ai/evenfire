/**
 * Resolves final input values with 4-layer precedence:
 *   inputContract.defaults << inputs << profiles[activeProfile] << computedValues
 *
 * Left-most is lowest priority, right-most wins.
 */
export function resolve(
  inputs: Record<string, unknown>,
  inputContract?: Record<string, unknown>,
  profiles?: Record<string, Record<string, unknown>>,
  activeProfile?: string,
  computedValues?: Record<string, unknown>
): Record<string, unknown> {
  // Layer 1: Extract defaults from inputContract JSON Schema
  const defaults = extractSchemaDefaults(inputContract)
  let result = { ...defaults }

  // Layer 2: user inputs override schema defaults
  result = { ...result, ...inputs }

  // Layer 3: active profile overrides inputs
  if (activeProfile && profiles) {
    const profile = profiles[activeProfile]
    if (!profile) {
      throw new Error(
        `Profile "${activeProfile}" not found. Available: [${Object.keys(profiles).join(', ')}]`
      )
    }
    result = { ...result, ...profile }
  }

  // Layer 4: computed values override everything
  if (computedValues) {
    result = { ...result, ...computedValues }
  }

  return result
}

/**
 * Extract default values from a JSON Schema's "properties" definitions.
 */
export function extractSchemaDefaults(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || !schema.properties) return {}
  const props = schema.properties as Record<string, Record<string, unknown>>
  const defaults: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(props)) {
    if ('default' in def) {
      defaults[key] = def.default
    }
  }
  return defaults
}
