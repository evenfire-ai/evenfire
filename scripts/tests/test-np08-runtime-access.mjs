import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  NP08_RUNTIME_ACCESS_ROTATION_WAIT_MS,
  observeFreshRuntimeAccess,
  requestLocalRuntimeHealth,
  requestWithRuntimeAccess,
  requireLocalRuntimeHealth,
} from '../e2e/_lib/np08-runtime-access.mjs'

const NOW_SECONDS = 2_000_000_000
const NOW_MS = NOW_SECONDS * 1000
const BINDING = {
  hostRefs: ['chatllm'],
  recipeNamespace: 'mcp-host',
  recipeName: 'standalone',
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function makeJwt({ exp, iat = NOW_SECONDS - 10, binding = BINDING, marker }) {
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    ...binding,
    exp,
    iat,
    marker,
  })}.unsigned`
}

function persistedState(value) {
  return JSON.stringify({ [['access', 'Token'].join('')]: value })
}

async function tempState() {
  const directory = await mkdtemp(join(tmpdir(), 'np08-runtime-access-'))
  return {
    directory,
    stateFilePath: join(directory, 'approval-auth.json'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

describe('NP-08 access-only state selection', () => {
  it('uses a fresh mounted identity when no persisted state exists', async () => {
    const state = await tempState()
    try {
      const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
      const observed = await observeFreshRuntimeAccess({
        mountedAccessValue: mounted,
        stateFilePath: state.stateFilePath,
        nowMs: NOW_MS,
      })

      assert.equal(observed?.source, 'mounted')
      assert.equal(observed?.value, mounted)
    } finally {
      await state.cleanup()
    }
  })

  it('prefers fresher persisted state with the exact mounted binding', async () => {
    const state = await tempState()
    try {
      const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
      const persisted = makeJwt({
        exp: NOW_SECONDS + 300,
        iat: NOW_SECONDS + 1,
        marker: 'persisted',
      })
      await writeFile(state.stateFilePath, persistedState(persisted), 'utf8')

      const observed = await observeFreshRuntimeAccess({
        mountedAccessValue: mounted,
        stateFilePath: state.stateFilePath,
        nowMs: NOW_MS,
      })

      assert.equal(observed?.source, 'persisted')
      assert.equal(observed?.value, persisted)
    } finally {
      await state.cleanup()
    }
  })

  it('rejects persisted state when any canonical binding field differs', async () => {
    const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
    const variants = [
      { ...BINDING, hostRefs: ['other-host'] },
      { ...BINDING, hostRefs: ['chatllm', 'other-host'] },
      { ...BINDING, recipeNamespace: 'other-namespace' },
      { ...BINDING, recipeName: 'other-recipe' },
    ]

    for (const [index, binding] of variants.entries()) {
      const state = await tempState()
      try {
        const persisted = makeJwt({
          exp: NOW_SECONDS + 300,
          iat: NOW_SECONDS + 1,
          binding,
          marker: `wrong-binding-${index}`,
        })
        await writeFile(state.stateFilePath, persistedState(persisted), 'utf8')

        const observed = await observeFreshRuntimeAccess({
          mountedAccessValue: mounted,
          stateFilePath: state.stateFilePath,
          nowMs: NOW_MS,
        })
        assert.equal(observed?.source, 'mounted')
        assert.equal(observed?.value, mounted)
      } finally {
        await state.cleanup()
      }
    }
  })

  it('ignores malformed persisted state without displacing a fresh mounted identity', async () => {
    const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
    for (const raw of ['{', persistedState('not-a-jwt')]) {
      const state = await tempState()
      try {
        await writeFile(state.stateFilePath, raw, 'utf8')
        const observed = await observeFreshRuntimeAccess({
          mountedAccessValue: mounted,
          stateFilePath: state.stateFilePath,
          nowMs: NOW_MS,
        })
        assert.equal(observed?.value, mounted)
      } finally {
        await state.cleanup()
      }
    }
  })

  it('rejects expired persisted state', async () => {
    const state = await tempState()
    try {
      const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
      const expired = makeJwt({
        exp: NOW_SECONDS - 1,
        iat: NOW_SECONDS - 20,
        marker: 'expired',
      })
      await writeFile(state.stateFilePath, persistedState(expired), 'utf8')

      const observed = await observeFreshRuntimeAccess({
        mountedAccessValue: mounted,
        stateFilePath: state.stateFilePath,
        nowMs: NOW_MS,
      })
      assert.equal(observed?.value, mounted)
    } finally {
      await state.cleanup()
    }
  })

  it('rejects persisted state that is older by issue time or expiry', async () => {
    const mounted = makeJwt({
      exp: NOW_SECONDS + 180,
      iat: NOW_SECONDS,
      marker: 'mounted',
    })
    const olderCandidates = [
      makeJwt({
        exp: NOW_SECONDS + 300,
        iat: NOW_SECONDS - 1,
        marker: 'older-issue-time',
      }),
      makeJwt({
        exp: NOW_SECONDS + 150,
        iat: NOW_SECONDS + 1,
        marker: 'older-expiry',
      }),
      makeJwt({
        exp: NOW_SECONDS + 300,
        iat: null,
        marker: 'missing-issue-time',
      }),
    ]

    for (const persisted of olderCandidates) {
      const state = await tempState()
      try {
        await writeFile(state.stateFilePath, persistedState(persisted), 'utf8')
        const observed = await observeFreshRuntimeAccess({
          mountedAccessValue: mounted,
          stateFilePath: state.stateFilePath,
          nowMs: NOW_MS,
        })
        assert.equal(observed?.value, mounted)
      } finally {
        await state.cleanup()
      }
    }
  })
})

describe('NP-08 authorization retry', () => {
  it('observes an atomic persisted-state rotation after an HCC 401', async () => {
    const state = await tempState()
    try {
      const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
      const rotated = makeJwt({
        exp: NOW_SECONDS + 300,
        iat: NOW_SECONDS + 1,
        marker: 'rotated',
      })
      const attempts = []
      let clock = NOW_MS
      let stateRotated = false

      const outcome = await requestWithRuntimeAccess({
        mountedAccessValue: mounted,
        stateFilePath: state.stateFilePath,
        timeoutMs: 2_000,
        pollIntervalMs: 500,
        now: () => clock,
        sleep: async ms => {
          clock += ms
          if (!stateRotated) {
            stateRotated = true
            const nextPath = `${state.stateFilePath}.next`
            await writeFile(nextPath, persistedState(rotated), 'utf8')
            await rename(nextPath, state.stateFilePath)
          }
        },
        request: async value => {
          attempts.push(value)
          return { status: value === rotated ? 200 : 401 }
        },
      })

      assert.equal(outcome.result.status, 200)
      assert.equal(outcome.rotatedAfterUnauthorized, true)
      assert.equal(outcome.candidate.value, rotated)
      assert.deepEqual(attempts, [mounted, rotated])
    } finally {
      await state.cleanup()
    }
  })

  it('fails closed when no fresher state appears before the retry deadline', async () => {
    const state = await tempState()
    try {
      const mounted = makeJwt({ exp: NOW_SECONDS + 120, marker: 'mounted' })
      let clock = NOW_MS
      let attempts = 0

      await assert.rejects(
        requestWithRuntimeAccess({
          mountedAccessValue: mounted,
          stateFilePath: state.stateFilePath,
          timeoutMs: 1_500,
          pollIntervalMs: 500,
          now: () => clock,
          sleep: async ms => {
            clock += ms
          },
          request: async () => {
            attempts += 1
            return { status: 401 }
          },
        }),
        /runtime_access_rotation_timeout/
      )
      assert.equal(attempts, 1)
      assert.ok(NP08_RUNTIME_ACCESS_ROTATION_WAIT_MS > 30_000)
    } finally {
      await state.cleanup()
    }
  })
})

describe('NP-08 deployed-path guards', () => {
  it('requires the local mcp-host runtime health contract', async () => {
    const calls = []
    await requireLocalRuntimeHealth({
      env: { CLERUM_SERVER_PORT: '8080' },
      requestImpl: async options => {
        calls.push(options)
        return { status: 200, body: { status: 'ok' } }
      },
    })

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { port: 8080, timeoutMs: 5_000 })
  })

  it('enforces an absolute local-health deadline against a drip-fed response', async () => {
    let interval
    const requestFactory = (_options, onResponse) => {
      const request = new EventEmitter()
      const response = new EventEmitter()
      response.statusCode = 200
      request.end = () => {
        onResponse(response)
        interval = setInterval(() => response.emit('data', Buffer.from(' ')), 10)
      }
      request.destroy = error => {
        clearInterval(interval)
        request.emit('error', error)
        response.emit('aborted')
      }
      return request
    }
    let safetyTimer
    try {
      const request = requestLocalRuntimeHealth({
        port: 8080,
        timeoutMs: 100,
        requestFactory,
      })
      const safety = new Promise((_, reject) => {
        safetyTimer = setTimeout(
          () => reject(new Error('absolute_runtime_health_deadline_not_enforced')),
          1_000
        )
      })
      await assert.rejects(Promise.race([request, safety]), /mcp_host_runtime_health_timeout/)
    } finally {
      clearTimeout(safetyTimer)
      clearInterval(interval)
    }
  })

  it('contains no refresh credential dependency or write-line request path', async () => {
    const modulePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../e2e/_lib/np08-runtime-access.mjs'
    )
    const source = await readFile(modulePath, 'utf8')
    const forbidden = [
      ['MCP_HOST_RUNTIME', 'REFRESH_TOKEN'].join('_'),
      ['/api/v1/workflow-auth', 'refresh'].join('/'),
      ['/api/v1/workflow-auth', 'reissue'].join('/'),
    ]

    for (const value of forbidden) {
      assert.equal(source.includes(value), false)
    }
  })
})
