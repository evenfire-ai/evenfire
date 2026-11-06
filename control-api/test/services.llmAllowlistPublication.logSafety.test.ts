/**
 * A failed allowlist publication logs the apiserver's error without its
 * response headers or raw body. `ApiException.message` from
 * @kubernetes/client-node embeds both, so logging `err` or `err.message` as is
 * would write them out; the redact paths do not cover a message string.
 *
 * T1: the error is the real ApiException class, thrown by the ConfigMap fake at
 * the apiserver boundary, and the log lines are the real Pino serialization
 * (same redact configuration as production) into an in-memory stream.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import type { ImageInputCapability } from '@clerum/llm-providers'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'
import {
  CatalogPublishAfterCommitError,
  syncDiscoveredModels,
} from '../src/services/llmCatalogSync.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import { loadStub, trimSnapshot, withModalities } from './helpers/modelsDevFixtures.js'

const logCapture = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock('../src/observability/logger.js', async () => {
  const { default: pino } = await import('pino')
  const { TOKEN_LEAK_REDACT_PATHS } = await import('../src/utils/log/redact.js')
  const stream = {
    write: (chunk: string) => {
      logCapture.lines.push(chunk)
    },
  }
  const rootLogger = pino(
    {
      level: 'info',
      base: { svc: 'control-api' },
      redact: { paths: [...TOKEN_LEAK_REDACT_PATHS], remove: true },
    },
    stream
  )
  return { rootLogger }
})

const HEADER_SECRET = 'audit-id-7f3c9e1b-secret'
const BODY_SECRET = 'internal-node-10.0.42.7'
const STATUS_MESSAGE = 'configmaps "clerum-llm-allowed-models" is forbidden'

function apiserverError(): ApiException<string> {
  return new ApiException(
    403,
    'Forbidden',
    JSON.stringify({
      kind: 'Status',
      status: 'Failure',
      reason: 'Forbidden',
      message: STATUS_MESSAGE,
      details: { causes: [{ message: BODY_SECRET }] },
    }),
    { 'audit-id': HEADER_SECRET, 'x-kubernetes-pf-flowschema-uid': HEADER_SECRET }
  )
}

const oldDiscovery: ImageInputCapability = {
  state: 'unknown',
  evidence: {
    source: 'discovery',
    reference: 'https://models.dev/api.json',
    checkedAt: '2026-07-01T00:00:00.000Z',
  },
}
const CATALOG = withModalities(trimSnapshot({ anthropic: ['claude-opus-4-6'] }), {
  'claude-opus-4-6': ['text', 'image'],
})

function records(event: string): Array<Record<string, unknown>> {
  return logCapture.lines
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(r => r.event === event)
}

afterEach(() => {
  logCapture.lines = []
})

describe('allowlist publication failure logs', () => {
  it('the sync and its retry log the apiserver status message, never its headers or body', async () => {
    const db = makeFakeDb([
      {
        provider: 'claude',
        model: 'claude-opus-4-6',
        source: 'discovery',
        enabled: true,
        image_input: oldDiscovery,
      },
    ])
    await db.materializer.materialize()
    const retry = new AllowlistPublishRetry({ baseDelayMs: 10, maxDelayMs: 10 })
    try {
      // Enough failures for the sync's publish and its first retry.
      db.cluster.failNextWrites(6, apiserverError())
      await expect(
        syncDiscoveredModels(
          {
            materializer: db.materializer,
            publishRetry: retry,
            loadCatalog: loadStub(CATALOG, 'live', '2026-08-19T16:16:10.000Z'),
            minPlausibleLiveTotal: 1,
          },
          db.connector
        )
      ).rejects.toBeInstanceOf(CatalogPublishAfterCommitError)
      await vi.waitFor(
        () => expect(records('llm_allowlist_publish_retry_failed')).toHaveLength(1),
        {
          timeout: 5_000,
        }
      )
    } finally {
      retry.stop()
    }

    const logged = [
      ...records('llm_catalog_sync_configmap_write_failed'),
      ...records('llm_allowlist_publish_retry_failed'),
    ]
    expect(logged).toHaveLength(2)
    for (const record of logged) expect(record.err).toBe(STATUS_MESSAGE)
    const wire = logCapture.lines.join('')
    expect(wire).not.toContain(HEADER_SECRET)
    expect(wire).not.toContain(BODY_SECRET)
  })
})
