import { RFC1123_MAX_LENGTH } from './k8sValidation'
import { toKebabCase } from './string'

const CONTEXT_SUFFIX_LENGTH = 5
const CONTEXT_SUFFIX_MAX = 10 ** CONTEXT_SUFFIX_LENGTH

function createShortContextSuffix(): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const values = new Uint32Array(1)
    globalThis.crypto.getRandomValues(values)
    return String(values[0] % CONTEXT_SUFFIX_MAX).padStart(CONTEXT_SUFFIX_LENGTH, '0')
  }

  return String(Math.floor(Math.random() * CONTEXT_SUFFIX_MAX)).padStart(CONTEXT_SUFFIX_LENGTH, '0')
}

/**
 * Creates the private context name used by the agent creation flow.
 *
 * The context is an implementation detail of an agent, so its name is not
 * shown in the wizard. Keep the agent prefix for operational traceability and
 * add a short suffix so deleting and recreating an agent never reuses a stale
 * context name. The result remains a valid RFC 1123 label.
 */
export function createAgentContextName(agentName: string): string {
  const normalizedAgentName = toKebabCase(agentName) || 'agent'
  const maxPrefixLength = RFC1123_MAX_LENGTH - CONTEXT_SUFFIX_LENGTH - 1
  const prefix = normalizedAgentName.slice(0, maxPrefixLength).replace(/-+$/g, '') || 'agent'
  return `${prefix}-${createShortContextSuffix()}`
}
