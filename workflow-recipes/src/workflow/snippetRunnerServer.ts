import { timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import { executeSnippetInWorker } from './snippetRuntime'
import type {
  SnippetExecuteRequest,
  SnippetResolvedMcpServer,
  SnippetResolvedWorkload,
  SnippetRunInvocationRequest,
} from './snippetTypes'
import type { SnippetRunSpec } from './types'

const DEFAULT_PORT = 8095
const MAX_REQUEST_BYTES = 256_000
const DEFAULT_WORKFLOW_CONFIG_PATH = '/etc/workflow/config.json'
const DEFAULT_SNIPPET_STEP_TIMEOUT_MS = 300_000
const SNIPPET_RUNNER_STEP_TIMEOUT_MS_ENV = 'SNIPPET_RUNNER_STEP_TIMEOUT_MS'

interface RuntimeWorkflowConfig {
  name?: string
  recipeName?: string
  inputs?: Record<string, unknown>
  steps: Array<{
    id: string
    timeoutSeconds?: number
    run?: SnippetRunSpec
  }>
  workloads?: SnippetResolvedWorkload[]
  mcpServers?: Array<{ id: string; endpoint: string; transport?: string }>
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function getBearerToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return undefined
  return auth.slice('Bearer '.length)
}

export async function readSnippetRunnerToken(): Promise<string> {
  const tokenFile = process.env.SNIPPET_RUNNER_TOKEN_FILE
  if (!tokenFile) throw new Error('SNIPPET_RUNNER_TOKEN_FILE is required')
  const token = (await fs.readFile(tokenFile, 'utf8')).trim()
  if (!token) throw new Error('SNIPPET_RUNNER_TOKEN_FILE is empty')
  return token
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_REQUEST_BYTES) throw new Error('snippet request body is too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function isSnippetRunInvocationRequest(value: unknown): value is SnippetRunInvocationRequest {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.workflowName === 'string' &&
    typeof raw.stepId === 'string' &&
    (raw.previousOutputs === undefined ||
      (typeof raw.previousOutputs === 'object' && !Array.isArray(raw.previousOutputs))) &&
    (raw.inputs === undefined || (typeof raw.inputs === 'object' && !Array.isArray(raw.inputs))) &&
    (raw.timeoutSeconds === undefined ||
      (typeof raw.timeoutSeconds === 'number' &&
        Number.isSafeInteger(raw.timeoutSeconds) &&
        raw.timeoutSeconds > 0))
  )
}

export function createSnippetRunnerServer(): http.Server {
  const tokenFile = process.env.SNIPPET_RUNNER_TOKEN_FILE
  if (!tokenFile) {
    throw new Error('SNIPPET_RUNNER_TOKEN_FILE is required')
  }
  try {
    const token = fsSync.readFileSync(tokenFile, 'utf8').trim()
    if (!token) throw new Error('empty token file')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`SNIPPET_RUNNER_TOKEN_FILE is unreadable: ${message}`)
  }

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, { status: 'ok' })
      return
    }
    if (req.method !== 'POST' || req.url !== '/api/v1/snippet/execute') {
      writeJson(res, 404, { error: 'not-found' })
      return
    }
    const token = getBearerToken(req)
    let expectedToken: string
    try {
      expectedToken = await readSnippetRunnerToken()
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!token || !safeEqual(token, expectedToken)) {
      writeJson(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      const body = await readJson(req)
      if (!isSnippetRunInvocationRequest(body)) {
        writeJson(res, 400, { error: 'invalid snippet execute request' })
        return
      }
      const request = await buildBoundSnippetRequest(body)
      const response = await executeSnippetInWorker(
        request,
        resolveTimeoutMs(request.timeoutSeconds)
      )
      writeJson(res, response.status === 'completed' ? 200 : 422, response)
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export async function buildBoundSnippetRequest(
  invocation: SnippetRunInvocationRequest
): Promise<SnippetExecuteRequest> {
  const expectedWorkflowName = process.env.CLERUM_WORKFLOW_NAME
  if (!expectedWorkflowName) throw new Error('CLERUM_WORKFLOW_NAME is required')
  if (invocation.workflowName !== expectedWorkflowName) {
    throw new Error('snippet workflowName does not match runner binding')
  }

  const config = await loadRuntimeWorkflowConfig()
  const configName = config.recipeName ?? config.name
  if (configName !== expectedWorkflowName) {
    throw new Error('workflow config does not match runner binding')
  }
  const step = config.steps.find(item => item.id === invocation.stepId)
  if (!step?.run || step.run.type !== 'snippet') {
    throw new Error(`snippet step is not declared in workflow config: ${invocation.stepId}`)
  }
  if (invocation.timeoutSeconds !== undefined) {
    if (step.timeoutSeconds === undefined || invocation.timeoutSeconds !== step.timeoutSeconds) {
      throw new Error('snippet timeoutSeconds does not match workflow config')
    }
  }

  return {
    workflowName: expectedWorkflowName,
    stepId: invocation.stepId,
    run: step.run,
    inputs: invocation.inputs ?? config.inputs,
    previousOutputs: invocation.previousOutputs ?? {},
    ...(step.timeoutSeconds !== undefined && { timeoutSeconds: step.timeoutSeconds }),
    resolvedWorkloads: config.workloads ?? [],
    resolvedMcpServers: resolveMcpServers(config),
  }
}

async function loadRuntimeWorkflowConfig(): Promise<RuntimeWorkflowConfig> {
  const file = process.env.WORKFLOW_CONFIG_PATH ?? DEFAULT_WORKFLOW_CONFIG_PATH
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as RuntimeWorkflowConfig
  if (!Array.isArray(parsed.steps)) throw new Error('workflow config is missing steps')
  return parsed
}

function resolveMcpServers(config: RuntimeWorkflowConfig): SnippetResolvedMcpServer[] {
  return (config.mcpServers ?? []).map(server => ({
    id: server.id,
    url: server.endpoint,
    ...(server.transport && { transport: server.transport }),
  }))
}

export function resolveTimeoutMs(timeoutSeconds?: number): number {
  if (timeoutSeconds !== undefined) {
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
      throw new Error('snippet timeoutSeconds must be a positive safe integer')
    }
    return timeoutSeconds * 1000
  }
  const raw = process.env[SNIPPET_RUNNER_STEP_TIMEOUT_MS_ENV]
  if (raw === undefined || raw === '') return DEFAULT_SNIPPET_STEP_TIMEOUT_MS
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${SNIPPET_RUNNER_STEP_TIMEOUT_MS_ENV} must be a positive safe integer`)
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${SNIPPET_RUNNER_STEP_TIMEOUT_MS_ENV} must be a positive safe integer`)
  }
  return value
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT ?? `${DEFAULT_PORT}`, 10)
  const server = createSnippetRunnerServer()
  server.listen(port, () => {
    console.log(`[SnippetRunner] listening on ${port}`)
  })
}
