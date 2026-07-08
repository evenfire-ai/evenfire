import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SnippetExecuteRequest } from '../../../src/workflow/snippetTypes'
import {
  executeSnippetPayload,
  normalizePostgresStatement,
  redactString,
  redactValue,
  validateMongoAggregatePipeline,
  validateSnippetSource,
} from '../../../src/workflow/snippetWorker'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe('snippet worker security guards', () => {
  it('rejects obfuscated constructor access instead of only literal process/require usage', () => {
    expect(() => validateSnippetSource('return sdk.secrets.get.constructor("return 1")()')).toThrow(
      /constructor access/
    )
  })

  it('rejects import.meta before TypeScript module target changes can expose it', () => {
    expect(() => validateSnippetSource('return import.meta.url')).toThrow(/import\.meta/)
  })

  it('does not expose host function constructors through SDK methods', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const previousOutputDir = process.env.CLERUM_WORKFLOW_OUTPUT_DIR
    process.env.CLERUM_WORKFLOW_OUTPUT_DIR = outputDir
    process.env.CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS = 'true'
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            const key = "con" + "structor"
            const ctor = sdk.log.info[key]
            return { escaped: typeof ctor === "function" }
          `,
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      const result = await executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 5_000,
        env: {},
      })

      expect(result.status).toBe('completed')
      expect(result.output).toEqual({ escaped: false })
    } finally {
      if (previousOutputDir === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_DIR
      else process.env.CLERUM_WORKFLOW_OUTPUT_DIR = previousOutputDir
      delete process.env.CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('does not expose host constructors through SDK return values', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const previousOutputDir = process.env.CLERUM_WORKFLOW_OUTPUT_DIR
    process.env.CLERUM_WORKFLOW_OUTPUT_DIR = outputDir
    process.env.CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS = 'true'
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            const key = "con" + "structor"
            const artifact = await sdk.artifacts.writeJson("probe.json", { ok: true })
            return { escaped: typeof artifact[key] === "function" }
          `,
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      const result = await executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 5_000,
        env: {},
      })

      expect(result.status).toBe('completed')
      expect(result.output).toEqual({ escaped: false })
    } finally {
      if (previousOutputDir === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_DIR
      else process.env.CLERUM_WORKFLOW_OUTPUT_DIR = previousOutputDir
      delete process.env.CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('reports all artifacts written through sdk.artifacts independently from the returned output shape', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'report',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            const reportArtifact = await sdk.artifacts.writeMarkdown("report.md", "# Report")
            const summaryArtifact = await sdk.artifacts.writeJson("summary.json", { ok: true })
            return { status: "completed", reportArtifact, summaryArtifact }
          `,
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      const result = await executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 5_000,
        env: {},
      })

      expect(result.status).toBe('completed')
      expect(result.artifacts?.map(artifact => artifact.name)).toEqual([
        'report.md',
        'summary.json',
      ])
      expect(result.output).toMatchObject({ status: 'completed' })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('exposes bounded sdk.sleep without exposing the global timer API', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'sleep',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            await sdk.sleep(1)
            return { hasGlobalSetTimeout: typeof setTimeout !== "undefined", slept: true }
          `,
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      const result = await executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 5_000,
        env: {},
      })

      expect(result.status).toBe('completed')
      expect(result.output).toEqual({ hasGlobalSetTimeout: false, slept: true })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('rejects sdk.sleep durations beyond the step timeout window', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'sleep-too-long',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.sleep(5001)',
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow('snippet sleep duration exceeds max 5000ms')
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('enforces the declared per-step artifact count limit', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            await sdk.artifacts.writeJson("one.json", { ok: 1 })
            await sdk.artifacts.writeJson("two.json", { ok: 2 })
            return { ok: true }
          `,
          capabilities: {
            artifacts: { maxCount: 1 },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow(/snippet artifact limit exceeded/)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it.each(['$out', '$merge'])(
    'accepts MongoDB aggregate stage %s only as valid syntax',
    operator => {
      expect(() =>
        validateMongoAggregatePipeline([{ $match: { status: 'open' } }, { [operator]: 'rollup' }])
      ).not.toThrow()
    }
  )

  it.each([
    ['select * from receivables where status = $1', 'select * from receivables where status = $1'],
    [
      'insert into receivables(account) values ($1)',
      'insert into receivables(account) values ($1)',
    ],
    ['update receivables set status = $1', 'update receivables set status = $1'],
    ['delete from receivables where status = $1', 'delete from receivables where status = $1'],
    [
      'create table if not exists receivables(id serial primary key);',
      'create table if not exists receivables(id serial primary key)',
    ],
  ])('normalizes allowed single PostgreSQL statement %s', (sql, expected) => {
    expect(normalizePostgresStatement(sql)).toBe(expected)
  })

  it('rejects multi-statement PostgreSQL snippets while allowing mutating single statements', () => {
    expect(() =>
      normalizePostgresStatement(
        'insert into receivables(account) values ($1); delete from receivables'
      )
    ).toThrow('postgres query must be a single statement')
  })

  it('requires readWrite access before MongoDB write operations', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'write-mongo',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            return await sdk.mongo.insertOne(
              { workload: "mongodb", database: "clerum", collection: "receivables" },
              { document: { account: "dao-alpha" } }
            )
          `,
          capabilities: {
            mongo: { access: 'read', workloads: ['mongodb'] },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [
          {
            id: 'mongodb',
            type: 'deployment',
            host: 'mongodb.sandbox-recipes.svc',
            port: 27017,
            namespace: 'sandbox-recipes',
          },
        ],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({ request, outputDir, timeoutMs: 5_000, env: {} })
      ).rejects.toThrow('mongo workload "mongodb" requires readWrite access')
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('requires readWrite access before PostgreSQL mutating statements', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'write-postgres',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `
            return await sdk.postgres.execute(
              { workload: "postgres", database: "clerum" },
              { sql: "insert into receivables(account) values ($1)", values: ["dao-alpha"] }
            )
          `,
          capabilities: {
            postgres: { access: 'read', workloads: ['postgres'] },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [
          {
            id: 'postgres',
            type: 'deployment',
            host: 'postgres.sandbox-recipes.svc',
            port: 5432,
            namespace: 'sandbox-recipes',
          },
        ],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({ request, outputDir, timeoutMs: 5_000, env: {} })
      ).rejects.toThrow('postgres workload "postgres" requires readWrite access')
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it.each(['GET', 'HEAD', 'POST', 'PUT'])(
    'allows declared public HTTP %s requests and forwards the request init',
    async method => {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: true, method }),
      })
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

      try {
        const request: SnippetExecuteRequest = {
          workflowName: 'wf',
          stepId: 'probe',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: `
              return await sdk.http.fetchJson("https://api.example.com/data", {
                method: "${method}",
                body: ${method === 'GET' || method === 'HEAD' ? 'undefined' : 'JSON.stringify({ ok: true })'},
                headers: { "content-type": "application/json" }
              })
            `,
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
          previousOutputs: {},
          resolvedWorkloads: [],
          resolvedMcpServers: [],
        }

        const result = await executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })

        expect(result.status).toBe('completed')
        expect(result.output).toEqual({ ok: true, method })
        expect(fetchMock).toHaveBeenCalledWith(
          new URL('https://api.example.com/data'),
          expect.objectContaining({ method, redirect: 'manual' })
        )
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true })
      }
    }
  )

  it('allows public-web snippet HTTP calls to any public HTTPS hostname', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.http.fetchJson("https://search.example.com/data")',
          capabilities: {
            http: { egressClass: 'public-web' },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      const result = await executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 5_000,
        env: {},
      })

      expect(result.status).toBe('completed')
      expect(result.output).toEqual({ ok: true })
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('https://search.example.com/data'),
        expect.objectContaining({ redirect: 'manual' })
      )
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('keeps public-web snippet HTTP calls blocked from cluster-local hostnames', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.http.fetchText("https://kubernetes.default.svc/")',
          capabilities: {
            http: { egressClass: 'public-web' },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow('HTTP host must be a public DNS hostname: kubernetes.default.svc')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('rejects plaintext calls to deceptive public hosts containing the cluster-local suffix', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const host = 'api.example.com.svc.cluster.local.attacker.com'

    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `return await sdk.http.fetchText("http://${host}/data")`,
          capabilities: {
            http: { allowedHosts: [host] },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow('public HTTP snippet calls must use https')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('rejects direct calls to cluster Services; internal access must use typed capabilities', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const host = 'postgres.sandbox-recipes.svc.cluster.local'

    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: `return await sdk.http.fetchText("https://${host}:5432/")`,
          capabilities: {
            http: { allowedHosts: [host] },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow(`HTTP host must be a public DNS hostname: ${host}`)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it.each(['OPTIONS', 'PATCH', 'DELETE'])(
    'rejects undeclared public HTTP method %s before fetch',
    async method => {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

      try {
        const request: SnippetExecuteRequest = {
          workflowName: 'wf',
          stepId: 'probe',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: `
              return await sdk.http.fetchText("https://api.example.com/data", {
                method: "${method}"
              })
            `,
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
          previousOutputs: {},
          resolvedWorkloads: [],
          resolvedMcpServers: [],
        }

        await expect(
          executeSnippetPayload({
            request,
            outputDir,
            timeoutMs: 5_000,
            env: {},
          })
        ).rejects.toThrow(`snippet HTTP method is not allowed: ${method}`)
        expect(fetchMock).not.toHaveBeenCalled()
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true })
      }
    }
  )

  it('rejects redirects to hosts outside the declared public HTTP allowlist', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-worker-'))
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'https://evil.example.com/next' }),
      text: vi.fn().mockResolvedValue('redirect'),
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'probe',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.http.fetchText("https://api.example.com/data")',
          capabilities: {
            http: { allowedHosts: ['api.example.com'] },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow('HTTP redirect host is not allowed: evil.example.com')
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('https://api.example.com/data'),
        expect.objectContaining({ redirect: 'manual' })
      )
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('redacts declared secret values recursively before logs, outputs, and artifacts persist them', () => {
    const env = {
      CLERUM_SNIPPET_SECRET_API_KEY: 'sk-test-secret',
    }

    expect(redactString('token=sk-test-secret', env)).toBe('token=[REDACTED]')
    expect(
      redactValue(
        {
          nested: ['safe', 'sk-test-secret'],
          object: { token: 'prefix-sk-test-secret-suffix' },
        },
        env
      )
    ).toEqual({
      nested: ['safe', '[REDACTED]'],
      object: { token: 'prefix-[REDACTED]-suffix' },
    })
  })
})
