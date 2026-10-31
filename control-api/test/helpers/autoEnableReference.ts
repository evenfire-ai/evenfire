/**
 * The auto-enable eligibility rules read straight off a raw models.dev entry,
 * written independently of `autoEnableRejection` so tests can use it as the
 * reference the production predicate is checked against. Only the runnable-id
 * rule is shared: it is the runtime's own definition, not the catalog's.
 */
import { isRunnableLlmModelId } from '@clerum/llm-providers'
import type { RawModelsDevModel } from '../../src/services/modelsDevClient.js'

export interface ReferenceAutoEnableRules {
  textOutput: boolean
  toolCall: boolean
  /** Any status at all blocks, known or not; only its absence passes. */
  statusOk: boolean
  runnable: boolean
}

export function referenceAutoEnableRules(
  raw: RawModelsDevModel,
  modelId: string
): ReferenceAutoEnableRules {
  const output = raw.modalities?.output
  return {
    textOutput:
      Array.isArray(output) && output.every(v => typeof v === 'string') && output.includes('text'),
    toolCall: raw.tool_call === true,
    statusOk: raw.status === undefined,
    runnable: isRunnableLlmModelId(modelId),
  }
}

export function referenceEligible(raw: RawModelsDevModel, modelId: string): boolean {
  const r = referenceAutoEnableRules(raw, modelId)
  return r.textOutput && r.toolCall && r.statusOk && r.runnable
}
