import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigLoader } from '../../src/config-loader/loader'

async function writeTokenFile(token = 'test-token'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-token-'))
  const tokenPath = path.join(dir, 'token')
  await fs.writeFile(tokenPath, token, 'utf8')
  return tokenPath
}

async function setRequiredEnv() {
  process.env.CLERUM_WORKFLOW_NAME = 'test-workflow'
  process.env.CLERUM_NAMESPACE = 'sandbox-recipes'
  process.env.CLERUM_WRC_URL = 'http://wrc:8082'
  process.env.WRC_TOKEN_FILE = await writeTokenFile('test-token')
}

function clearEnv() {
  delete process.env.CLERUM_WORKFLOW_NAME
  delete process.env.CLERUM_NAMESPACE
  delete process.env.CLERUM_WRC_URL
  delete process.env.WRC_TOKEN_FILE
  delete process.env.CLERUM_MCPHOST_URL
  delete process.env.MCP_HOST_TOKEN_FILE
  delete process.env.CLERUM_SNIPPET_RUNNER_URL
  delete process.env.SNIPPET_RUNNER_TOKEN_FILE
  delete process.env.CLERUM_WORKFLOW_RUN_ID
  delete process.env.CLERUM_CORRELATION_ID
  delete process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS
  delete process.env.CLERUM_SDK_REST_PORT
  delete process.env.CLERUM_REGISTRY_URL
  delete process.env.CLERUM_STORAGE_ENDPOINT
  delete process.env.CLERUM_WORKFLOW_CONFIG_PATH
  delete process.env.WORKFLOW_CONFIG_PATH
}

describe('ConfigLoader', () => {
  beforeEach(() => clearEnv())
  afterEach(() => clearEnv())

  describe('constructor validation', () => {
    it('throws WorkflowSDKInitError when CLERUM_WORKFLOW_NAME absent', () => {
      expect(() => new ConfigLoader()).toThrow('CLERUM_WORKFLOW_NAME')
    })

    it('throws WorkflowSDKInitError when CLERUM_NAMESPACE absent', () => {
      process.env.CLERUM_WORKFLOW_NAME = 'wf'
      expect(() => new ConfigLoader()).toThrow('CLERUM_NAMESPACE')
    })

    it('throws WorkflowSDKInitError when CLERUM_WRC_URL absent', () => {
      process.env.CLERUM_WORKFLOW_NAME = 'wf'
      process.env.CLERUM_NAMESPACE = 'ns'
      expect(() => new ConfigLoader()).toThrow('CLERUM_WRC_URL')
    })

    it('throws WorkflowSDKInitError when WRC_TOKEN_FILE absent', () => {
      process.env.CLERUM_WORKFLOW_NAME = 'wf'
      process.env.CLERUM_NAMESPACE = 'ns'
      process.env.CLERUM_WRC_URL = 'http://wrc:8082'
      expect(() => new ConfigLoader()).toThrow('WRC_TOKEN_FILE')
    })
  })

  describe('getConfig()', () => {
    it('reads all required env vars', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      const cfg = loader.getConfig()
      expect(cfg.workflowName).toBe('test-workflow')
      expect(cfg.namespace).toBe('sandbox-recipes')
      expect(cfg.wrcUrl).toBe('http://wrc:8082')
      await expect(cfg.tokenProvider.getWrcToken?.()).resolves.toBe('test-token')
    })

    it('reads optional mcpHost file env vars', async () => {
      await setRequiredEnv()
      process.env.CLERUM_MCPHOST_URL = 'http://mcp:8080'
      process.env.MCP_HOST_TOKEN_FILE = await writeTokenFile('mcp-tok')
      const loader = new ConfigLoader()
      const cfg = loader.getConfig()
      expect(cfg.mcpHostUrl).toBe('http://mcp:8080')
      await expect(cfg.tokenProvider.getMcpHostToken?.()).resolves.toBe('mcp-tok')
    })

    it('mcpHost fields are undefined when env vars absent', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      const cfg = loader.getConfig()
      expect(cfg.mcpHostUrl).toBeUndefined()
      expect(cfg.tokenProvider.getMcpHostToken).toBeUndefined()
    })

    it('uses provided CLERUM_CORRELATION_ID for legacy non-workflow callers', async () => {
      await setRequiredEnv()
      process.env.CLERUM_CORRELATION_ID = 'corr-123'
      const loader = new ConfigLoader()
      expect(loader.getConfig().correlationId).toBe('corr-123')
    })

    it('generates UUID when CLERUM_CORRELATION_ID is absent for legacy non-workflow callers', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      expect(loader.getConfig().correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    })

    it('uses the workflow run id as the workflow correlation id when both match', async () => {
      await setRequiredEnv()
      const runId = '00000000-0000-4000-8000-000000000001'
      process.env.CLERUM_WORKFLOW_RUN_ID = runId
      process.env.CLERUM_CORRELATION_ID = runId

      expect(new ConfigLoader().getConfig().correlationId).toBe(runId)
    })

    it('reconstructs the immutable workflow trace context on a cold config load', async () => {
      await setRequiredEnv()
      const runId = '00000000-0000-4000-8000-000000000001'
      process.env.CLERUM_WORKFLOW_RUN_ID = runId
      process.env.CLERUM_CORRELATION_ID = runId

      const first = new ConfigLoader().getConfig().traceContext
      const coldLoaded = new ConfigLoader().getConfig().traceContext

      expect(first).toEqual({ origin: 'workflow_runtime', runId, correlationId: runId })
      expect(coldLoaded).toEqual(first)
    })

    it('fails closed when a workflow run id is missing', async () => {
      await setRequiredEnv()
      process.env.CLERUM_WORKFLOW_RUN_ID = ' '
      process.env.CLERUM_CORRELATION_ID = '00000000-0000-4000-8000-000000000001'

      expect(() => new ConfigLoader()).toThrow('CLERUM_WORKFLOW_RUN_ID')
    })

    it('fails closed when workflow correlation id is missing', async () => {
      await setRequiredEnv()
      process.env.CLERUM_WORKFLOW_RUN_ID = '00000000-0000-4000-8000-000000000001'

      expect(() => new ConfigLoader()).toThrow('CLERUM_CORRELATION_ID')
    })

    it('fails closed when workflow run id and correlation id differ', async () => {
      await setRequiredEnv()
      process.env.CLERUM_WORKFLOW_RUN_ID = '00000000-0000-4000-8000-000000000001'
      process.env.CLERUM_CORRELATION_ID = '00000000-0000-4000-8000-000000000002'

      expect(() => new ConfigLoader()).toThrow(
        'CLERUM_CORRELATION_ID must match CLERUM_WORKFLOW_RUN_ID for workflow execution'
      )
    })

    it('defaults signalPollIntervalMs to 5000', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      expect(loader.getConfig().signalPollIntervalMs).toBe(5000)
    })

    it('reads custom CLERUM_SIGNAL_POLL_INTERVAL_MS', async () => {
      await setRequiredEnv()
      process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS = '30000'
      const loader = new ConfigLoader()
      expect(loader.getConfig().signalPollIntervalMs).toBe(30000)
    })

    it('defaults to 5000 when CLERUM_SIGNAL_POLL_INTERVAL_MS is non-numeric (NaN guard)', async () => {
      await setRequiredEnv()
      process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS = 'abc'
      const loader = new ConfigLoader()
      expect(loader.getConfig().signalPollIntervalMs).toBe(5000)
    })

    it('defaults to 5000 when poll interval is below 500ms', async () => {
      await setRequiredEnv()
      process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS = '100'
      const loader = new ConfigLoader()
      expect(loader.getConfig().signalPollIntervalMs).toBe(5000)
    })

    it('defaults SDK REST port to the coordinator health port', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      expect(loader.getConfig().restPort).toBe(8090)
    })

    it('reads custom CLERUM_SDK_REST_PORT', async () => {
      await setRequiredEnv()
      process.env.CLERUM_SDK_REST_PORT = '18090'
      const loader = new ConfigLoader()
      expect(loader.getConfig().restPort).toBe(18090)
    })

    it('defaults SDK REST port when the env var is invalid', async () => {
      await setRequiredEnv()
      process.env.CLERUM_SDK_REST_PORT = '70000'
      const loader = new ConfigLoader()
      expect(loader.getConfig().restPort).toBe(8090)
    })

    it('reads optional CLERUM_REGISTRY_URL', async () => {
      await setRequiredEnv()
      process.env.CLERUM_REGISTRY_URL = 'https://registry.clerum.io'
      const loader = new ConfigLoader()
      expect(loader.getConfig().registryUrl).toBe('https://registry.clerum.io')
    })

    it('registryUrl is undefined when env var absent', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      expect(loader.getConfig().registryUrl).toBeUndefined()
    })

    it('reads optional CLERUM_STORAGE_ENDPOINT', async () => {
      await setRequiredEnv()
      process.env.CLERUM_STORAGE_ENDPOINT = 'https://nyc3.digitaloceanspaces.com'
      const loader = new ConfigLoader()
      expect(loader.getConfig().storageEndpoint).toBe('https://nyc3.digitaloceanspaces.com')
    })

    it('storageEndpoint is undefined when env var absent', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      expect(loader.getConfig().storageEndpoint).toBeUndefined()
    })
  })

  describe('getSpec()', () => {
    it('throws when volume file is absent', async () => {
      await setRequiredEnv()
      const loader = new ConfigLoader()
      await expect(loader.getSpec()).rejects.toThrow(
        'Workflow spec not found at /etc/workflow/config.json'
      )
    })

    it('accepts snippet steps with run and no instruction', async () => {
      await setRequiredEnv()
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-config-'))
      const specPath = path.join(dir, 'config.json')
      process.env.CLERUM_WORKFLOW_CONFIG_PATH = specPath
      await fs.writeFile(
        specPath,
        JSON.stringify({
          name: 'wf',
          namespace: 'sandbox-recipes',
          steps: [
            {
              id: 'make-id',
              run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
            },
          ],
        })
      )

      const spec = await new ConfigLoader().getSpec()

      expect(spec.steps[0].run?.type).toBe('snippet')
      expect(spec.steps[0].instruction).toBeUndefined()
    })

    it('rejects unsupported run fields', async () => {
      await setRequiredEnv()
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-config-'))
      const specPath = path.join(dir, 'config.json')
      process.env.CLERUM_WORKFLOW_CONFIG_PATH = specPath
      await fs.writeFile(
        specPath,
        JSON.stringify({
          name: 'wf',
          namespace: 'sandbox-recipes',
          steps: [
            {
              id: 'bad-run',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'return {}',
                unexpected: true,
              },
            },
          ],
        })
      )

      await expect(new ConfigLoader().getSpec()).rejects.toThrow(
        'Step "bad-run" run contains unsupported field "unexpected"'
      )
    })

    it('rejects steps with both run and instruction', async () => {
      await setRequiredEnv()
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-config-'))
      const specPath = path.join(dir, 'config.json')
      process.env.CLERUM_WORKFLOW_CONFIG_PATH = specPath
      await fs.writeFile(
        specPath,
        JSON.stringify({
          name: 'wf',
          namespace: 'sandbox-recipes',
          steps: [
            {
              id: 'bad',
              instruction: 'run',
              run: { type: 'snippet', language: 'typescript', code: 'return {}' },
            },
          ],
        })
      )

      await expect(new ConfigLoader().getSpec()).rejects.toThrow(
        'cannot declare both run and instruction'
      )
    })

    it('accepts id-only custom coordinator steps', async () => {
      await setRequiredEnv()
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-config-'))
      const specPath = path.join(dir, 'config.json')
      process.env.CLERUM_WORKFLOW_CONFIG_PATH = specPath
      await fs.writeFile(
        specPath,
        JSON.stringify({
          name: 'wf',
          namespace: 'sandbox-recipes',
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          steps: [{ id: 'prepare' }, { id: 'emit', dependsOn: ['prepare'] }],
        })
      )

      const spec = await new ConfigLoader().getSpec()

      expect(spec.coordinatorImage).toBe('clerum/workflow-custom-sdk-e2e:test')
      expect(spec.steps[0].instruction).toBeUndefined()
      expect(spec.steps[0].run).toBeUndefined()
    })

    it('rejects id-only steps without a custom coordinator image', async () => {
      await setRequiredEnv()
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-config-'))
      const specPath = path.join(dir, 'config.json')
      process.env.CLERUM_WORKFLOW_CONFIG_PATH = specPath
      await fs.writeFile(
        specPath,
        JSON.stringify({
          name: 'wf',
          namespace: 'sandbox-recipes',
          steps: [{ id: 'prepare' }],
        })
      )

      await expect(new ConfigLoader().getSpec()).rejects.toThrow(
        'must have exactly one of run or instruction'
      )
    })
  })
})
