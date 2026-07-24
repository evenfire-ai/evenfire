/**
 * Shared locator filters for asserting the chat composer is bound to the
 * EXACT agent under test.
 */

/**
 * Anchored exact-name filter for `Locator.filter()`.
 *
 * `filter({ hasText: string })` is SUBSTRING matching: 'chatllm' would accept
 * a composer bound to 'chatllm-stateless'. Anchor it so binding can only be
 * satisfied by the exact agent.
 */
export function exactNameFilter(name: string): { hasText: RegExp } {
  return {
    hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`),
  }
}
