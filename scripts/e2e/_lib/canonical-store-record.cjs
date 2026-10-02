const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const MAX_RECORD_BYTES = 64 * 1024
// The E2E harness already requires Python 3 for its static audit. Node has no
// openat API; Python's POSIX dir_fd keeps the read anchored to an opened parent
// on both macOS and Linux, including when its pathname is replaced.
const READ_RECORD = `
import os, stat, sys
MAX_BYTES = 64 * 1024
def checked_stat(descriptor):
    info = os.fstat(descriptor)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
            stat.S_IMODE(info.st_mode) != 0o600 or
            info.st_size <= 0 or info.st_size > MAX_BYTES):
        sys.exit(2)
    return info
descriptor = None
try:
    parent = os.fstat(3)
    if (not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) != 0o700 or
            parent.st_uid != os.getuid()):
        sys.exit(2)
    name = sys.argv[1]
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=3)
    before = checked_stat(descriptor)
    chunks = []
    length = 0
    while length < before.st_size + 1:
        chunk = os.read(descriptor, before.st_size + 1 - length)
        if not chunk:
            break
        chunks.append(chunk)
        length += len(chunk)
    after = checked_stat(descriptor)
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if length != before.st_size or any(getattr(before, f) != getattr(after, f) for f in fields):
        sys.exit(3)
    sys.stdout.buffer.write(b"".join(chunks))
except FileNotFoundError:
    sys.exit(4)
except (OSError, ValueError):
    sys.exit(2)
finally:
    if descriptor is not None:
        os.close(descriptor)
`

function openCanonicalStoreRecordDirectory(directory) {
  for (const flag of ['O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK']) {
    if (typeof fs.constants[flag] !== 'number')
      throw new Error('Safe canonical-store record reads require POSIX file flags')
  }
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
      fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  )
  try {
    const info = fs.fstatSync(descriptor)
    if (!info.isDirectory() || (info.mode & 0o7777) !== 0o700 || info.uid !== process.getuid())
      throw new Error('Unsafe canonical-store record directory')
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

function readCanonicalStoreRecord(filename, directoryDescriptor) {
  const name = path.basename(filename)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(name))
    throw new Error('Invalid canonical-store record name')
  const ownsDirectory = directoryDescriptor === undefined
  const directory = ownsDirectory
    ? openCanonicalStoreRecordDirectory(path.dirname(filename))
    : directoryDescriptor
  try {
    const result = childProcess.spawnSync('python3', ['-I', '-S', '-c', READ_RECORD, name], {
      stdio: ['ignore', 'pipe', 'pipe', directory],
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: MAX_RECORD_BYTES + 1,
    })
    if (result.error || result.signal || result.status === null)
      throw new Error('Canonical-store record reader failed')
    if (result.status === 4) {
      const error = new Error('Canonical-store record not yet published')
      error.code = 'ENOENT'
      throw error
    }
    if (result.status === 3) throw new Error('Canonical-store record changed during read')
    if (result.status !== 0) throw new Error('Unsafe canonical-store record')
    let record
    try {
      record = JSON.parse(result.stdout)
    } catch {
      // JSON.parse errors can quote input; keep private record bytes out of logs.
      throw new Error('Invalid canonical-store record JSON')
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Invalid canonical-store record object')
    return record
  } finally {
    if (ownsDirectory) fs.closeSync(directory)
  }
}

module.exports = { openCanonicalStoreRecordDirectory, readCanonicalStoreRecord }
