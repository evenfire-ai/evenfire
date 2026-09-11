// Executed on stdin inside the HCC image's documented working directory.
// Reuse the deployed config parser; never infer a different listener port.
const { config } = require('./dist/config')
const http = require('node:http')

function completedRuntimeSample(body) {
  const name = 'clerum_hcc_initial_convergence_last_success_timestamp_seconds'
  const samplePattern = new RegExp(`^${name}\\{(.*)\\}[ \\t]+([^ \\t]+)[ \\t]*$`)
  const labelPattern =
    /[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:\\[\\"n]|[^"\\\n])*)"[ \t]*/y
  let selected = null
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd()
    if (!line.startsWith(name) || !['{', ' ', '\t', undefined].includes(line[name.length])) continue
    const sample = samplePattern.exec(line)
    if (!sample) return null
    const labels = new Map()
    let offset = 0
    while (offset < sample[1].length) {
      labelPattern.lastIndex = offset
      const label = labelPattern.exec(sample[1])
      if (!label || labels.has(label[1])) return null
      labels.set(
        label[1],
        label[2].replace(/\\([\\"n])/g, (_escape, char) => (char === 'n' ? '\n' : char))
      )
      offset = labelPattern.lastIndex
      if (offset < sample[1].length) {
        if (sample[1][offset++] !== ',' || offset === sample[1].length) return null
      }
    }
    if (labels.get('lane') !== 'McpServer') continue
    if (selected !== null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(sample[2]))
      return null
    const value = Number(sample[2])
    if (!Number.isFinite(value)) return null
    selected = value
  }
  return selected
}

const threshold = Date.parse(process.argv[2]) / 1000
if (!Number.isFinite(threshold)) process.exit(1)
http
  .get(
    {
      hostname: '127.0.0.1',
      port: config.port,
      path: '/metrics',
      signal: AbortSignal.timeout(5000),
    },
    response => {
      let body = ''
      response.on('data', chunk => {
        body += chunk
      })
      response.on('error', () => process.exit(1))
      response.on('end', () => {
        const sample = completedRuntimeSample(body)
        if (response.statusCode !== 200 || sample === null || sample < threshold) process.exit(1)
      })
    }
  )
  .on('error', () => process.exit(1))
