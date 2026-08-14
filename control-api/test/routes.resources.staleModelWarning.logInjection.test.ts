import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { MockGateway } from './mockGateway.js'

// R1-M5 — log-record injection guard for the best-effort stale-warning catch
// (hostSpecValidation.ts `maybeWarnStale`). The `model` name is request-derived
// and validated with only `.trim()` (internal CR/LF survive). The old code
// interpolated it into a LINE-oriented sink (console.warn), so a `model` such as
// "gpt-4\nlevel=fatal msg=..." could forge/split a second log record. The fix
// routes the warning through the structured Pino logger, which JSON-escapes field
// values (CR/LF included) into a single record.
//
// T1: the log line is derived from the REAL producer (Pino) — not hand-written.
// We mock the logger module to hand `hostSpecValidation` a real Pino instance
// whose destination is an in-memory stream, so we capture Pino's actual wire
// serialization. T4: we assert the OBSERVABLE result — the sink received exactly
// ONE record, parseable as a single JSON object, with the CR/LF preserved INSIDE
// the `model` field (escaped on the wire), never a second forged/split line.

const logCapture = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock('../src/observability/logger.js', async () => {
  const { default: pino } = await import('pino')
  const stream = {
    write: (chunk: string) => {
      logCapture.lines.push(chunk)
    },
  }
  const rootLogger = pino({ level: 'warn', base: { svc: 'control-api' } }, stream)
  return { rootLogger }
})

// R1-H3 fase 1: Host create/update wrap validation + the K8s write in a carrier
// transaction holding a per-model-name advisory lock. Keep db.js real; stub only
// the transaction runner + lock / idle-timeout guards so these route tests need no
// live Postgres (serialization is covered by the real-Postgres race test).
vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
      work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    advisoryLockModelName: async () => {},
    advisoryLockModelNames: async () => {},
    boundCarrierTransactionIdleTimeout: async () => {},
  }
})

const llm = vi.hoisted(() => ({
  isModelAllowed: vi.fn(),
  getModelAllowlistState: vi.fn(),
}))
vi.mock('../src/services/llmAllowedModels.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/llmAllowedModels.js')>(
    '../src/services/llmAllowedModels.js'
  )
  return {
    ...actual,
    isModelAllowed: llm.isModelAllowed,
    getModelAllowlistState: llm.getModelAllowlistState,
  }
})

const HOSTS_NS = config.hostsNamespace

function buildApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return app
}

beforeEach(() => {
  logCapture.lines.length = 0
  llm.isModelAllowed.mockReset()
  llm.getModelAllowlistState.mockReset()
  // The model passes the allowlist gate (enabled) so the write proceeds to the
  // additive stale-warning lookup — which we force to reject, hitting the catch.
  llm.isModelAllowed.mockResolvedValue(true)
  llm.getModelAllowlistState.mockRejectedValue(new Error('db connection reset'))
})

describe('R1-M5 stale-warning catch: structured logging blocks log-record injection', () => {
  it('emits exactly ONE parseable JSON record (no forged/split line) for a CR/LF model name', async () => {
    // A request-derived model carrying an embedded newline + a forged record tail.
    const forgedModel = 'gpt-4\nlevel=fatal msg="forged log entry"'
    const gateway = new MockGateway(HOSTS_NS)

    const res = await request(buildApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'h1' },
        spec: { model: { provider: 'claude', name: forgedModel } },
      })

    // Best-effort invariant unchanged: the write still persists (no 500).
    expect(res.status).toBe(201)

    // Observable result (T4): the log sink received EXACTLY ONE record for this
    // event. With the old console.warn the structured logger was never called, so
    // this filter is empty and the assertion fails against the buggy head.
    const staleWarnLines = logCapture.lines.filter(l =>
      l.includes('stale-model warning lookup failed')
    )
    expect(staleWarnLines).toHaveLength(1)

    const rawLine = staleWarnLines[0]

    // It is a SINGLE physical line: only Pino's own trailing "\n" separates
    // records. The embedded CR/LF was escaped (\n), so it did not split the record.
    expect(rawLine.replace(/\n$/, '').split('\n')).toHaveLength(1)

    // It parses as one JSON object, and the injected newline lives INSIDE the
    // `model` field value — not as a forged sibling record.
    const parsed = JSON.parse(rawLine) as { provider: string; model: string; err: string }
    expect(parsed.provider).toBe('claude')
    expect(parsed.model).toBe(forgedModel)
    expect(parsed.err).toBe('db connection reset')
  })
})
