'use strict'

// Forked by tests/unit/workflow/snippetRuntime.test.ts with the grants that the compiled
// runtime (dist/workflow/snippetRuntime.js) builds for outputDir. The compiled worker
// test covers what a snippet can do through the SDK; this probe covers what the grants
// allow to any code in the worker process. It writes an artifact the way writeArtifact
// does, reads a granted file and opens a TCP connection (the liveness witnesses), then
// tries each operation the grants must deny. Each step reports its own result so a
// failure names the step that broke.
const childProcess = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')

function errorCode(error) {
  return error && error.code ? error.code : String(error)
}

async function attempt(operation) {
  try {
    await operation()
    return 'ok'
  } catch (error) {
    return errorCode(error)
  }
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
  const config = JSON.parse(process.argv[2])
  if (config.hang) {
    // Test-only: never report, so the caller's timeout path runs.
    setInterval(() => {}, 1000)
    return
  }
  const { outputDir, distRoot, nodeModules, outsideFile, plantedLink, escapeName } = config
  const artifactPath = path.join(outputDir, 'probe.txt')

  let artifact
  try {
    await fs.mkdir(outputDir, { recursive: true })
    const handle = await fs.open(artifactPath, 'w')
    try {
      await handle.writeFile('ok', 'utf8')
      artifact = { sizeBytes: (await handle.stat()).size }
    } finally {
      await handle.close()
    }
  } catch (error) {
    artifact = { error: errorCode(error) }
  }

  let network
  try {
    network = await readFromLoopback(config.networkPort)
  } catch (error) {
    network = errorCode(error)
  }

  const report = {
    permission: typeof process.permission,
    artifact,
    readGranted: await attempt(() =>
      fs.readFile(path.join(distRoot, 'workflow', 'snippetWorker.js'))
    ),
    network,
    readOutside: await attempt(() => fs.readFile(outsideFile)),
    readOutput: await attempt(() => fs.readFile(artifactPath)),
    readPlantedLink: await attempt(() => fs.readFile(plantedLink)),
    writeDist: await attempt(() => fs.writeFile(path.join(distRoot, escapeName), 'x')),
    writeNodeModules: await attempt(() => fs.writeFile(path.join(nodeModules, escapeName), 'x')),
    // Spelled with a literal "..": the grant must hold for the path Node resolves.
    writeParent: await attempt(() => fs.writeFile(`${outputDir}/../${escapeName}`, 'x')),
    createSymlink: await attempt(() =>
      fs.symlink(outsideFile, path.join(outputDir, 'created-link'))
    ),
    createHardLink: await attempt(() =>
      fs.link(artifactPath, path.join(outputDir, 'probe-hard-link.txt'))
    ),
    childProcess: await attempt(() => {
      childProcess.spawnSync(process.execPath, ['-e', ''])
    }),
  }
  process.send(report, () => process.exit(0))
}

main()
