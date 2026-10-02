/** Native loopback inspector reader. It creates no production endpoint and never retains request bodies. */
export class InspectorClient {
  constructor(socket, timeoutMs = 5000) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map()
    socket.addEventListener('message', event => {
      let reply
      try { reply = JSON.parse(String(event.data)) } catch { this.fail(new Error('Inspector returned invalid JSON')); return }
      if (!Number.isSafeInteger(reply.id)) return
      const entry = this.pending.get(reply.id); if (!entry) return
      this.pending.delete(reply.id); clearTimeout(entry.timer)
      if (reply.error) entry.reject(new Error('Inspector rejected a required command'))
      else entry.resolve(reply.result)
    })
    socket.addEventListener('close', () => this.fail(new Error('Inspector closed before observations completed')))
    socket.addEventListener('error', () => this.fail(new Error('Inspector transport failed')))
  }
  fail(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }; this.pending.clear() }
  call(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Inspector deadline: ${method}`)) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('Inspector send failed')) }
    })
  }
  async snapshot() {
    const reply = await this.call('Runtime.evaluate', { expression: "JSON.stringify({pid:process.pid,nodeVersion:process.versions.node,argv:process.argv,execArgv:process.execArgv,nodeOptions:process.env.NODE_OPTIONS||'',cwd:process.cwd(),at:Date.now(),memory:process.memoryUsage()})", returnByValue: true })
    if (reply?.exceptionDetails || typeof reply?.result?.value !== 'string') throw new Error('Actual server metrics unavailable')
    const data = JSON.parse(reply.result.value)
    for (const name of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) if (!Number.isSafeInteger(data.memory?.[name]) || data.memory[name] < 0) throw new Error('Actual server memory metrics incomplete')
    if (!Number.isSafeInteger(data.pid) || !Number.isSafeInteger(data.at) || !/^24\./.test(data.nodeVersion)) throw new Error('Actual server process identity is invalid')
    return data
  }
  async forceGc() {
    const before = await this.snapshot()
    await this.call('HeapProfiler.enable')
    await this.call('HeapProfiler.collectGarbage')
    const after = await this.snapshot()
    if (before.pid !== after.pid || after.at < before.at) throw new Error('GC metrics belong to another process/window')
    return { kind: 'native-HeapProfiler.collectGarbage', forced: true, before, after }
  }
  async startCoverage() { await this.call('Profiler.enable'); await this.call('Profiler.startPreciseCoverage', { callCount: true, detailed: false }) }
  async coverage() {
    const reply = await this.call('Profiler.takePreciseCoverage')
    if (!Array.isArray(reply?.result)) throw new Error('Native coverage unavailable')
    const names = [
      { key: 'parser', suffix: '/body-parser/lib/types/json.js', name: 'jsonParser' },
      { key: 'authorizer', suffix: '/services/llmProviderAttemptAuthorizer.js', name: 'authorizeLlmProviderAttempt' },
    ]
    const observed = {}
    for (const target of names) {
      const scripts = reply.result.filter(script => String(script.url).endsWith(target.suffix))
      const functions = scripts.flatMap(script => script.functions).filter(fn => fn.functionName === target.name)
      if (!functions.length || functions.some(fn => !Number.isSafeInteger(fn.ranges?.[0]?.count))) throw new Error(`Actual ${target.key} coverage function is missing`)
      observed[target.key] = functions.reduce((sum, fn) => sum + fn.ranges[0].count, 0)
    }
    return observed
  }
  async stopCoverage() { await this.call('Profiler.stopPreciseCoverage'); await this.call('Profiler.disable') }
  close() { this.fail(new Error('Inspector disposed')); this.socket.close() }
}
export async function connectInspector(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback inspector port')
  const endpoint = new URL('http://127.0.0.1'); endpoint.port = String(port); endpoint.pathname = '/json/list'
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('Loopback inspector discovery failed')
  const list = await response.json()
  if (!Array.isArray(list) || list.length !== 1) throw new Error('Loopback inspector target is ambiguous')
  const url = new URL(list[0].webSocketDebuggerUrl)
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw new Error('Inspector is exposed outside its loopback boundary')
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection deadline')) }, 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')) }, { once: true })
  })
  return new InspectorClient(socket)
}
export function parseCgroup(raw) {
  const number = value => { if (!/^\d+$/.test(String(value).trim())) throw new Error('Cgroup metric is unavailable'); const parsed = Number(String(value).trim()); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Cgroup metric is invalid'); return parsed }
  const current = number(raw.current), peak = number(raw.peak), limit = number(raw.limit)
  if (limit !== 768 * 1024 * 1024 || peak < current) throw new Error('Actual cgroup is not the required 768Mi limit/window')
  const events = {}
  for (const line of String(raw.events).trim().split('\n')) { const [key, value] = line.trim().split(/\s+/); events[key] = number(value) }
  for (const key of ['max', 'oom', 'oom_kill']) if (!Number.isSafeInteger(events[key])) throw new Error('Cgroup events are incomplete')
  return { current, peak, limit, events }
}
