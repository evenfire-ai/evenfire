/**
 * Producer fixture — model rows as control-api's `GET /admin/llm-models` returns
 * them.
 *
 * control-api is not importable from this package, so these come from the wire
 * file control-api generates through its real routes and row serializer:
 * control-api/test/contracts.llmModelsSetupEnsure.wire.test.ts →
 * control-api/test/fixtures/wire/llmModelsSetupEnsure.wire.json. It lists one
 * enabled and one disabled row. Never build a row by hand: a state the file
 * lacks is added to the generator.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LlmAllowedModel } from '@lib/api'

type SetupEnsureWire = { list: { status: number; body: { rows: LlmAllowedModel[] } } }

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
  return structuredClone(row)
}
