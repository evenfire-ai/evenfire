/**
 * Shared construction for the OpenAI wire-family tests: every family member is
 * built through the real factory, and SDK responses are recorded API outputs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProvider } from '../../registry'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor, primarySlot } from '../../registryCore'
import type { SingleTurnProvider } from '../../types'

const FIXTURES = join(__dirname, '__fixtures__')

export const RECORDED_TOOLS_RESPONSE = JSON.parse(
  readFileSync(join(FIXTURES, 'chatCompletion.tools.recorded.json'), 'utf8')
)
export const RECORDED_TEXT_RESPONSE = JSON.parse(
  readFileSync(join(FIXTURES, 'chatCompletion.text.recorded.json'), 'utf8')
)

export const AZURE_ENDPOINT = 'https://unit-resource.openai.azure.com/'
const azureEnv = (values: Record<string, string>) => (name: string) => values[name]

/**
 * Pinned to the providers the base corpus was recorded for, so adding a
 * descriptor does not invalidate the snapshot. New descriptors are covered by
 * CHAT_FAMILY in the contract tests instead.
 */
export const FAMILY: readonly LlmProvider[] = [
  'openai',
  'azure',
  'zai',
  'bailian',
  'openrouter',
  'gemini',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'mistral',
  'xai',
  'cerebras',
  'deepinfra',
  'perplexity',
  'moonshot',
  'nebius',
  'novita',
  'minimax',
]

/** Every endpoint that must stay on Chat Completions: azure plus all current compatibles. */
export const CHAT_FAMILY: readonly LlmProvider[] = [
  'azure',
  ...ALL_PROVIDERS.filter(p => descriptorFor(p).baseURL !== undefined),
]

export function buildFamilyProvider(
  id: LlmProvider,
  model?: string,
  env: Record<string, string> = { AZURE_OPENAI_ENDPOINT: AZURE_ENDPOINT }
): SingleTurnProvider {
  const d = descriptorFor(id)
  return makeProvider(id, { [primarySlot(d).dataKey]: `unit-${id}-key` }, model, {
    env: azureEnv(env),
  })
}
