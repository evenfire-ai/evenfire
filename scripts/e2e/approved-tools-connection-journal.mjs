import fs from 'node:fs'
import path from 'node:path'

export function connectionCaptureName(scenario) {
  if (!['83', '150', '250', 'workflow'].includes(scenario))
    throw new Error('Invalid connection scenario')
  return `created-connection-${scenario}.json`
}
function validateBinding(binding) {
  if (
    Object.keys(binding).sort().join(',') !== 'context,fixtureUserId,profile,run,scenario' ||
    !/^approved-tools-[a-f0-9]{12}$/.test(binding.run) ||
    !/^clerum-[a-z0-9-]+-[a-f0-9]{7,8}$/.test(binding.profile) ||
    binding.context !== binding.profile ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(binding.fixtureUserId)
  )
    throw new Error('Invalid connection capture binding')
  connectionCaptureName(binding.scenario)
}
export function validateConnectionCapture(value, binding) {
  validateBinding(binding)
  if (
    JSON.stringify(value.binding) !== JSON.stringify(binding) ||
    value.version !== 1 ||
    value.status !== 'created' ||
    Object.keys(value).sort().join(',') !== 'binding,evidence,status,version'
  )
    throw new Error('Incomplete or foreign connection capture')
  const e = value.evidence
  if (
    !e ||
    Object.keys(e).sort().join(',') !==
      'connectionKey,createdBy,displayName,fixtureUserId,id,scenario' ||
    e.scenario !== binding.scenario ||
    e.fixtureUserId !== binding.fixtureUserId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(e.id) ||
    !/^codex-[a-f0-9]{16}$/.test(e.connectionKey) ||
    e.displayName !== `Codex fixture ${binding.scenario} ${binding.run}` ||
    e.createdBy !== null
  )
    throw new Error('Invalid public connection evidence')
  return e
}
export function beginConnectionCapture(root, binding) {
  validateBinding(binding)
  if (fs.realpathSync(root) !== path.resolve(root))
    throw new Error('Connection evidence path must be canonical')
  const parent = fs.lstatSync(root)
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o022
  )
    throw new Error('Unsafe connection evidence directory')
  const fd = fs.openSync(
    path.join(root, connectionCaptureName(binding.scenario)),
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
    0o600
  )
  const inode = fs.fstatSync(fd)
  const write = value => {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.dev !== inode.dev ||
      stat.ino !== inode.ino
    )
      throw new Error('Unsafe connection capture file')
    const data = Buffer.from(JSON.stringify(value) + '\n')
    if (data.length > 4096) throw new Error('Connection capture exceeds limit')
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, data, 0, data.length, 0)
    fs.fsyncSync(fd)
  }
  try {
    write({ version: 1, binding, status: 'creation-pending' })
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  let recorded = false
  return {
    record(body) {
      if (recorded) throw new Error('Connection already captured')
      const evidence = {
        scenario: binding.scenario,
        fixtureUserId: binding.fixtureUserId,
        id: body.id,
        connectionKey: body.connectionKey,
        displayName: body.displayName,
        createdBy: body.createdBy,
      }
      const value = { version: 1, binding, status: 'created', evidence }
      validateConnectionCapture(value, binding)
      write(value)
      recorded = true
    },
    close() {
      fs.closeSync(fd)
    },
  }
}
