/**
 * #1338: the MCP authorization store reads Secrets through the watcher's
 * module-level `coreApi`, which k8sClient.ts builds at import time when dev
 * mode is off. The factory test in k8sRequestDeadline.reconcilers.test.ts
 * cannot see whether the module uses the factory, so this test imports the
 * module against a kubeconfig whose API server never answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { K8S_REQUEST_TIMEOUT_CODE } from './k8s/k8sRequestDeadline'

const DEADLINE_MS = 200

vi.mock('./config', async importOriginal => {
  const actual = await importOriginal<typeof import('./config')>()
  return {
    ...actual,
    config: { ...actual.config, devMode: false, namespace: 'mcp-server', k8sRequestTimeoutMs: 200 },
  }
})

const seenPaths: string[] = []
let server: http.Server | undefined
let kubeconfigDir: string | undefined

/** Writes a kubeconfig for a local API server that accepts every request and never answers. */
async function silentKubeconfig(): Promise<string> {
  server = http.createServer(req => {
    seenPaths.push(req.url ?? '')
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no TCP address')
  kubeconfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-authz-deadline-'))
  const file = path.join(kubeconfigDir, 'kubeconfig.yaml')
  fs.writeFileSync(
    file,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: silent',
      '  cluster:',
      `    server: http://127.0.0.1:${address.port}`,
      '    insecure-skip-tls-verify: true',
      'users:',
      '- name: tester',
      '  user: {}',
      'contexts:',
      '- name: silent',
      '  context:',
      '    cluster: silent',
      '    user: tester',
      'current-context: silent',
      '',
    ].join('\n')
  )
  return file
}

afterEach(async () => {
  seenPaths.length = 0
  vi.unstubAllEnvs()
  vi.resetModules()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
  if (kubeconfigDir) fs.rmSync(kubeconfigDir, { recursive: true, force: true })
  kubeconfigDir = undefined
})

describe('#1338 the MCP authorization store reads Secrets on the request deadline', () => {
  it('ends a Secret read whose API server never answers', async () => {
    vi.stubEnv('KUBECONFIG', await silentKubeconfig())
    vi.resetModules()
    const { createMcpAuthorizationStore } = await import('./k8sClient')
    const store = createMcpAuthorizationStore({} as never)

    let timer: ReturnType<typeof setTimeout> | undefined
    const read = Promise.race([
      store.readSecret('silent-input'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('readSecret still pending after the deadline')),
          DEADLINE_MS * 10
        )
      }),
    ]).finally(() => clearTimeout(timer))

    await expect(read).rejects.toMatchObject({
      code: K8S_REQUEST_TIMEOUT_CODE,
      operation: 'CoreV1Api.readNamespacedSecret',
      timeoutMs: DEADLINE_MS,
    })
    // Witness: the read reached the API server.
    expect(seenPaths.some(seen => seen.includes('/secrets/silent-input'))).toBe(true)
  })
})
