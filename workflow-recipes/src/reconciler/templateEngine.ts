/**
 * Custom error for unresolved template references.
 */
export class UnresolvedTemplateError extends Error {
  constructor(public readonly ref: string) {
    super(`Unresolved template reference: "${ref}"`)
    this.name = 'UnresolvedTemplateError'
  }
}

/**
 * Custom error for template injection attempts.
 */
export class TemplateInjectionError extends Error {
  constructor(public readonly ref: string) {
    super(`Template injection blocked: "${ref}"`)
    this.name = 'TemplateInjectionError'
  }
}

/** Dangerous property names that must be blocked. */
const BLOCKED_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
])

/**
 * Template context for resolving references.
 */
export interface TemplateContext {
  inputs?: Record<string, unknown>
  workloads?: Map<string, { host: string; port: string }>
  resources?: Map<string, Record<string, string>>
  computed?: Record<string, unknown>
}

/**
 * Resolve all {{...}} references in a string.
 *
 * Supported syntaxes:
 * - {{inputs.name}}           → resolved inputs value
 * - {{workload-id:host}}      → workload service FQDN
 * - {{workload-id:port}}      → workload port
 * - {{resource-id:KEY}}       → value from ConfigMap/Secret
 * - {{computed.name}}         → computed value
 */
export function resolve(template: string, context: TemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, ref: string) => {
    const trimmed = ref.trim()

    // Check for injection attempts
    const dotParts = trimmed.split('.')
    for (const part of dotParts) {
      if (BLOCKED_KEYS.has(part)) {
        throw new TemplateInjectionError(trimmed)
      }
    }

    const colonParts = trimmed.split(':')
    for (const part of colonParts) {
      if (BLOCKED_KEYS.has(part)) {
        throw new TemplateInjectionError(trimmed)
      }
    }

    // Resolve inputs.* references
    if (trimmed.startsWith('inputs.')) {
      const key = trimmed.substring('inputs.'.length)
      const value = context.inputs?.[key]
      if (value === undefined) {
        throw new UnresolvedTemplateError(trimmed)
      }
      return String(value)
    }

    // Resolve computed.* references
    if (trimmed.startsWith('computed.')) {
      const key = trimmed.substring('computed.'.length)
      const value = context.computed?.[key]
      if (value === undefined) {
        throw new UnresolvedTemplateError(trimmed)
      }
      return String(value)
    }

    // Resolve workload:field and resource:KEY references
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':')
      const id = trimmed.substring(0, colonIdx)
      const field = trimmed.substring(colonIdx + 1)

      // Try workload references
      const workload = context.workloads?.get(id)
      if (workload) {
        if (field === 'host') return workload.host
        if (field === 'port') return workload.port
      }

      // Try resource references
      const resource = context.resources?.get(id)
      if (resource && Object.prototype.hasOwnProperty.call(resource, field)) {
        return resource[field]
      }
    }

    throw new UnresolvedTemplateError(trimmed)
  })
}
