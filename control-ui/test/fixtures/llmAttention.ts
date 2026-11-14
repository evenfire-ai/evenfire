/**
 * Producer fixture — the body control-api's `GET /admin/attention` returns.
 *
 * control-api is not importable from this package, so this comes from the wire
 * file control-api generates against real PostgreSQL with the real catalog sync,
 * route and Host reference producer:
 * control-api/test/contracts.llmAttention.wire.realPostgres.integration.test.ts →
 * control-api/test/fixtures/wire/llmAttention.wire.json. Only models somebody uses
 * are flagged: it holds two `stale_model_referenced` items (one named by a Host,
 * one offered only through an all-models Host, role `implicit`) and one
 * `deprecated_model_enabled` with its references. Every item carries `episode`
 * and `consumerKeys`. Never build an item by hand: a state the file lacks is
 * added to the generator.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type AttentionWire = {
  items: Array<Record<string, unknown> & { kind: string; provider: string; model: string }>
  generatedAt: string
}

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/llmAttention.wire.json'),
    'utf8'
  )
) as AttentionWire

/** The raw generated body. A copy, so a test that mutates it cannot leak. */
export function attentionWireBody(): AttentionWire {
  return structuredClone(WIRE)
}

/** The raw body keeping only items of the given kinds. */
export function attentionWireBodyOf(...kinds: string[]): AttentionWire {
  const body = attentionWireBody()
  return { ...body, items: body.items.filter(item => kinds.includes(item.kind)) }
}
