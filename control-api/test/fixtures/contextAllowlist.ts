import type { Mock } from 'vitest'
import { config } from '../../src/config.js'
import { attachServerToContext } from '../../src/services/contextAllowlist.js'
import type { MockGateway } from '../mockGateway.js'

/**
 * Seed a Context CR (CRD-required fields only) and write its allowlist through
 * the real allowlist writer, so the `spec.mcpServers` shape the access gates
 * read is the one production writes.
 */
export async function seedAllowlistedContext(
  gateway: MockGateway,
  name: string,
  servers: string[],
  namespace: string = config.mcpServersNamespace
): Promise<void> {
  await gateway.createResource(
    'contexts',
    { metadata: { name }, spec: { contextId: name, mcpServers: [] } },
    namespace
  )
  for (const server of servers) {
    await attachServerToContext(gateway as never, { name, namespace }, server)
  }
}

/**
 * Answer `getUserContexts` (the `FROM user_contexts` read) with `contextIds` on
 * the suite's mocked `pool.query`; every other query resolves empty.
 */
export function memberOf(poolQuery: Mock, contextIds: string[]): void {
  poolQuery.mockImplementation((sql: unknown) => {
    const text = typeof sql === 'string' ? sql : ''
    if (text.includes('FROM user_contexts')) {
      return Promise.resolve({
        rows: contextIds.map(context_id => ({ context_id })),
        rowCount: contextIds.length,
      })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
}
