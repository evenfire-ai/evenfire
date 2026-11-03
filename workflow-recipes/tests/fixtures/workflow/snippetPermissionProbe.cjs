'use strict'

// Forked by tests/unit/workflow/snippetRuntime.test.ts with buildPermissionArgs(outputDir)
// as execArgv. It does what a snippet worker fork does under the permission model:
// loads the worker's external modules (src/workflow/snippetWorker.ts imports), runs the
// writeArtifact fs sequence (mkdir, writeFile, stat), opens a TCP connection as the
// MongoDB, PostgreSQL and MCP clients do, and reads one path outside every grant.
// Each step reports its own result so a failure names the step that broke.
const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')

const WORKER_MODULES = [
  '@modelcontextprotocol/sdk/client/index.js',
  '@modelcontextprotocol/sdk/client/sse.js',
  '@modelcontextprotocol/sdk/client/streamableHttp.js',
  'mongodb',
  'pg',
  'typescript',
]

function errorCode(error) {
  return error && error.code ? error.code : String(error)
}

function readFromLoopback(port) {
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = net.connect(port, '127.0.0.1')
    } catch (error) {
      reject(error)
      return
    }
    let data = ''
    socket.on('data', chunk => {
      data += String(chunk)
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

async function main() {
  const [outputDir, outsidePath, networkPort] = process.argv.slice(2)
  const modules = {}
  for (const name of WORKER_MODULES) {
    try {
      require(name)
      modules[name] = 'ok'
    } catch (error) {
      modules[name] = errorCode(error)
    }
  }

  let artifact
  try {
    const target = path.join(outputDir, 'probe.txt')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(target, 'ok', 'utf8')
    artifact = { sizeBytes: (await fs.stat(target)).size }
  } catch (error) {
    artifact = { error: errorCode(error) }
  }

  let network
  try {
    network = await readFromLoopback(Number(networkPort))
  } catch (error) {
    network = errorCode(error)
  }

  let outsideRead
  try {
    await fs.readFile(outsidePath)
    outsideRead = 'ok'
  } catch (error) {
    outsideRead = errorCode(error)
  }

  process.send(
    { permission: typeof process.permission, modules, artifact, network, outsideRead },
    () => process.exit(0)
  )
}

main()
