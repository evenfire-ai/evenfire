// Executed on stdin inside the HCC image's documented working directory.
// Reuse the deployed config parser; never infer a different listener port.
const { config } = require('./dist/config')
const http = require('node:http')
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
        const sample = body.match(
          /^clerum_hcc_initial_convergence_last_success_timestamp_seconds\{lane="McpServer"\} ([0-9.e+]+)$/m
        )
        if (response.statusCode !== 200 || !sample || Number(sample[1]) < threshold) process.exit(1)
      })
    }
  )
  .on('error', () => process.exit(1))
