/**
 * Reads a default-on boolean switch from the environment.
 *
 * Unset, empty and `true` mean on; `false` means off. Any other value is a
 * configuration error and throws, so a typo fails loudly instead of silently
 * picking a state.
 *
 * Kept in its own module, free of side effects, so request-time readers can
 * import it without loading `config.ts` (tests often replace that module with a
 * bare mock).
 */
export function defaultOnBooleanFromEnv(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '' || raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be 'true' or 'false' (got '${raw}')`)
}
