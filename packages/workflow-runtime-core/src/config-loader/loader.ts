import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { WorkflowSDKInitError } from '../errors'
import { createFileRuntimeTokenProvider } from '../runtime-token-provider/provider'
import type { WorkflowConfig, WorkflowRecipeSpec, WorkflowTraceContext } from './types'

const DEFAULT_SPEC_VOLUME_PATH = '/etc/workflow/config.json'
const STEP_RUN_KEYS = new Set(['type', 'language', 'code', 'capabilities'])

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new WorkflowSDKInitError(name)
  return value
}

function resolveTraceContext(): WorkflowTraceContext {
  const workflowRunId = process.env.CLERUM_WORKFLOW_RUN_ID?.trim()
  const correlationId = process.env.CLERUM_CORRELATION_ID?.trim()

  // WRC marks workflow executions with CLERUM_WORKFLOW_RUN_ID. Preserve the
  // legacy UUID fallback only for callers outside that run-scoped contract.
  if (process.env.CLERUM_WORKFLOW_RUN_ID !== undefined) {
    if (!workflowRunId) throw new WorkflowSDKInitError('CLERUM_WORKFLOW_RUN_ID')
    if (!correlationId) throw new WorkflowSDKInitError('CLERUM_CORRELATION_ID')
    if (correlationId !== workflowRunId) {
      throw new Error('CLERUM_CORRELATION_ID must match CLERUM_WORKFLOW_RUN_ID for workflow execution')
    }
    return { origin: 'workflow_runtime', runId: workflowRunId, correlationId }
  }

  return {
    origin: 'workflow_runtime',
    runId: null,
    correlationId: correlationId || randomUUID(),
  }
}

export class ConfigLoader {
  private readonly config: WorkflowConfig
  private specCache: WorkflowRecipeSpec | null = null

  constructor() {
    const workflowName = requireEnv('CLERUM_WORKFLOW_NAME')
    const namespace = requireEnv('CLERUM_NAMESPACE')
    const wrcUrl = requireEnv('CLERUM_WRC_URL')
    const wrcTokenFile = requireEnv('WRC_TOKEN_FILE')
    const mcpHostTokenFile = process.env.MCP_HOST_TOKEN_FILE
    const snippetRunnerTokenFile = process.env.SNIPPET_RUNNER_TOKEN_FILE
    if (process.env.CLERUM_MCPHOST_URL && !mcpHostTokenFile) {
      throw new WorkflowSDKInitError('MCP_HOST_TOKEN_FILE')
    }
    if (process.env.CLERUM_SNIPPET_RUNNER_URL && !snippetRunnerTokenFile) {
      throw new WorkflowSDKInitError('SNIPPET_RUNNER_TOKEN_FILE')
    }
    const traceContext = resolveTraceContext()
    this.config = {
      workflowName,
      namespace,
      wrcUrl,
      wrcTokenFile,
      mcpHostUrl: process.env.CLERUM_MCPHOST_URL,
      mcpHostTokenFile,
      snippetRunnerUrl: process.env.CLERUM_SNIPPET_RUNNER_URL,
      snippetRunnerTokenFile,
      tokenProvider: createFileRuntimeTokenProvider({
        wrcTokenFile,
        mcpHostTokenFile,
        snippetRunnerTokenFile,
      }),
      correlationId: traceContext.correlationId,
      traceContext,
      signalPollIntervalMs: ConfigLoader.parseInterval(process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS),
      restPort: ConfigLoader.parsePort(process.env.CLERUM_SDK_REST_PORT),
      registryUrl: process.env.CLERUM_REGISTRY_URL,
      storageEndpoint: process.env.CLERUM_STORAGE_ENDPOINT,
    }
  }

  private static parseInterval(raw?: string): number {
    const parsed = parseInt(raw || '5000', 10)
    return Number.isFinite(parsed) && parsed >= 500 ? parsed : 5000
  }

  private static parsePort(raw?: string): number {
    const parsed = parseInt(raw || '8090', 10)
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8090
  }

  getConfig(): WorkflowConfig {
    return this.config
  }

  async getSpec(): Promise<WorkflowRecipeSpec> {
    if (this.specCache) return this.specCache

    let raw: string
    try {
      raw = await fs.readFile(ConfigLoader.specPath(), 'utf-8')
    } catch {
      // Volume not available — spec MUST be mounted as a volume.
      // There is no WRC REST fallback for spec retrieval.
      throw new Error(
        `Workflow spec not found at ${ConfigLoader.specPath()}. ` +
          'Ensure the WRC mounts the spec ConfigMap as a volume.'
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Workflow spec at /etc/workflow/config.json is not valid JSON')
    }

    ConfigLoader.validateSpec(parsed)
    this.specCache = parsed as WorkflowRecipeSpec
    return this.specCache
  }

  private static validateSpec(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Workflow spec must be a JSON object')
    }
    const spec = parsed as Record<string, unknown>
    if (typeof spec.name !== 'string' || !spec.name) {
      throw new WorkflowSDKInitError('spec.name')
    }
    if (!Array.isArray(spec.steps)) {
      throw new Error('Workflow spec missing required field: steps (must be an array)')
    }
    const hasCustomCoordinator =
      typeof spec.coordinatorImage === 'string' && spec.coordinatorImage.trim() !== ''

    for (const step of spec.steps as unknown[]) {
      if (typeof step !== 'object' || step === null) {
        throw new Error('Each step in spec.steps must be an object')
      }
      const s = step as Record<string, unknown>
      if (typeof s.id !== 'string' || !s.id) {
        throw new Error('Each step must have a non-empty string id')
      }
      const hasRun = typeof s.run === 'object' && s.run !== null
      const hasInstruction = typeof s.instruction === 'string' && s.instruction.trim() !== ''
      if (hasRun && hasInstruction) {
        throw new Error(`Step "${s.id}" cannot declare both run and instruction`)
      }
      if (!hasCustomCoordinator && hasRun === hasInstruction) {
        throw new Error(`Step "${s.id}" must have exactly one of run or instruction`)
      }
      if (hasRun) {
        const run = s.run as Record<string, unknown>
        ConfigLoader.assertAllowedKeys(run, STEP_RUN_KEYS, `Step "${s.id}" run`)
        if (run.type !== 'snippet') {
          throw new Error(`Step "${s.id}" run.type must be snippet`)
        }
        if (run.language !== 'typescript') {
          throw new Error(`Step "${s.id}" snippet language must be typescript`)
        }
        if (typeof run.code !== 'string' || run.code.trim() === '') {
          throw new Error(`Step "${s.id}" snippet code must be a non-empty string`)
        }
      }
    }
  }

  private static assertAllowedKeys(
    value: Record<string, unknown>,
    allowedKeys: Set<string>,
    path: string
  ): void {
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`${path} contains unsupported field "${key}"`)
      }
    }
  }

  private static specPath(): string {
    return (
      process.env.CLERUM_WORKFLOW_CONFIG_PATH ||
      process.env.WORKFLOW_CONFIG_PATH ||
      DEFAULT_SPEC_VOLUME_PATH
    )
  }
}
