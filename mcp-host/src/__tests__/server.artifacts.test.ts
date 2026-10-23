import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import type { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'
import type { RPCServer } from '../server'
import { MAX_ARTIFACT_BYTES } from '../workflow/artifactPaths'
import { CALLER_OUTPUTS_DIR, resolveRpcCallerOutputDir } from '../workspace/callerOutputs'
import { deriveUserKeyFromSource } from '../workspace/userKey'
import { withRpcProxyEdgeTestAuthentication } from './rpcProxyEdgeTestHeaders'

const ORIGINAL_ENABLE_AUTH = process.env.CLERUM_ENABLE_AUTH
const ORIGINAL_OUTPUT_DIR = process.env.CLERUM_OUTPUT_DIR
const ORIGINAL_WORKFLOW_ENABLED = process.env.CLERUM_WORKFLOW_ENABLED

/** The Host root the current test's callers live under. */
let hostRoot = ''

async function startServer(
  _outputDir: string,
  secretEntries: Array<{ name: string; value: string }> = [],
  options: { workflowEnabled?: boolean; resolver?: boolean; sharedOutputDir?: string } = {}
): Promise<{ server: RPCServer; baseUrl: string }> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  // The chat routes never read it; a test can point it at a populated folder.
  if (options.sharedOutputDir) process.env.CLERUM_OUTPUT_DIR = options.sharedOutputDir
  else delete process.env.CLERUM_OUTPUT_DIR
  if (options.workflowEnabled) process.env.CLERUM_WORKFLOW_ENABLED = 'true'
  else delete process.env.CLERUM_WORKFLOW_ENABLED
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  server.setArtifactSecretEntriesProvider(() => secretEntries)
  // Wired as main.ts wires it.
  const root = hostRoot
  if (options.resolver !== false) {
    server.setChatArtifactDirResolver(userId => resolveRpcCallerOutputDir(root, userId))
  }
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function edgeHeaders(userId: string): Record<string, string> {
  return withRpcProxyEdgeTestAuthentication({
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': userId,
  })
}

const rpcEdgeHeaders = edgeHeaders('user-1')

/** The caller root of a Desktop user, keyed as their chat messages are. */
function callerRootOf(userId: string): string {
  return path.join(
    hostRoot,
    'users',
    deriveUserKeyFromSource({ sender: userId, channelType: 'rpc' })
  )
}

/** A user's folder of generated files, created on a fresh Host root for user-1. */
function makeOutputDir(userId = 'user-1'): string {
  if (!hostRoot) hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-runtime-artifact-test-'))
  const dir = path.join(callerRootOf(userId), CALLER_OUTPUTS_DIR)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
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
    outputDir = ''
    if (hostRoot) {
      fs.rmSync(hostRoot, { recursive: true, force: true })
      hostRoot = ''
    }
    if (outsideFile) {
      fs.rmSync(outsideFile, { force: true })
      outsideFile = ''
    }
    restoreEnv()
  })

  it("downloads regular artifacts from the caller's own folder", async () => {
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

  it("lists only regular downloadable artifacts from the caller's own folder", async () => {
    outputDir = makeOutputDir()
    outsideFile = path.join(hostRoot, 'outside-list.txt')
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# ok\n')
    fs.writeFileSync(path.join(outputDir, '.clerum-state'), '{}')
    fs.writeFileSync(path.join(outputDir, '.clerum-partial-in-progress'), 'half a file')
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
      const partial = await fetch(
        `${baseUrl}/v1/runtime/artifacts/.clerum-partial-in-progress/download`,
        { headers: rpcEdgeHeaders }
      )
      expect(partial.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it("does not download symlink artifacts from the caller's folder", async () => {
    outputDir = makeOutputDir()
    outsideFile = path.join(hostRoot, 'outside-download.txt')
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

  it("lists and downloads only the requesting user's own files, whatever the name", async () => {
    outputDir = makeOutputDir('user-1')
    fs.writeFileSync(path.join(outputDir, 'mine.md'), '# one\n')
    fs.writeFileSync(path.join(makeOutputDir('user-2'), 'theirs.md'), '# two\n')
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const names = async (userId: string) => {
        const res = await fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: edgeHeaders(userId) })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { artifacts: Array<{ name: string }> }
        return body.artifacts.map(a => a.name)
      }
      expect(await names('user-1')).toEqual(['mine.md'])
      expect(await names('user-2')).toEqual(['theirs.md'])

      const guessed = await fetch(`${baseUrl}/v1/runtime/artifacts/theirs.md/download`, {
        headers: edgeHeaders('user-1'),
      })
      expect(guessed.status).toBe(404)
      const own = await fetch(`${baseUrl}/v1/runtime/artifacts/theirs.md/download`, {
        headers: edgeHeaders('user-2'),
      })
      expect(own.status).toBe(200)
      expect(await own.text()).toBe('# two\n')
    } finally {
      await server.stop()
    }
  })

  it('lists nothing and creates no folder for a user who has generated nothing', async () => {
    outputDir = makeOutputDir('user-1')
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: edgeHeaders('user-3') })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ artifacts: [] })
      const download = await fetch(`${baseUrl}/v1/runtime/artifacts/mine.md/download`, {
        headers: edgeHeaders('user-3'),
      })
      expect(download.status).toBe(404)
      expect(fs.existsSync(callerRootOf('user-3'))).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('answers 503, not another folder, when the caller folder is a link', async () => {
    outputDir = makeOutputDir('user-1')
    const elsewhere = path.join(hostRoot, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, 'report.md'), '# not yours\n')
    fs.rmSync(outputDir, { recursive: true })
    fs.symlinkSync(elsewhere, outputDir)
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const list = await fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: rpcEdgeHeaders })
      expect(list.status).toBe(503)
      expect(await list.json()).toMatchObject({ code: 'artifact_store_unavailable' })
      const download = await fetch(`${baseUrl}/v1/runtime/artifacts/report.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(download.status).toBe(503)
    } finally {
      await server.stop()
    }
  })

  it('answers 503 and never serves the shared folder when no resolver is wired', async () => {
    outputDir = makeOutputDir('user-1')
    const shared = path.join(hostRoot, 'outputs')
    fs.mkdirSync(shared)
    fs.writeFileSync(path.join(shared, 'report.md'), '# shared\n')
    const { server, baseUrl } = await startServer(outputDir, [], {
      resolver: false,
      sharedOutputDir: shared,
    })

    try {
      const list = await fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: rpcEdgeHeaders })
      expect(list.status).toBe(503)
      const download = await fetch(`${baseUrl}/v1/runtime/artifacts/report.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(download.status).toBe(503)
    } finally {
      await server.stop()
    }
  })

  it('limits each caller on their own, so one cannot starve the others', async () => {
    outputDir = makeOutputDir('user-1')
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# ok\n')
    const { server, baseUrl } = await startServer(outputDir)

    try {
      const list = (userId: string) =>
        fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: edgeHeaders(userId) })
      for (let call = 0; call < 600; call++) {
        const res = await list('user-1')
        expect(res.status).toBe(200)
        await res.arrayBuffer()
      }
      const limited = await list('user-1')
      expect(limited.status).toBe(429)
      expect(await limited.json()).toEqual({ error: 'Too Many Requests', retryable: true })
      const download = await fetch(`${baseUrl}/v1/runtime/artifacts/report.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(download.status).toBe(429)
      // Another caller, through the same rpc-proxy address, is still served.
      const other = await list('user-2')
      expect(other.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  it('does not serve CLERUM_OUTPUT_DIR in chat when a resolver is wired', async () => {
    outputDir = makeOutputDir('user-1')
    const shared = path.join(hostRoot, 'outputs')
    fs.mkdirSync(shared)
    fs.writeFileSync(path.join(shared, 'report.md'), '# shared\n')
    const { server, baseUrl } = await startServer(outputDir, [], { sharedOutputDir: shared })

    try {
      const list = await fetch(`${baseUrl}/v1/runtime/artifacts`, { headers: rpcEdgeHeaders })
      expect(await list.json()).toEqual({ artifacts: [] })
      const download = await fetch(`${baseUrl}/v1/runtime/artifacts/report.md/download`, {
        headers: rpcEdgeHeaders,
      })
      expect(download.status).toBe(404)
    } finally {
      await server.stop()
    }
  })
})
