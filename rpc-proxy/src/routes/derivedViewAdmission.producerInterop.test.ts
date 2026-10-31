import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { execFileSync } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import request from 'supertest'
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

function issueToken(operationId: string): string {
  const output = execFileSync(tsx, [producer, operationId], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: [resolve(repositoryRoot, 'rpc-proxy', 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter),
    },
  })
  return (JSON.parse(output) as { token: string }).token
}

describe('Control API-issued derived-view delegation admission', () => {
  it('rejects repeated Desktop and Sandbox views before checkpoint or consumer work', async () => {
    const desktopToken = issueToken('remote_desktop.reconnect')
    const sandboxToken = issueToken('sandbox.reconnect')
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
