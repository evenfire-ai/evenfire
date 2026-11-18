/**
 * Producer fixture — model rows as control-api's `GET /admin/llm-models` returns
 * them.
 *
 * control-api is not importable from this package, so these come from the wire
 * file control-api generates through its real routes and row serializer:
 * control-api/test/contracts.llmModelsSetupEnsure.wire.test.ts →
 * control-api/test/fixtures/wire/llmModelsSetupEnsure.wire.json. It lists one
 * enabled and one disabled row. Never build a row by hand: a state the file
 * lacks is added to the generator. Rows go through the same normalizer the
 * client applies on read, so a test sees what a page gets from getLlmModel.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type LlmAllowedModel, formatApiError, normalizeLlmAllowedModel } from '@lib/api'

type WireCapture = { status: number; body: Record<string, unknown> }

type SetupEnsureWire = {
  list: { status: number; body: { rows: LlmAllowedModel[] } }
  create_configmap_write_failed: WireCapture
}

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/llmModelsSetupEnsure.wire.json'),
    'utf8'
  )
) as SetupEnsureWire

/** The first generated row whose `enabled` matches. A copy, so a test cannot leak. */
export function llmModelWireRow(enabled: boolean): LlmAllowedModel {
  const row = WIRE.list.body.rows.find(candidate => candidate.enabled === enabled)
  if (!row) throw new Error(`llmModelsSetupEnsure.wire.json has no row with enabled=${enabled}`)
  return normalizeLlmAllowedModel(structuredClone(row))
}

/**
 * The error the client throws when a mutation committed the row but control-api
 * could not update the allowlist ConfigMap: the real `formatApiError` over the
 * generated 503. The file captures it on create; update and delete answer through
 * the same route helper (`materializeOrFail`), so the body is the same.
 */
export function llmModelConfigMapDeferredError(): Error {
  const capture = WIRE.create_configmap_write_failed
  const text = JSON.stringify(capture.body)
  const res = new Response(text, {
    status: capture.status,
    headers: { 'content-type': 'application/json' },
  })
  return formatApiError(res, text)
}
