import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type Server, type ServerResponse, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type KubernetesObject = Readonly<Record<string, unknown>>

type RecordedRequest = Readonly<{
  method: string
  namespace: string
  plural: string
  name: string | null
  watch: boolean
  resourceVersion: string | null
  limit: string | null
  continueToken: string | null
}>

function metadata(value: KubernetesObject): Record<string, unknown> {
  const candidate = value.metadata
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {}
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized),
  })
  response.end(serialized)
}

export class TemporaryKubernetesApi {
  private readonly objects = new Map<string, KubernetesObject>()
  private readonly watchResponses = new Set<ServerResponse>()
  private readonly server: Server
  private scratchDirectory: string | null = null
  private kubeconfigPath: string | null = null
  private origin: string | null = null
  private heldList: {
    response: ServerResponse | null
    requested: () => void
    closed: () => void
  } | null = null
  readonly requests: RecordedRequest[] = []

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request.method ?? 'GET', request.url ?? '/', response)
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('temporary_kubernetes_address')
    this.origin = `http://127.0.0.1:${address.port}`
    const scratchRoot = process.env.CODEX_SCRATCH_ROOT || tmpdir()
    this.scratchDirectory = await mkdtemp(join(scratchRoot, 'evenfire-k8s-api-'))
    this.kubeconfigPath = join(this.scratchDirectory, 'kubeconfig.yaml')
    await writeFile(
      this.kubeconfigPath,
      `apiVersion: v1
kind: Config
clusters:
  - name: temporary
    cluster:
      server: ${this.origin}
      insecure-skip-tls-verify: true
users:
  - name: temporary
    user: {}
contexts:
  - name: temporary
    context:
      cluster: temporary
      user: temporary
current-context: temporary
`,
      'utf8'
    )
  }

  kubeconfig(): string {
    if (!this.kubeconfigPath) throw new Error('temporary_kubernetes_not_started')
    return this.kubeconfigPath
  }

  put(plural: string, namespace: string, object: KubernetesObject): void {
    const name = String(metadata(object).name ?? '')
    if (!name) throw new Error('temporary_kubernetes_name_missing')
    this.objects.set(`${namespace}/${plural}/${name}`, object)
  }

  delete(plural: string, namespace: string, name: string): void {
    this.objects.delete(`${namespace}/${plural}/${name}`)
  }

  emitWatch(phase: string, object: KubernetesObject): void {
    const event = `${JSON.stringify({ type: phase, object })}\n`
    for (const response of this.watchResponses) response.write(event)
  }

  holdNextList(): Readonly<{
    requested: Promise<void>
    closed: Promise<void>
    release: () => void
  }> {
    if (this.heldList) throw new Error('temporary_kubernetes_list_already_held')
    let requested!: () => void
    let closed!: () => void
    const requestedPromise = new Promise<void>(resolve => {
      requested = resolve
    })
    const closedPromise = new Promise<void>(resolve => {
      closed = resolve
    })
    this.heldList = { response: null, requested, closed }
    return Object.freeze({
      requested: requestedPromise,
      closed: closedPromise,
      release: () => {
        const held = this.heldList
        if (!held?.response) return
        json(held.response, 200, {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'List',
          metadata: { resourceVersion: '1', continue: '' },
          items: [],
        })
        this.heldList = null
      },
    })
  }

  async close(): Promise<void> {
    for (const response of this.watchResponses) response.end()
    this.watchResponses.clear()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    this.server.closeAllConnections?.()
    if (this.scratchDirectory) await rm(this.scratchDirectory, { recursive: true, force: true })
    this.scratchDirectory = null
    this.kubeconfigPath = null
  }

  private async handle(method: string, rawUrl: string, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(rawUrl, this.origin ?? 'http://127.0.0.1')
    const match = requestUrl.pathname.match(
      /^\/apis\/clerum\.io\/v1alpha1\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/
    )
    if (method !== 'GET' || !match) {
      json(response, 404, { kind: 'Status', code: 404, reason: 'NotFound' })
      return
    }
    const namespace = decodeURIComponent(match[1])
    const plural = decodeURIComponent(match[2])
    const name = match[3] ? decodeURIComponent(match[3]) : null
    const watch = requestUrl.searchParams.get('watch') === 'true'
    this.requests.push(
      Object.freeze({
        method,
        namespace,
        plural,
        name,
        watch,
        resourceVersion: requestUrl.searchParams.get('resourceVersion'),
        limit: requestUrl.searchParams.get('limit'),
        continueToken: requestUrl.searchParams.get('continue'),
      })
    )
    if (watch) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      })
      this.watchResponses.add(response)
      response.on('close', () => this.watchResponses.delete(response))
      return
    }
    if (name) {
      const object = this.objects.get(`${namespace}/${plural}/${name}`)
      if (!object) {
        json(response, 404, { kind: 'Status', code: 404, reason: 'NotFound' })
        return
      }
      json(response, 200, object)
      return
    }
    if (this.heldList && !this.heldList.response) {
      this.heldList.response = response
      this.heldList.requested()
      response.on('close', () => {
        this.heldList?.closed()
        this.heldList = null
      })
      return
    }
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${namespace}/${plural}/`))
      .map(([, object]) => object)
      .sort((left, right) =>
        String(metadata(left).name).localeCompare(String(metadata(right).name))
      )
    const start = Number(requestUrl.searchParams.get('continue') ?? 0)
    const requestedLimit = Number(requestUrl.searchParams.get('limit') ?? 100)
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100
    const items = all.slice(start, start + limit)
    const next = start + items.length < all.length ? String(start + items.length) : ''
    const resourceVersion = all.reduce(
      (maximum, object) => Math.max(maximum, Number(metadata(object).resourceVersion ?? 0)),
      1
    )
    json(response, 200, {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'List',
      metadata: { resourceVersion: String(resourceVersion), continue: next },
      items,
    })
  }
}
