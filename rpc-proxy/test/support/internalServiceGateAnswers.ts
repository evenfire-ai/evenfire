// Shared parsing for the tests that run control-api's internal service gate
// fixture (`emitInternalServiceGateRefusalsFixture.ts`) in a `tsx` child. Each
// test file passes the fixture path as its own literal, because CI discovers
// producers by searching `*.test.ts` files.
import { resolve } from 'node:path'
import { runProducerChild } from './producerChild.js'

export type GateAnswerCase =
  | 'gate_bearer_missing'
  | 'gate_service_name_missing'
  | 'gate_token_wrong'
  | 'gate_other_service'
  | 'caller_token_missing'
  | 'caller_token_unverifiable'
  | 'both_bad'
  | 'authorized'

export type GateAnswer = {
  case: GateAnswerCase
  method: 'GET' | 'POST'
  status: number
  headers: Record<string, string>
  body: string
}

// Runs the fixture from the repository root with rpc-proxy's `tsx` and returns
// every answer it printed: status, response headers and raw body text.
export async function emitGateAnswers(
  fixturePath: string,
  input: Readonly<{ userId: string; hostRef: string }>
): Promise<GateAnswer[]> {
  const repositoryRoot = resolve(process.cwd(), '..')
  const output = await runProducerChild(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    resolve(repositoryRoot, fixturePath),
    [JSON.stringify(input)],
    { cwd: repositoryRoot }
  )
  const parsed: unknown = JSON.parse(output)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('the internal service gate fixture printed no answers')
  }
  return parsed as GateAnswer[]
}

export function gateAnswer(
  answers: readonly GateAnswer[] | undefined,
  answerCase: GateAnswerCase,
  method: 'GET' | 'POST'
): GateAnswer {
  if (!answers) throw new Error('the internal service gate answers were not set up in beforeAll')
  const matches = answers.filter(answer => answer.case === answerCase && answer.method === method)
  if (matches.length !== 1) {
    throw new Error(`expected one ${answerCase} answer on ${method}, found ${matches.length}`)
  }
  return matches[0]!
}

// A fresh Response per call: a body can be read once.
export function responseFromGateAnswer(answer: GateAnswer): Response {
  return new Response(answer.body, { status: answer.status, headers: answer.headers })
}
