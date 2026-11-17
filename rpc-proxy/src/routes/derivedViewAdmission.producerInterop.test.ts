import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { delimiter, resolve } from 'node:path'
import request from 'supertest'
import {
  type SetupOutcome,
  producerBudgetMs,
  recordSetup,
  runProducerChild,
  setupValue,
} from '../../test/support/producerChild.js'
import { verifyUserDelegationV2 } from '../userDelegationV2.js'
import { createDesktopRouter } from './desktopProxy.js'
import { createSandboxUiSessionRouter } from './sandboxUi.js'

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'rpc-proxy', 'node_modules', '.bin', 'tsx')
const producer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitDerivedViewDelegationV2Fixture.ts'
)

afterEach(() => vi.restoreAllMocks())

// Setup, not behaviour under test: the control-api delegation producer runs in a
// `tsx` child process, once per distinct operation. `beforeAll` runs both
// children, so no test body starts a process, and records each output or the
// error it failed with. A recorded error is rethrown by `issuedToken`: a broken
// producer fails the tests that read it, with its own error. Each child is
// bounded by PRODUCER_CHILD_TIMEOUT_MS.
const issuedTokens = new Map<string, SetupOutcome<string>>()

beforeAll(async () => {
  for (const operationId of ['remote_desktop.reconnect', 'sandbox.reconnect']) {
    issuedTokens.set(
      operationId,
      await recordSetup(async () => {
        const output = await runProducerChild(tsx, producer, [operationId], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            NODE_PATH: [resolve(repositoryRoot, 'rpc-proxy', 'node_modules'), process.env.NODE_PATH]
              .filter(Boolean)
              .join(delimiter),
          },
        })
        return (JSON.parse(output) as { token: string }).token
      })
    )
  }
}, producerBudgetMs(2))

function issuedToken(operationId: string): string {
  return setupValue(issuedTokens.get(operationId), `delegation token for ${operationId}`)
}

describe('Control API-issued derived-view delegation admission', () => {
  it('rejects repeated Desktop and Sandbox views before checkpoint or consumer work', async () => {
    const desktopToken = issuedToken('remote_desktop.reconnect')
    const sandboxToken = issuedToken('sandbox.reconnect')
    expect(verifyUserDelegationV2(desktopToken)?.operationIds).toEqual(['remote_desktop.reconnect'])
    expect(verifyUserDelegationV2(sandboxToken)?.operationIds).toEqual(['sandbox.reconnect'])

    const checkpointOrConsumerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'test_upstream_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    )
    const app = express()
    app.use('/api/v1', createSandboxUiSessionRouter())
    app.use(createDesktopRouter())

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const desktop = await request(app)
        .get('/desktop/chatllm/view/index.html')
        .set('Authorization', `Bearer ${desktopToken}`)
      const sandbox = await request(app)
        .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/index.html')
        .set('Authorization', `Bearer ${sandboxToken}`)

      expect(desktop.status).toBe(503)
      expect(desktop.body).toEqual({ error: 'authority_unavailable' })
      expect(sandbox.status).toBe(503)
      expect(sandbox.body).toEqual({ error: 'authority_unavailable' })
    }

    expect(checkpointOrConsumerFetch).not.toHaveBeenCalled()
  })
})
