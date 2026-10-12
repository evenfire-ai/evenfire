import { describe, expect, it } from 'vitest'
import { bestEffortRfc7592Delete } from '../src/oauth/dcrCleanup.js'

/**
 * C4/K (DEC-18) — best-effort RFC 7592 client-delete at the AS. The full server
 * teardown moved to `mcpServerOAuthTeardown.ts` (fenced by cr_uid, R3-H5) and is
 * covered by its real-Postgres suite; this pins the courtesy revocation's
 * failure-swallowing contract shared by the saga rollback and the teardown module.
 */

const PUBLIC_IP = async () => ['93.184.216.34']

describe('bestEffortRfc7592Delete', () => {
  it('swallows transport failures (courtesy cleanup)', async () => {
    const transport = async () => {
      throw new Error('AS unreachable')
    }
    await expect(
      bestEffortRfc7592Delete(
        { transport, resolveDns: PUBLIC_IP },
        'https://mcp.notion.com/register/x',
        'tok'
      )
    ).resolves.toBeUndefined()
  })
})
