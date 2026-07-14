import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildBoundSnippetRequest,
  readSnippetRunnerToken,
  resolveTimeoutMs,
} from '../../../src/workflow/snippetRunnerServer'

describe('snippet runner request binding', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('rereads the snippet runner token file after rotation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-token-'))
    tempDirs.push(dir)
    const tokenPath = path.join(dir, 'snippet-token')
    await fs.writeFile(tokenPath, 'jwt-a', 'utf8')
    vi.stubEnv('SNIPPET_RUNNER_TOKEN_FILE', tokenPath)

    await expect(readSnippetRunnerToken()).resolves.toBe('jwt-a')
    await fs.writeFile(tokenPath, 'jwt-b', 'utf8')
    await expect(readSnippetRunnerToken()).resolves.toBe('jwt-b')
  })

  it('fails closed when the snippet runner token file is missing or empty', async () => {
    vi.stubEnv('SNIPPET_RUNNER_TOKEN_FILE', '/missing/token')
    await expect(readSnippetRunnerToken()).rejects.toThrow()

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-token-'))
    tempDirs.push(dir)
    const tokenPath = path.join(dir, 'snippet-token')
    await fs.writeFile(tokenPath, '', 'utf8')
    vi.stubEnv('SNIPPET_RUNNER_TOKEN_FILE', tokenPath)
    await expect(readSnippetRunnerToken()).rejects.toThrow('SNIPPET_RUNNER_TOKEN_FILE is empty')
  })

  it('resolves code, capabilities, workloads, and mcp servers from mounted workflow config', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-'))
    const configPath = path.join(dir, 'config.json')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'snippet-wf',
        inputs: { company: 'Acme' },
        workloads: [
          {
            id: 'postgres',
            type: 'deployment',
            host: 'postgres.sandbox-recipes.svc.cluster.local',
            port: 5432,
            namespace: 'sandbox-recipes',
          },
        ],
        mcpServers: [{ id: 'mongo-mcp', endpoint: 'http://mongo-mcp.mcp-server.svc:3000/mcp' }],
        steps: [
          {
            id: 'snippet',
            timeoutSeconds: 12,
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: { postgres: { access: 'read', workloads: ['postgres'] } },
            },
          },
        ],
      }),
      'utf8'
    )
    vi.stubEnv('CLERUM_WORKFLOW_NAME', 'snippet-wf')
    vi.stubEnv('WORKFLOW_CONFIG_PATH', configPath)

    const request = await buildBoundSnippetRequest({
      workflowName: 'snippet-wf',
      stepId: 'snippet',
      timeoutSeconds: 12,
      previousOutputs: { seed: { ok: true } },
      inputs: { company: 'Override' },
    })

    expect(request.run.code).toBe('return { ok: true }')
    expect(request.run.capabilities).toEqual({
      postgres: { access: 'read', workloads: ['postgres'] },
    })
    expect(request.resolvedWorkloads[0]).toMatchObject({ id: 'postgres', port: 5432 })
    expect(request.resolvedMcpServers[0]).toEqual({
      id: 'mongo-mcp',
      url: 'http://mongo-mcp.mcp-server.svc:3000/mcp',
    })
    expect(request.timeoutSeconds).toBe(12)
    expect(request.inputs).toEqual({ company: 'Override' })
  })

  it('rejects invocation timeoutSeconds that does not match mounted workflow config', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-'))
    const configPath = path.join(dir, 'config.json')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'snippet-wf',
        steps: [
          {
            id: 'snippet',
            timeoutSeconds: 10,
            run: { type: 'snippet', language: 'typescript', code: 'return {}' },
          },
        ],
      }),
      'utf8'
    )
    vi.stubEnv('CLERUM_WORKFLOW_NAME', 'snippet-wf')
    vi.stubEnv('WORKFLOW_CONFIG_PATH', configPath)

    await expect(
      buildBoundSnippetRequest({
        workflowName: 'snippet-wf',
        stepId: 'snippet',
        timeoutSeconds: 11,
        previousOutputs: {},
      })
    ).rejects.toThrow('snippet timeoutSeconds does not match workflow config')
  })

  it('rejects workflowName or stepId that does not match the runner-bound config', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-'))
    const configPath = path.join(dir, 'config.json')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'snippet-wf',
        steps: [
          { id: 'snippet', run: { type: 'snippet', language: 'typescript', code: 'return {}' } },
        ],
      }),
      'utf8'
    )
    vi.stubEnv('CLERUM_WORKFLOW_NAME', 'snippet-wf')
    vi.stubEnv('WORKFLOW_CONFIG_PATH', configPath)

    await expect(
      buildBoundSnippetRequest({
        workflowName: 'other-wf',
        stepId: 'snippet',
        previousOutputs: {},
      })
    ).rejects.toThrow(/workflowName does not match/)

    await expect(
      buildBoundSnippetRequest({
        workflowName: 'snippet-wf',
        stepId: 'missing',
        previousOutputs: {},
      })
    ).rejects.toThrow(/not declared/)
  })

  it('uses declared timeoutSeconds as the snippet budget', () => {
    vi.stubEnv('SNIPPET_RUNNER_STEP_TIMEOUT_MS', '2500')

    expect(resolveTimeoutMs(12)).toBe(12_000)
  })

  it('uses SNIPPET_RUNNER_STEP_TIMEOUT_MS as millisecond fallback only when absent', () => {
    vi.stubEnv('SNIPPET_RUNNER_STEP_TIMEOUT_MS', '2500')

    expect(resolveTimeoutMs()).toBe(2_500)
  })

  it('fails closed for invalid snippet runner timeout fallback', () => {
    vi.stubEnv('SNIPPET_RUNNER_STEP_TIMEOUT_MS', '0')

    expect(() => resolveTimeoutMs()).toThrow(
      'SNIPPET_RUNNER_STEP_TIMEOUT_MS must be a positive safe integer'
    )
  })
})
