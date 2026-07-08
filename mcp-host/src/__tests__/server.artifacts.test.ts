import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import type { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'
import type { RPCServer } from '../server'
import { MAX_ARTIFACT_BYTES } from '../workflow/artifactPaths'

const ORIGINAL_ENABLE_AUTH = process.env.CLERUM_ENABLE_AUTH
const ORIGINAL_OUTPUT_DIR = process.env.CLERUM_OUTPUT_DIR
const ORIGINAL_WORKFLOW_ENABLED = process.env.CLERUM_WORKFLOW_ENABLED

async function startServer(
  outputDir: string,
  secretEntries: Array<{ name: string; value: string }> = [],
  options: { workflowEnabled?: boolean } = {}
): Promise<{ server: RPCServer; baseUrl: string }> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  process.env.CLERUM_OUTPUT_DIR = outputDir
  if (options.workflowEnabled) process.env.CLERUM_WORKFLOW_ENABLED = 'true'
  else delete process.env.CLERUM_WORKFLOW_ENABLED
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  server.setArtifactSecretEntriesProvider(() => secretEntries)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

const rpcEdgeHeaders = {
  'x-clerum-edge-caller': 'rpc-proxy',
  'x-clerum-edge-host-ref': 'chatllm',
  'x-clerum-edge-user-id': 'user-1',
}

function makeOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-runtime-artifact-test-'))
}

function restoreEnv(): void {
  if (ORIGINAL_ENABLE_AUTH === undefined) delete process.env.CLERUM_ENABLE_AUTH
  else process.env.CLERUM_ENABLE_AUTH = ORIGINAL_ENABLE_AUTH
  if (ORIGINAL_OUTPUT_DIR === undefined) delete process.env.CLERUM_OUTPUT_DIR
  else process.env.CLERUM_OUTPUT_DIR = ORIGINAL_OUTPUT_DIR
  if (ORIGINAL_WORKFLOW_ENABLED === undefined) delete process.env.CLERUM_WORKFLOW_ENABLED
  else process.env.CLERUM_WORKFLOW_ENABLED = ORIGINAL_WORKFLOW_ENABLED
}

describe('RPCServer runtime artifact routes', () => {
  let outputDir = ''
  let outsideFile = ''

  afterEach(() => {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true })
      outputDir = ''
    }
    if (outsideFile) {
      fs.rmSync(outsideFile, { force: true })
      outsideFile = ''
    }
    restoreEnv()
  })

  it('downloads regular artifacts from the configured output directory', async () => {
    outputDir = makeOutputDir()
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# ok\n')
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/report.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/markdown/)
      expect(res.headers.get('content-length')).toBe('5')
      expect(res.headers.get('x-clerum-redaction')).toBe('scanned')
      expect(await res.text()).toBe('# ok\n')
    } finally {
      await server.stop()
    }
  })

  it('lists only regular downloadable artifacts from the configured output directory', async () => {
    outputDir = makeOutputDir()
    outsideFile = path.join(os.tmpdir(), `clerum-outside-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# ok\n')
    fs.writeFileSync(path.join(outputDir, '.clerum-state'), '{}')
    fs.mkdirSync(path.join(outputDir, 'nested'))
    fs.writeFileSync(outsideFile, 'secret outside output')
    fs.symlinkSync(outsideFile, path.join(outputDir, 'leak.md'))
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: rpcEdgeHeaders })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        artifacts: Array<{ name: string; format: string; sizeBytes: number; createdAt: string }>
      }
      expect(body.artifacts).toHaveLength(1)
      expect(body.artifacts[0]).toMatchObject({
        name: 'report.md',
        format: 'md',
        sizeBytes: 5,
      })
      expect(body.artifacts[0].createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
    } finally {
      await server.stop()
    }
  })

  it('does not download symlink artifacts from the output directory', async () => {
    outputDir = makeOutputDir()
    outsideFile = path.join(os.tmpdir(), `clerum-outside-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(outsideFile, 'secret outside output')
    fs.symlinkSync(outsideFile, path.join(outputDir, 'leak.md'))
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/leak.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/symlink/i)
    } finally {
      await server.stop()
    }
  })

  it('does not download directories as artifacts', async () => {
    outputDir = makeOutputDir()
    fs.mkdirSync(path.join(outputDir, 'nested.md'))
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/nested.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/not found/i)
    } finally {
      await server.stop()
    }
  })

  it('does not download internal workflow state artifacts directly', async () => {
    outputDir = makeOutputDir()
    fs.writeFileSync(path.join(outputDir, '.clerum-state'), '{}')
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/.clerum-state/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('rejects oversized runtime artifact downloads before reading bytes', async () => {
    outputDir = makeOutputDir()
    const artifactPath = path.join(outputDir, 'huge.md')
    fs.writeFileSync(artifactPath, 'x')
    fs.truncateSync(artifactPath, MAX_ARTIFACT_BYTES + 1)
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/huge.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/too large/i)
    } finally {
      await server.stop()
    }
  })

  it('marks unsupported binary downloads as skipped when no raw secret bytes matched', async () => {
    outputDir = makeOutputDir()
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), Buffer.from('%PDF-data'))
    const { server, baseUrl } = await startServer(outputDir, [
      { name: 'API_TOKEN', value: 'super-secret-value' },
    ])

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/report.pdf/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-clerum-redaction')).toBe('skipped:binary')
    } finally {
      await server.stop()
    }
  })

  it('does not mutate binary artifacts even when raw secret bytes are present', async () => {
    outputDir = makeOutputDir()
    const original = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf-8'),
      Buffer.from([0x00, 0xff, 0x80]),
      Buffer.from('super-secret-value\n%%EOF', 'utf-8'),
    ])
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), original)
    const { server, baseUrl } = await startServer(outputDir, [
      { name: 'API_TOKEN', value: 'super-secret-value' },
    ])

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/report.pdf/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-clerum-redaction')).toBe('skipped:binary')
      expect(Buffer.from(await res.arrayBuffer())).toEqual(original)
    } finally {
      await server.stop()
    }
  })

  it('redacts ConfigStore secret values before runtime artifact bytes leave mcp-host', async () => {
    outputDir = makeOutputDir()
    fs.writeFileSync(path.join(outputDir, 'leak.md'), 'token=super-secret-value\n')
    const { server, baseUrl } = await startServer(outputDir, [
      { name: 'API_TOKEN', value: 'super-secret-value' },
    ])

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts/leak.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-clerum-redaction')).toBe('applied')
      expect(await res.text()).toBe('token=[REDACTED:API_TOKEN]\n')
    } finally {
      await server.stop()
    }
  })

  it('does not expose chat runtime artifact endpoints from workflow-mode mcp-host pods', async () => {
    outputDir = makeOutputDir()
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# workflow output\n')
    const { server, baseUrl } = await startServer(outputDir, [], { workflowEnabled: true })

    try {
      const list = await fetch(`${baseUrl}/v1/runtime/artifacts`)
      expect(list.status).toBe(404)

      const download = await fetch(`${baseUrl}/v1/runtime/artifacts/report.md/download`)
      expect(download.status).toBe(404)
    } finally {
      await server.stop()
    }
  })
})
