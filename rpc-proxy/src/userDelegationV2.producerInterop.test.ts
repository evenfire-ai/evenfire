import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { verifyUserDelegationV2 } from './userDelegationV2.js'

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'rpc-proxy', 'node_modules', '.bin', 'tsx')
const producer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitUserDelegationV2Fixture.ts'
)

describe('Control API delegation producer to rpc-proxy verifier interoperability', () => {
  it('consumes a token emitted at test time by the real Control producer', () => {
    const output = execFileSync(tsx, [producer], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
    const fixture = JSON.parse(output) as { token: string }

    expect(verifyUserDelegationV2(fixture.token)).toMatchObject({
      typ: 'user_delegation',
      ver: 2,
      operationIds: ['host.wake'],
      scopes: ['action:host.wake'],
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
      behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    })
  })
})
