// E2E_GUARDIAN_IPC_FLOW: physical admission helpers only; no launch, login,
// environment-file loading, network, or filesystem access at module import.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export class RunnerAdmissionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RunnerAdmissionError'
    this.code = code
  }
}
const refuse = code => {
  throw new RunnerAdmissionError(code)
}
export const digest = value => createHash('sha256').update(value).digest('hex')
const inside = (root, value) => path.isAbsolute(value) && value.startsWith(`${root}/`)
const integer = value => Number.isSafeInteger(value) && value > 0
const nsFields = ['mountNamespace', 'pidNamespace', 'userNamespace']
const nsNames = ['mnt', 'pid', 'user']
export const RUNNER_RUN_BASE = '/run/evenfire-e2e'
export const RUNNER_ADMISSION_ROOT = '/runner-admission'

export function admissionVolumeName(runId) {
  if (!/^subscription-image-[a-f0-9]{12}$/.test(runId ?? '')) refuse('ADMISSION_VOLUME_IDENTITY')
  return `evenfire-sir-${runId.slice('subscription-image-'.length)}-admission`
}

export function readPrivateRecord(filename, maxBytes = 64 * 1024, uid = process.getuid?.()) {
  if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename))
    refuse('PRIVATE_PARENT_SYMLINK')
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maxBytes
    )
      refuse('PRIVATE_JSON_OWNERSHIP_OR_BOUND')
    const raw = fs.readFileSync(fd)
    return { value: JSON.parse(raw.toString('utf8')), sha256: digest(raw) }
  } finally {
    fs.closeSync(fd)
  }
}
export function readPrivateJson(filename, maxBytes = 64 * 1024, uid = process.getuid?.()) {
  return readPrivateRecord(filename, maxBytes, uid).value
}

// Sealed receipts reach the run container through a per-run named volume: the
// non-root prep helper in this image writes them as 0600 owned by the container
// user, then the run container mounts that volume read-only. Provenance is the
// main-side docker inspect plus the volume identity and hash bindings in the
// admission, not an "other uid" assertion.
export function readMainRecord(filename, maxBytes = 4 * 1024 * 1024) {
  const parent = path.dirname(filename)
  if (fs.realpathSync(parent) !== parent) refuse('MAIN_RECEIPT_PARENT_SYMLINK')
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > maxBytes
    )
      refuse('MAIN_RECEIPT_BOUND_OR_MODE')
    const raw = fs.readFileSync(fd)
    return { value: JSON.parse(raw.toString('utf8')), sha256: digest(raw), uid: stat.uid }
  } finally {
    fs.closeSync(fd)
  }
}

const PORT_FORWARD_RECORD_VERSION = '1'
const PORT_FORWARD_RECORD_KEYS = [
  'PORT_FORWARD_OWNER_VERSION',
  'PID',
  'PROCESS_START',
  'PROFILE',
  'CONTEXT',
  'WORKTREE',
  'NAMESPACE',
  'SERVICE',
  'LOCAL_PORT',
  'REMOTE_PORT',
  'ADDRESS',
]
// Exact parser for scripts/minikube/port-forward-owner.sh records.
export function parsePortForwardRecord(text) {
  if (typeof text !== 'string' || !text.length || text.length > 8 * 1024)
    refuse('PORT_FORWARD_RECORD_BOUND')
  const lines = text.split('\n')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  const first = lines.shift()
  if (!/^[1-9][0-9]*$/.test(first ?? '')) refuse('PORT_FORWARD_RECORD_PID')
  const fields = {}
  for (const line of lines) {
    const split = line.indexOf('=')
    if (split <= 0) refuse('PORT_FORWARD_RECORD_LINE')
    const key = line.slice(0, split)
    if (!PORT_FORWARD_RECORD_KEYS.includes(key) || Object.hasOwn(fields, key))
      refuse('PORT_FORWARD_RECORD_KEY')
    fields[key] = line.slice(split + 1)
  }
  if (
    fields.PORT_FORWARD_OWNER_VERSION !== PORT_FORWARD_RECORD_VERSION ||
    fields.PID !== first ||
    fields.ADDRESS !== '127.0.0.1' ||
    !/^[0-9]{1,5}$/.test(fields.LOCAL_PORT ?? '') ||
    !/^[0-9]{1,5}$/.test(fields.REMOTE_PORT ?? '') ||
    !fields.PROCESS_START ||
    !fields.PROFILE ||
    !fields.CONTEXT ||
    !fields.WORKTREE ||
    !fields.NAMESPACE ||
    !fields.SERVICE
  )
    refuse('PORT_FORWARD_RECORD_SHAPE')
  return {
    pid: Number(fields.PID),
    processStart: fields.PROCESS_START,
    profile: fields.PROFILE,
    context: fields.CONTEXT,
    worktree: fields.WORKTREE,
    namespace: fields.NAMESPACE,
    service: fields.SERVICE,
    localPort: Number(fields.LOCAL_PORT),
    remotePort: Number(fields.REMOTE_PORT),
    address: fields.ADDRESS,
  }
}

const PORTS_ENV_KEYS = new Set([
  'PORT_BASE',
  'CONTROL_UI_PORT',
  'PROFILE_UI_PORT',
  'CONTROL_API_PORT',
  'EXTERNAL_REST_API_PORT',
  'MEMBER_REGISTRATION_SERVICE_PORT',
  'RPC_PROXY_PORT',
  'REGISTRY_API_PORT',
  'WORKFLOW_APPROVAL_READER_PORT',
  'MCP_HOST_PORT',
  'CONTROL_UI_URL',
  'CONTROL_UI_BASE_URL',
  'PROFILE_UI_URL',
  'PROFILE_UI_BASE_URL',
  'CONTROL_API_URL',
  'CONTROL_API_BASE_URL',
  'EXTERNAL_REST_API_URL',
  'EXTERNAL_REST_API_BASE_URL',
  'MEMBER_REGISTRATION_SERVICE_URL',
  'MEMBER_REGISTRATION_SERVICE_BASE_URL',
  'RPC_PROXY_URL',
  'RPC_PROXY_BASE_URL',
  'REGISTRY_API_URL',
  'REGISTRY_API_BASE_URL',
  'WORKFLOW_APPROVAL_READER_URL',
  'WORKFLOW_APPROVAL_READER_BASE_URL',
  'MCP_HOST_URL',
  'MCP_HOST_BASE_URL',
])
export function parsePortsEnv(text) {
  if (typeof text !== 'string' || !text.length || text.length > 8 * 1024)
    refuse('PORTS_ENV_BOUND')
  const values = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const split = line.indexOf('=')
    if (split <= 0) refuse('PORTS_ENV_LINE')
    const key = line.slice(0, split),
      value = line.slice(split + 1)
    if (!PORTS_ENV_KEYS.has(key) || Object.hasOwn(values, key)) refuse('PORTS_ENV_KEY')
    if (/^[0-9]{2,5}$/.test(value)) values[key] = Number(value)
    else if (/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(value)) values[key] = value
    else refuse('PORTS_ENV_VALUE')
  }
  return values
}

export const MAIN_ADMISSION_KIND = 'evenfire-subscription-image-main-admission-v2'
export const MAIN_RECEIPT_FILES = {
  inspect: 'docker-inspect.json',
  stack: 'stack-marker.json',
  portForwards: 'port-forwards.json',
}
export const PINNED_BASE_IMAGE_FILE = 'scripts/e2e/fixtures/subscription-image-runner.base-image'
export const SFW_FREE_VERSION = '1.15.1'
// Official SocketDev/sfw-free release metadata, reviewed from the GitHub API.
// The linux x86_64 asset name follows the same release naming as arm64; a wrong
// name fails the pinned checksum fetch instead of silently passing.
export const SFW_FREE_ASSETS = Object.freeze({
  'linux-arm64': {
    name: 'sfw-free-linux-arm64',
    arch: 'arm64',
    machine: 0xb7,
    bytes: 136_907_904,
    sha256: '4d02d1c1f5d6b6444721b0a67bd0e80aab182fe7f22d692570d1c14797602c47',
  },
  'linux-x64': {
    name: 'sfw-free-linux-x86_64',
    arch: 'x64',
    machine: 0x3e,
    bytes: 139_922_624,
    sha256: '8898d0667c2165aecd695ca797473ec3a429d2ed807d4d0bf9e67c45817ea809',
  },
})
export function sfwFreeAsset(arch = process.arch) {
  const key = arch === 'arm64' ? 'linux-arm64' : arch === 'x64' ? 'linux-x64' : null
  if (!key) refuse('SFW_FREE_ARCH_UNSUPPORTED')
  const asset = SFW_FREE_ASSETS[key]
  return {
    ...asset,
    url: `https://github.com/SocketDev/sfw-free/releases/download/v${SFW_FREE_VERSION}/${asset.name}`,
  }
}
export function verifyThirdPartyArtifact({ bytes, asset } = {}) {
  if (!Buffer.isBuffer(bytes) || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? ''))
    refuse('THIRD_PARTY_ARTIFACT_INPUT')
  if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
    refuse('THIRD_PARTY_ARTIFACT_HASH')
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('hex') !== '7f454c46')
    refuse('THIRD_PARTY_ARTIFACT_NOT_ELF')
  if (bytes[4] !== 2 || bytes[5] !== 1) refuse('THIRD_PARTY_ARTIFACT_NOT_ELF64_LE')
  const elfMachine = bytes.readUInt16LE(18)
  if (elfMachine !== asset.machine) refuse('THIRD_PARTY_ARTIFACT_MACHINE')
  return {
    name: 'sfw-free',
    version: SFW_FREE_VERSION,
    arch: asset.arch,
    sha256: asset.sha256,
    bytes: asset.bytes,
    elfMachine,
  }
}
export const SESSION_OBSERVATION_FILE = 'session-observation.json'
export const SESSION_READY_MARKER = 'session-created'
export const PORT_FORWARD_SERVICES = {
  rest: { namespace: 'profiles', service: 'external-rest-api', remotePort: 8091, key: 'EXTERNAL_REST_API_PORT' },
  rpc: { namespace: 'rpc-proxy', service: 'rpc-proxy', remotePort: 8094, key: 'RPC_PROXY_PORT' },
}
const personalStatePath = value =>
  /(^|\/)(Users|\.ssh|\.aws|\.gnupg|\.config|keychains?|credentials?|docker\.sock)(\/|$)/i.test(
    typeof value === 'string' ? value : ''
  )

const unescapeMount = value =>
  value.replace(/\\([0-7]{3})/g, (_whole, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
export function parseMountInfo(raw) {
  return raw
    .trim()
    .split('\n')
    .map(line => {
      const split = line.indexOf(' - ')
      if (split < 0) refuse('MOUNTINFO_MALFORMED')
      const left = line.slice(0, split).split(' '),
        right = line.slice(split + 3).split(' ')
      if (left.length < 6 || right.length < 3 || !/^\d+$/.test(left[0]))
        refuse('MOUNTINFO_MALFORMED')
      return {
        id: left[0],
        root: unescapeMount(left[3]),
        point: unescapeMount(left[4]),
        options: left[5].split(','),
        fsType: right[0],
        source: unescapeMount(right[1]),
        superOptions: right[2].split(','),
      }
    })
}

export function verifyMountIsolation(mounts, home, runBase, admissionRoot) {
  const exact = point => {
    const matches = mounts.filter(mount => mount.point === point)
    if (matches.length !== 1) refuse('MOUNT_REQUIRED_OR_AMBIGUOUS')
    return matches[0]
  }
  const root = exact('/')
  if (!root.options.includes('ro')) refuse('ROOT_FILESYSTEM_WRITABLE')
  const admission = exact(admissionRoot)
  if (!admission.options.includes('ro')) refuse('MAIN_ADMISSION_NOT_READONLY')
  const writable = [exact(home), exact(runBase), exact('/tmp')]
  for (const mount of writable) {
    if (
      mount.fsType !== 'tmpfs' ||
      mount.root !== '/' ||
      mount.source !== 'tmpfs' ||
      !mount.options.includes('rw') ||
      !mount.options.includes('nosuid') ||
      !mount.options.includes('nodev')
    )
      refuse('FRESH_PRIVATE_TMPFS_REQUIRED')
  }
  const allowed = [
    '/',
    home,
    runBase,
    admissionRoot,
    '/tmp',
    '/proc',
    '/sys',
    '/dev',
    '/etc/hosts',
    '/etc/hostname',
    '/etc/resolv.conf',
    '/dev/pts',
    '/dev/shm',
    '/dev/mqueue',
    '/sys/fs/cgroup',
    ...[
      'bus',
      'fs',
      'irq',
      'sys',
      'sysrq-trigger',
      'acpi',
      'interrupts',
      'kcore',
      'keys',
      'latency_stats',
      'timer_list',
      'timer_stats',
      'scsi',
    ].map(name => `/proc/${name}`),
  ]
  for (const mount of mounts) {
    if (!allowed.includes(mount.point)) refuse('UNREVIEWED_MOUNT')
    if (personalStatePath(mount.root) || personalStatePath(mount.source))
      refuse('PERSONAL_STATE_MOUNT')
    // Nested mounts can hide an inherited home, bus or authentication store.
    if ([home, runBase, '/tmp', admissionRoot].some(prefix => inside(prefix, mount.point)))
      refuse('PRIVATE_MOUNT_SHADOWED')
  }
  return {
    homeMountId: writable[0].id,
    runMountId: writable[1].id,
    tmpMountId: writable[2].id,
    admissionMountId: admission.id,
  }
}

export function verifyAccount(passwd, uid, gid, home, username) {
  const accounts = passwd
    .split('\n')
    .map(line => line.split(':'))
    .filter(fields => fields.length === 7 && Number(fields[2]) === uid)
  if (
    accounts.length !== 1 ||
    !integer(uid) ||
    !integer(gid) ||
    Number(accounts[0][3]) !== gid ||
    accounts[0][0] !== username ||
    accounts[0][5] !== home
  )
    refuse('PASSWD_ACCOUNT_MISMATCH')
}

export function observeLinuxRunner() {
  if (process.platform !== 'linux' || !integer(process.getuid?.()) || !integer(process.getgid?.()))
    refuse('NONROOT_LINUX_REQUIRED')
  if (Number(process.versions.node.split('.')[0]) !== 24) refuse('NODE24_REQUIRED')
  const user = os.userInfo(),
    home = fs.realpathSync(user.homedir)
  verifyAccount(
    fs.readFileSync('/etc/passwd', 'utf8'),
    process.getuid(),
    process.getgid(),
    home,
    user.username
  )
  const rawMountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  const status = fs.readFileSync('/proc/self/status', 'utf8')
  const statusField = pattern => {
    const match = status.match(pattern)
    return match ? match[1] : null
  }
  const capEff = statusField(/^CapEff:\s+([0-9a-fA-F]+)$/m)
  const seccomp = statusField(/^Seccomp:\s+(\d+)$/m)
  const noNewPrivs = statusField(/^NoNewPrivs:\s+(\d+)$/m)
  if (!capEff || !/^0+$/.test(capEff)) refuse('RUNNER_CAPABILITIES_PRESENT')
  if (seccomp !== '2') refuse('RUNNER_SECCOMP_FILTER_REQUIRED')
  if (noNewPrivs === null) refuse('RUNNER_STATUS_INCOMPLETE')
  return {
    observation: {
      platform: process.platform,
      uid: process.getuid(),
      gid: process.getgid(),
      home,
      mountNamespace: fs.readlinkSync('/proc/self/ns/mnt'),
      pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
      userNamespace: fs.readlinkSync('/proc/self/ns/user'),
      mountInfoSha256: digest(rawMountInfo),
      capabilityStatus: {
        capEff,
        seccompMode: Number(seccomp),
        noNewPrivs: Number(noNewPrivs),
      },
    },
    networkNamespace: fs.readlinkSync('/proc/self/ns/net'),
    ipcNamespace: fs.readlinkSync('/proc/self/ns/ipc'),
    mounts: parseMountInfo(rawMountInfo),
  }
}

export function verifyRunnerEnvironment(env, observation) {
  if (
    env.HOME !== observation.home ||
    env.SSH_AUTH_SOCK ||
    env.NODE_OPTIONS ||
    env.ELECTRON_DISABLE_SANDBOX ||
    env.ELECTRON_RUN_AS_NODE
  )
    refuse('INHERITED_STATE_OR_SANDBOX_OVERRIDE')
  for (const name of [
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'TMPDIR',
    'XAUTHORITY',
  ]) {
    if (
      env[name] &&
      !inside(observation.home, env[name]) &&
      !inside('/run/evenfire-e2e', env[name])
    )
      refuse('PRIVATE_RUNTIME_PATH_ESCAPED')
  }
}

export function observeProcess(pid, executable, observation) {
  if (!integer(pid)) refuse('PRIVATE_PROCESS_PID')
  const proc = `/proc/${pid}`
  const stat = fs.readFileSync(`${proc}/stat`, 'utf8')
  const close = stat.lastIndexOf(') ')
  const fields = stat.slice(close + 2).split(' ')
  if (close < 0 || !/^\d+$/.test(fields[19]) || ['Z', 'X', 'x'].includes(fields[0]))
    refuse('PRIVATE_PROCESS_NOT_LIVE')
  const uidFields = fs
    .readFileSync(`${proc}/status`, 'utf8')
    .match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m)
  if (!uidFields || uidFields.slice(1).some(value => Number(value) !== observation.uid))
    refuse('PRIVATE_PROCESS_UID')
  const executablePath = fs.readlinkSync(`${proc}/exe`)
  if (
    path.basename(executablePath) !== executable ||
    !['/usr/bin/', '/usr/sbin/', '/usr/libexec/', '/usr/lib/', '/bin/', '/sbin/'].some(prefix =>
      executablePath.startsWith(prefix)
    )
  )
    refuse('PRIVATE_PROCESS_EXECUTABLE')
  const namespaces = nsNames.map(name => fs.readlinkSync(`${proc}/ns/${name}`))
  nsFields.forEach((field, index) => {
    if (namespaces[index] !== observation[field]) refuse('PRIVATE_PROCESS_NAMESPACE')
  })
  return {
    pid,
    uid: observation.uid,
    startTime: fields[19],
    executable,
    executablePath,
    argvSha256: digest(fs.readFileSync(`${proc}/cmdline`)),
    mountNamespace: namespaces[0],
    pidNamespace: namespaces[1],
    userNamespace: namespaces[2],
  }
}

export function unixSocketInode(table, socketPath) {
  const rows = table
    .trim()
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.slice(7).join(' ') === socketPath)
  if (rows.length !== 1 || !/^\d+$/.test(rows[0][6])) refuse('PRIVATE_SOCKET_INODE')
  return rows[0][6]
}
export function verifySocketBinding(inode, links) {
  if (links.filter(value => value === `socket:[${inode}]`).length !== 1)
    refuse('PRIVATE_SOCKET_PROCESS_BINDING')
}
export function privateBusPath(address) {
  const match =
    typeof address === 'string' && address.match(/^unix:path=(\/[^,;]+)(?:,guid=[a-f0-9]{32})?$/)
  if (!match) refuse('PRIVATE_BUS_ADDRESS')
  return match[1]
}
function observeSocketProcess(expected, executable, observation) {
  const processObservation = observeProcess(expected.pid, executable, observation)
  const socket = fs.lstatSync(expected.socketPath)
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== observation.uid ||
    fs.realpathSync(path.dirname(expected.socketPath)) !== path.dirname(expected.socketPath)
  )
    refuse('PRIVATE_SOCKET_OWNERSHIP')
  const inode = unixSocketInode(fs.readFileSync('/proc/net/unix', 'utf8'), expected.socketPath)
  const fds = fs.readdirSync(`/proc/${expected.pid}/fd`)
  if (fds.length > 4096) refuse('PRIVATE_PROCESS_FD_BOUND')
  const links = fds.map(fd => {
    try {
      return fs.readlinkSync(`/proc/${expected.pid}/fd/${fd}`)
    } catch (err) {
      if (err.code === 'ENOENT') return ''
      throw err
    }
  })
  verifySocketBinding(inode, links)
  return {
    ...processObservation,
    socketPath: expected.socketPath,
    socketInode: inode,
  }
}

export function verifyPrivateIsolation(expected, actual, observation, env, runRoot) {
  if (!expected || !actual || !isDeepStrictEqual(expected, actual))
    refuse('PRIVATE_ISOLATION_CHANGED')
  const bus = actual.sessionBus,
    display = actual.display,
    keyring = actual.keyring
  if (
    !bus ||
    !display ||
    !keyring ||
    !inside(observation.home, bus.socketPath) ||
    privateBusPath(bus.address) !== bus.socketPath ||
    env.DBUS_SESSION_BUS_ADDRESS !== bus.address ||
    !/^:\d+$/.test(display.value) ||
    env.DISPLAY !== display.value ||
    env.XAUTHORITY !== display.xauthorityPath ||
    (!inside(observation.home, display.xauthorityPath) && !inside(runRoot, display.xauthorityPath))
  )
    refuse('PRIVATE_BUS_OR_DISPLAY_BINDING')
  for (const [record, executable] of [
    [bus, 'dbus-daemon'],
    [display, 'Xvfb'],
    [keyring, 'gnome-keyring-daemon'],
  ]) {
    if (
      !integer(record.pid) ||
      record.uid !== observation.uid ||
      record.executable !== executable ||
      path.basename(record.executablePath ?? '') !== executable ||
      !['/usr/bin/', '/usr/sbin/', '/usr/libexec/', '/usr/lib/', '/bin/', '/sbin/'].some(prefix =>
        record.executablePath?.startsWith(prefix)
      ) ||
      !/^\d+$/.test(record.startTime) ||
      !/^[a-f0-9]{64}$/.test(record.argvSha256)
    )
      refuse('PRIVATE_PROCESS_OBSERVATION')
    nsFields.forEach(field => {
      if (record[field] !== observation[field]) refuse('PRIVATE_PROCESS_NAMESPACE')
    })
  }
  if (!/^\d+$/.test(bus.socketInode) || !/^\d+$/.test(display.socketInode))
    refuse('PRIVATE_SOCKET_OBSERVATION')
}

export function inspectPrivateIsolation(expected, observation, env, runRoot, mountIds) {
  if (!expected?.sessionBus || !expected?.display || !expected?.keyring)
    refuse('PRIVATE_AUTH_OBSERVATION_REQUIRED')
  if (
    !inside(observation.home, expected.sessionBus.socketPath) ||
    privateBusPath(expected.sessionBus.address) !== expected.sessionBus.socketPath
  )
    refuse('PRIVATE_BUS_PATH')
  if (expected.display.socketPath !== `/tmp/.X11-unix/X${expected.display.value?.slice(1)}`)
    refuse('PRIVATE_DISPLAY_PATH')
  if (
    !inside(observation.home, expected.display.xauthorityPath) &&
    !inside(runRoot, expected.display.xauthorityPath)
  )
    refuse('PRIVATE_XAUTHORITY_PATH')
  const authority = fs.lstatSync(expected.display.xauthorityPath)
  if (
    !authority.isFile() ||
    authority.isSymbolicLink() ||
    authority.nlink !== 1 ||
    authority.uid !== observation.uid ||
    (authority.mode & 0o077) !== 0
  )
    refuse('PRIVATE_XAUTHORITY_OWNERSHIP')
  const actual = {
    ...mountIds,
    sessionBus: {
      ...observeSocketProcess(expected.sessionBus, 'dbus-daemon', observation),
      address: expected.sessionBus.address,
    },
    display: {
      ...observeSocketProcess(expected.display, 'Xvfb', observation),
      value: expected.display.value,
      xauthorityPath: expected.display.xauthorityPath,
    },
    keyring: observeProcess(expected.keyring.pid, 'gnome-keyring-daemon', observation),
  }
  verifyPrivateIsolation(actual, actual, observation, env, runRoot)
  return actual
}

export function observePrivateIsolation(expected, observation, env, runRoot, mountIds) {
  const actual = inspectPrivateIsolation(expected, observation, env, runRoot, mountIds)
  verifyPrivateIsolation(expected, actual, observation, env, runRoot)
  return actual
}

// GNOME's encrypted binary format has this 16-byte magic plus four supported
// version/cipher/hash bytes. Only these public bytes are read, never contents.
// https://github.com/GNOME/gnome-keyring/blob/main/pkcs11/secret-store/gkm-secret-binary.c
const encryptedKeyringHeader = Buffer.from('GnomeKeyring\n\r\0\n\0\0\0\0', 'utf8')
export function isEncryptedKeyringHeader(bytes) {
  return bytes.length === 20 && bytes.equals(encryptedKeyringHeader)
}
export function verifyEncryptedKeyringFiles(env, uid) {
  if (!env.XDG_DATA_HOME || !inside(env.HOME, env.XDG_DATA_HOME))
    refuse('PRIVATE_KEYRING_DATA_PATH')
  const directory = path.join(env.XDG_DATA_HOME, 'keyrings')
  if (fs.realpathSync(directory) !== directory) refuse('PRIVATE_KEYRING_DIRECTORY')
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.keyring'))
  if (!files.length || files.length > 16) refuse('PRIVATE_ENCRYPTED_KEYRING_REQUIRED')
  for (const name of files) {
    const fd = fs.openSync(
      path.join(directory, name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    )
    try {
      const stat = fs.fstatSync(fd),
        header = Buffer.alloc(20)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== uid ||
        (stat.mode & 0o077) !== 0 ||
        fs.readSync(fd, header, 0, 20, 0) !== 20 ||
        !isEncryptedKeyringHeader(header)
      )
        refuse('PLAINTEXT_OR_UNOWNED_KEYRING')
    } finally {
      fs.closeSync(fd)
    }
  }
}
export function verifyNativePrivateKeychain(repoRoot, env) {
  verifyEncryptedKeyringFiles(env, process.getuid())
  // keytar has no per-call AbortSignal. Keep the random roundtrip in a bounded
  // disposable native process so a stalled service cannot hang admission.
  const code = `import {createRequire} from 'node:module'; import {randomBytes,randomUUID} from 'node:crypto';
    const keytar=createRequire(process.argv[1])('keytar'); const account=randomUUID(); const value=randomBytes(32).toString('hex');
    try { await keytar.setPassword('evenfire-subscription-image-isolation-probe',account,value);
      if (await keytar.getPassword('evenfire-subscription-image-isolation-probe',account)!==value) process.exitCode=1;
    } finally { await keytar.deletePassword('evenfire-subscription-image-isolation-probe',account); }`
  /** @type {NodeJS.ProcessEnv} */
  const nativeEnv = {}
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'TMPDIR',
  ])
    if (env[name]) nativeEnv[name] = env[name]
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', code, path.join(repoRoot, 'desktop-app/package.json')],
      {
        env: nativeEnv,
        timeout: 10_000,
        killSignal: 'SIGKILL',
        stdio: 'ignore',
      }
    )
  } catch {
    refuse('PRIVATE_NATIVE_KEYCHAIN_FAILED')
  }
  verifyEncryptedKeyringFiles(env, process.getuid())
}

export function refusePlaintextSessionFiles(directories) {
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue
    if (
      fs
        .readdirSync(directory)
        .some(name => /^session-token(?:-.*)?\.json(?:\..*\.tmp)?$/.test(name))
    )
      refuse('PLAINTEXT_DESKTOP_SESSION_FORBIDDEN')
  }
}

export function expectedJourneyNames(mode) {
  const names = [
    'png pixels reach the selected owned Host and model',
    'jpeg pixels reach the selected owned Host and model',
    'mixed PNG/JPEG preserve attachment and wire order',
    'near 16 MiB composer image carries real pixels',
    'twenty ordered images complete without a dropped or repeated code',
    'over-budget refusal leaves no task or dispatch and permits a subsequent text turn',
    'unsupported model blocks image send, then visible removal and primary selection recover',
  ]
  const cases = ['grok-subscription', 'codex-subscription'].flatMap(provider =>
    names.map(name => `${provider} ${name}`)
  )
  if (mode === 'real') cases.push('G8 Grok reads pixels in a 9000 px PNG through the owned Host')
  return cases
}

export const CERTIFIED_SUITE_ID = 'subscription-image-input'
const SUITE_PROVIDERS = ['grok-subscription', 'codex-subscription']
// Opt-in suite registry. Additional suites stay separate from the certified
// 14/15 inventory: each suite owns its own config/spec, project name and exact
// case identities, and a runner receipt never merges two suites.
export const SUITE_CONTRACTS = Object.freeze({
  [CERTIFIED_SUITE_ID]: {
    suiteId: CERTIFIED_SUITE_ID,
    project: 'subscription-image-input',
    configFile: 'test/e2e-playwright/playwright.subscription-image.config.ts',
    specFile: 'desktop-app/test/e2e-playwright/subscription-image-input.spec.ts',
    modes: ['fixture', 'real'],
    buildArgs: {},
    expectedNames: mode => expectedJourneyNames(mode),
  },
  'tool-screenshot': {
    suiteId: 'tool-screenshot',
    project: 'tool-screenshot',
    configFile: 'test/e2e-playwright/playwright.subscription-tool-screenshot.config.ts',
    specFile: 'desktop-app/test/e2e-playwright/subscription-tool-screenshot.spec.ts',
    modes: ['fixture', 'real'],
    buildArgs: {},
    optInEnv: 'E2E_SUBSCRIPTION_TOOL_SCREENSHOT',
    fixtureReceiptEnv: 'E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT',
    expectedNames: () => [
      'grok-subscription real desktop screenshot tool yields pixel evidence after visible approval',
      'codex-subscription real desktop screenshot tool yields pixel evidence after visible approval',
    ],
  },
  'gfs-image': {
    suiteId: 'gfs-image',
    project: 'gfs-image',
    configFile: 'test/e2e-playwright/playwright.subscription-gfs-image.config.ts',
    specFile: 'desktop-app/test/e2e-playwright/subscription-gfs-image.spec.ts',
    modes: ['fixture', 'real'],
    buildArgs: { VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM: 'true' },
    optInEnv: 'E2E_SUBSCRIPTION_GFS_IMAGE',
    fixtureReceiptEnv: 'E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT',
    expectedNames: () =>
      SUITE_PROVIDERS.map(
        provider =>
          `${provider} Files preview and attached GFS image preserve source and ordered pixels`
      ),
  },
  'admission-recovery': {
    suiteId: 'admission-recovery',
    project: 'admission-recovery',
    configFile: 'test/e2e-playwright/playwright.subscription-admission-recovery.config.ts',
    specFile: 'desktop-app/test/e2e-playwright/subscription-admission-recovery.spec.ts',
    modes: ['fixture'],
    buildArgs: {},
    optInEnv: 'E2E_SUBSCRIPTION_ADMISSION_RECOVERY',
    fixtureReceiptEnv: 'E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT',
    expectedNames: () =>
      SUITE_PROVIDERS.map(
        provider =>
          `${provider} local admission refusal settles visibly and a subsequent text turn stays on primary`
      ),
  },
})
export function resolveSuite(suiteId = CERTIFIED_SUITE_ID) {
  const suite = SUITE_CONTRACTS[suiteId]
  if (!suite) refuse('SUITE_UNKNOWN')
  return suite
}
export function suiteBuildArgs(suite) {
  const args = suite?.buildArgs ?? {}
  for (const [name, value] of Object.entries(args)) {
    if (!/^VITE_[A-Z0-9_]+$/.test(name) || !['true', 'false'].includes(value))
      refuse('SUITE_BUILD_ARG_INVALID')
  }
  return args
}
export function suiteExpectedNames(suite, mode) {
  if (!suite.modes.includes(mode)) refuse('SUITE_MODE_NOT_ADMITTED')
  const names = suite.expectedNames(mode)
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length)
    refuse('SUITE_EXPECTED_NAMES')
  return names
}
export function verifySuiteReport(report, mode, suite, expectedFile) {
  const expected = suiteExpectedNames(suite, mode)
  if (
    !report?.config?.rootDir ||
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors) ||
    report.errors.length ||
    report.stats?.expected !== expected.length ||
    report.stats.unexpected !== 0 ||
    report.stats.flaky !== 0 ||
    report.stats.skipped !== 0
  )
    refuse('JOURNEY_REPORT_INCOMPLETE')
  const actual = []
  const visit = (reportSuite, parents) => {
    const names =
      reportSuite.title === path.basename(expectedFile) ? parents : [...parents, reportSuite.title]
    for (const spec of reportSuite.specs ?? []) {
      if (
        path.resolve(report.config.rootDir, spec.file) !== expectedFile ||
        spec.ok !== true ||
        spec.tests?.length !== 1
      )
        refuse('JOURNEY_REPORT_PHYSICAL_FILE')
      const result = spec.tests[0]
      if (
        result.projectName !== suite.project ||
        result.expectedStatus !== 'passed' ||
        result.status !== 'expected' ||
        result.results?.length !== 1 ||
        result.results[0].status !== 'passed'
      )
        refuse('JOURNEY_REPORT_NONGREEN')
      actual.push([...names, spec.title].filter(Boolean).join(' '))
    }
    for (const child of reportSuite.suites ?? []) visit(child, names)
  }
  report.suites.forEach(suite => visit(suite, []))
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some(name => !actual.includes(name))
  )
    refuse('JOURNEY_REPORT_CASE_IDENTITY')
  return { executed: actual.length, passed: actual.length, fullNames: actual }
}
export function verifyJourneyReport(report, mode, expectedFile) {
  return verifySuiteReport(report, mode, resolveSuite(), expectedFile)
}

const closedVendorObject = (value, keys) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key))
const vendorHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const vendorId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const vendorHashes = value => Array.isArray(value) && value.length <= 20 && value.every(vendorHash)
const vendorList = (value, limit, check) => Array.isArray(value) && value.length <= limit && value.every(check)
const vendorDrive = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const vendorResourceId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const vendorResource = value =>
  closedVendorObject(value, ['kind', 'drive', 'resourceId', 'version', 'gfsUri']) &&
  value.kind === 'gfs' && vendorDrive(value.drive) && vendorResourceId(value.resourceId) &&
  integer(value.version) && value.gfsUri === `gfs://${value.drive}/${value.resourceId}`

export function validateVendorLedger(ledger, runId, binding, previous = []) {
  if (!closedVendorObject(ledger, ['kind', 'runId', 'attempts']) ||
      ledger.kind !== 'evenfire-subscription-image-vendor-v1' || ledger.runId !== runId ||
      !Array.isArray(ledger.attempts) || ledger.attempts.length > 256 ||
      !Array.isArray(previous) || ledger.attempts.length < previous.length)
    refuse('VENDOR_EVIDENCE_SOURCE_OR_SEQUENCE')
  for (const [index, row] of ledger.attempts.entries()) {
    if (!closedVendorObject(row, [
      'sequence', 'provider', 'model', 'receiptId', 'imageSha256', 'mimeTypes',
      'requestSha256', 'responseKind', 'outputSha256', 'journey', 'stage',
      'toolCalls', 'toolOutputs', 'referencedFiles', 'receivedImageDigests',
      'receivedImageOrder', 'decodedPixels',
    ]) || row.sequence !== index + 1 || row.provider !== binding.provider ||
      ![binding.modelId, binding.unsupportedModelId].includes(row.model) ||
      typeof row.receiptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.receiptId) ||
      !vendorHashes(row.imageSha256) || !Array.isArray(row.mimeTypes) ||
      row.mimeTypes.length !== row.imageSha256.length ||
      row.mimeTypes.some(value => !['image/png', 'image/jpeg'].includes(value)) ||
      !vendorHash(row.requestSha256) || !['pixels', 'text', 'rejected', 'tool_calls'].includes(row.responseKind) ||
      (row.outputSha256 !== undefined && !vendorHash(row.outputSha256)))
      refuse('VENDOR_EVIDENCE_SHAPE')
    if ((row.journey !== undefined && !['tool-screenshot', 'gfs-image'].includes(row.journey)) ||
        (row.stage !== undefined && (row.journey === undefined ||
          !(row.journey === 'tool-screenshot' ? ['prepare', 'capture', 'pixels'] : ['read', 'pixels']).includes(row.stage))) ||
        (row.responseKind === 'tool_calls' && (!row.journey || !row.stage)))
      refuse('VENDOR_EVIDENCE_TOOL_STAGE')
    if ((row.receivedImageDigests !== undefined || row.receivedImageOrder !== undefined) &&
        (!vendorHashes(row.receivedImageDigests) || !vendorHashes(row.receivedImageOrder) ||
          !isDeepStrictEqual(row.receivedImageDigests, row.imageSha256) ||
          !isDeepStrictEqual(row.receivedImageOrder, row.imageSha256)))
      refuse('VENDOR_EVIDENCE_IMAGE_ORDER')
    if (row.decodedPixels !== undefined &&
        (!vendorList(row.decodedPixels, 20, value =>
          closedVendorObject(value, ['width', 'height']) && integer(value.width) && integer(value.height) &&
          value.width <= 9000 && value.height <= 9000) ||
          row.decodedPixels.length > row.imageSha256.length ||
          (row.responseKind !== 'rejected' && row.decodedPixels.length !== row.imageSha256.length)))
      refuse('VENDOR_EVIDENCE_PIXEL_METADATA')
    if (row.toolCalls !== undefined && !vendorList(row.toolCalls, 32, value =>
        closedVendorObject(value, ['id', 'name', 'argumentsSha256']) && vendorId(value.id) &&
        ['shell_exec', 'desktop_screenshot', 'clerum__gfs_read'].includes(value.name) && vendorHash(value.argumentsSha256)))
      refuse('VENDOR_EVIDENCE_TOOL_CALL')
    if (row.toolOutputs !== undefined && !vendorList(row.toolOutputs, 32, value =>
        closedVendorObject(value, ['id', 'outputSha256', 'resource']) && vendorId(value.id) &&
        vendorHash(value.outputSha256) && (value.resource === undefined || vendorResource(value.resource))))
      refuse('VENDOR_EVIDENCE_TOOL_OUTPUT')
    if (row.referencedFiles !== undefined && !vendorList(row.referencedFiles, 2, value =>
        closedVendorObject(value, ['referenceId', 'drive', 'resourceId', 'version', 'availability', 'byteLength']) &&
        vendorDrive(value.drive) && vendorResourceId(value.resourceId) && integer(value.version) &&
        value.referenceId === `gfs:${value.drive}:${value.resourceId}@v${value.version}` &&
        value.availability === 'available' && integer(value.byteLength) && value.byteLength <= 20 * 1024 * 1024))
      refuse('VENDOR_EVIDENCE_FILE_REFERENCE')
    if (index < previous.length && !isDeepStrictEqual(row, previous[index]))
      refuse('VENDOR_EVIDENCE_HISTORY_CHANGED')
  }
  return ledger.attempts
}

export function admitVendorFrame(frame, runId, binding, source, previous = []) {
  if (!closedVendorObject(frame, ['kind', 'runId', 'provider', 'source', 'ledger']) ||
      frame.kind !== 'evenfire-subscription-image-vendor-frame-v1' || frame.runId !== runId ||
      frame.provider !== binding.provider || !isDeepStrictEqual(frame.source, source))
    refuse('VENDOR_EVIDENCE_SOURCE_OR_SEQUENCE')
  validateVendorLedger(frame.ledger, runId, binding, previous)
  return frame.ledger
}

export function pinnedBaseImage(repoRoot) {
  const raw = fs.readFileSync(path.join(repoRoot, PINNED_BASE_IMAGE_FILE), 'utf8')
  if (!raw.length || raw.length > 16 * 1024) refuse('PINNED_BASE_IMAGE_BOUND')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    refuse('PINNED_BASE_IMAGE_INVALID')
  }
  if (
    parsed.kind !== 'evenfire-subscription-image-base-image-v1' ||
    typeof parsed.reference !== 'string' ||
    !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(parsed.reference) ||
    parsed.nodeMajor !== 24 ||
    !Array.isArray(parsed.requiredCommands) ||
    parsed.requiredCommands.some(name => typeof name !== 'string' || !name)
  )
    refuse('PINNED_BASE_IMAGE_INVALID')
  return parsed
}

export function verifyRuntimeReceipts(admission, receipts, phase = 'admit') {
  const runtime = admission.runtime
  const inspectRecord = receipts?.inspect,
    stackRecord = receipts?.stack,
    portForwardsRecord = receipts?.portForwards
  if (
    !inspectRecord?.value?.container ||
    !Array.isArray(inspectRecord.value.securityOptions) ||
    !stackRecord?.value ||
    !portForwardsRecord?.value
  )
    refuse('MAIN_RECEIPTS_REQUIRED')
  if (
    !/^[a-f0-9]{64}$/.test(inspectRecord.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(stackRecord.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(portForwardsRecord.sha256 ?? '')
  )
    refuse('MAIN_RECEIPT_HASHES_REQUIRED')
  const inspect = inspectRecord.value,
    stack = stackRecord.value,
    portForwards = portForwardsRecord.value
  const container = inspect.container,
    hostConfig = container.HostConfig,
    securityOptions = inspect.securityOptions
  if (
    container.Id !== runtime.containerId ||
    container.Image !== admission.imageId ||
    Date.parse(container.Created) !== Date.parse(runtime.createdAt) ||
    container.Config?.User !== runtime.user ||
    container.State?.Running !== true ||
    !hostConfig ||
    hostConfig.ReadonlyRootfs !== true ||
    hostConfig.Privileged !== false ||
    (hostConfig.PidMode || 'private') !== 'private' ||
    (hostConfig.IpcMode || 'private') !== 'private' ||
    typeof hostConfig.NetworkMode !== 'string' ||
    !hostConfig.NetworkMode ||
    hostConfig.NetworkMode === 'host' ||
    hostConfig.NetworkMode.startsWith('container:') ||
    !isDeepStrictEqual(hostConfig.CapDrop, ['ALL']) ||
    !Array.isArray(hostConfig.SecurityOpt) ||
    hostConfig.SecurityOpt.some(value => typeof value !== 'string') ||
    hostConfig.SecurityOpt.some(value => /seccomp=unconfined|no-new-privileges/i.test(value)) ||
    securityOptions.some(value => typeof value !== 'string' || /unconfined/i.test(value)) ||
    !securityOptions.some(value => /seccomp/i.test(value))
  )
    refuse('DOCKER_INSPECT_RUNTIME_MISMATCH')
  const home = admission.observation.home
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : []
  const admissionMounts = mounts.filter(mount => mount.Destination === RUNNER_ADMISSION_ROOT)
  const tmpfsOk = [home, RUNNER_RUN_BASE, '/tmp'].every(destination => {
    const matches = mounts.filter(mount => mount.Destination === destination)
    return matches.length === 1 && matches[0].Type === 'tmpfs' && matches[0].RW === true
  })
  if (
    mounts.length !== 4 ||
    admissionMounts.length !== 1 ||
    admissionMounts[0].Type !== 'volume' ||
    admissionMounts[0].Name !== admissionVolumeName(admission.runId) ||
    admissionMounts[0].Name !== admission.volume?.name ||
    admissionMounts[0].RW !== false ||
    typeof admissionMounts[0].Source !== 'string' ||
    !admissionMounts[0].Source ||
    mounts.some(mount => mount.Type === 'bind') ||
    mounts.some(mount => personalStatePath(mount.Source) || personalStatePath(mount.Destination)) ||
    !tmpfsOk
  )
    refuse('DOCKER_INSPECT_MOUNTS_MISMATCH')
  const allowedEnv = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'NODE_VERSION',
    'YARN_VERSION',
    'SUBSCRIPTION_IMAGE_RUN_ID',
  ])
  const envEntries = Array.isArray(container.Config?.Env) ? container.Config.Env : []
  for (const entry of envEntries) {
    const split = typeof entry === 'string' ? entry.indexOf('=') : -1
    if (split <= 0) refuse('CONTAINER_ENV_NOT_REVIEWED')
    const name = entry.slice(0, split)
    if (!allowedEnv.has(name) || /(SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(name))
      refuse('CONTAINER_ENV_NOT_REVIEWED')
  }
  if (!envEntries.includes(`SUBSCRIPTION_IMAGE_RUN_ID=${admission.runId}`))
    refuse('CONTAINER_ENV_RUN_BINDING')
  if (
    stack.kind !== 'evenfire-subscription-image-stack-marker-v1' ||
    stack.context !== admission.context ||
    stack.configMapName !== 'clerum-pre-gate-sync-state' ||
    typeof stack.resourceVersion !== 'string' ||
    !stack.resourceVersion ||
    !Number.isFinite(Date.parse(stack.fetchedAt)) ||
    !stack.data ||
    typeof stack.data !== 'object' ||
    stack.data.gitHead !== admission.gitHead ||
    stack.data.worktreeId !== admission.stack.worktreeId ||
    stack.data.clusterFingerprint !== admission.stack.clusterFingerprint ||
    stack.data.imagesGeneratedAt !== admission.stack.imagesGeneratedAt ||
    typeof stack.portsEnvRaw !== 'string' ||
    !/^[a-f0-9]{64}$/.test(stack.portsEnvSha256 ?? '') ||
    digest(stack.portsEnvRaw) !== stack.portsEnvSha256 ||
    stack.portsEnvSha256 !== admission.stack.portsReceiptSha256
  )
    refuse('STACK_MARKER_MISMATCH')
  const ports = parsePortsEnv(stack.portsEnvRaw)
  if (
    portForwards.kind !== 'evenfire-subscription-image-port-forwards-v1' ||
    !Number.isFinite(Date.parse(portForwards.verifiedAt)) ||
    !portForwards.entries ||
    typeof portForwards.entries !== 'object'
  )
    refuse('PORT_FORWARD_RECEIPT_REQUIRED')
  for (const [kind, expected] of Object.entries(PORT_FORWARD_SERVICES)) {
    const entry = portForwards.entries[kind],
      target = admission.transports?.[kind]
    if (!entry || typeof entry.raw !== 'string' || !/^[a-f0-9]{64}$/.test(entry.recordSha256 ?? ''))
      refuse('PORT_FORWARD_RECEIPT_REQUIRED')
    const record = parsePortForwardRecord(entry.raw)
    let origin
    try {
      origin = new URL(target?.origin)
    } catch {
      refuse('OWNED_TRANSPORT_REQUIRED')
    }
    if (
      digest(entry.raw) !== entry.recordSha256 ||
      entry.recordSha256 !== target.forwardBindingSha256 ||
      record.profile !== admission.profile ||
      record.context !== admission.context ||
      record.namespace !== expected.namespace ||
      record.service !== expected.service ||
      record.remotePort !== expected.remotePort ||
      record.localPort !== Number(origin.port) ||
      record.address !== '127.0.0.1' ||
      ports[expected.key] !== record.localPort
    )
      refuse('PORT_FORWARD_RECEIPT_MISMATCH')
  }
  const generatedAt = Date.parse(admission.receipts.generatedAt)
  if (
    Date.now() - generatedAt < 0 ||
    Date.now() - generatedAt > (phase === 'admit' ? 600_000 : 4_200_000) ||
    Math.abs(Date.parse(portForwards.verifiedAt) - generatedAt) > 300_000
  )
    refuse('MAIN_RECEIPT_STALE')
}

export function verifyMainAdmission(
  admission,
  physical,
  source,
  repoRoot,
  env,
  phase = 'admit',
  receipts
) {
  const artifacts = admission.thirdPartyArtifacts
  if (
    !Array.isArray(artifacts) ||
    artifacts.length !== 1 ||
    artifacts[0].name !== 'sfw-free' ||
    artifacts[0].version !== SFW_FREE_VERSION ||
    !/^[a-f0-9]{64}$/.test(artifacts[0].sha256 ?? '')
  )
    refuse('THIRD_PARTY_ARTIFACT_REQUIRED')
  if (
    admission.kind !== MAIN_ADMISSION_KIND ||
    !/^subscription-image-[a-f0-9]{12}$/.test(admission.runId) ||
    typeof admission.suiteId !== 'string' ||
    !SUITE_CONTRACTS[admission.suiteId] ||
    admission.gitHead !== source.gitHead ||
    admission.gitTree !== source.gitTree ||
    admission.inputManifestSha256 !== source.inputManifestSha256 ||
    admission.sourceManifestSha256 !== source.manifestSha256 ||
    admission.repoRoot !== repoRoot ||
    !/^sha256:[a-f0-9]{64}$/.test(admission.imageId) ||
    admission.baseImage !== pinnedBaseImage(repoRoot).reference ||
    !isDeepStrictEqual(
      admission.uiFeatures ?? {},
      suiteBuildArgs(resolveSuite(admission.suiteId))
    ) ||
    !isDeepStrictEqual(admission.observation, physical.observation) ||
    admission.networkNamespace !== physical.networkNamespace ||
    admission.ipcNamespace !== physical.ipcNamespace
  )
    refuse('MAIN_ADMISSION_IDENTITY')
  if (
    admission.profile !== admission.context ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(admission.profile) ||
    admission.profile === 'clerum-test' ||
    /(^|-)(prod|production)(-|$)/i.test(admission.profile)
  )
    refuse('OWNED_DEVELOPMENT_PROFILE_REQUIRED')
  const stack = admission.stack
  if (
    !stack ||
    stack.gitHead !== source.gitHead ||
    !/^[a-f0-9]{40}$/.test(stack.worktreeId) ||
    !/^[a-f0-9]{64}$/.test(stack.clusterFingerprint) ||
    !stack.imagesGeneratedAt ||
    !/^[a-f0-9]{64}$/.test(stack.portsReceiptSha256)
  )
    refuse('EXACT_STACK_MARKER_REQUIRED')
  const runtime = admission.runtime
  if (
    !runtime ||
    runtime.readOnlyRootfs !== true ||
    runtime.privileged !== false ||
    runtime.pidMode !== 'private' ||
    runtime.ipcMode !== 'private' ||
    runtime.networkMode === 'host' ||
    !runtime.networkMode ||
    runtime.user !== `${physical.observation.uid}:${physical.observation.gid}` ||
    !isDeepStrictEqual(runtime.capDrop, ['ALL']) ||
    runtime.seccompMode !== 'filter' ||
    !/^[a-f0-9]{64}$/.test(runtime.containerId) ||
    !Number.isFinite(Date.parse(runtime.createdAt)) ||
    Date.now() - Date.parse(runtime.createdAt) < 0 ||
    !['admit', 'verify'].includes(phase) ||
    Date.now() - Date.parse(runtime.createdAt) > (phase === 'admit' ? 600_000 : 4_200_000)
  )
    refuse('RUNTIME_ISOLATION_POLICY')
  if (
    !admission.receipts ||
    !Number.isFinite(Date.parse(admission.receipts.generatedAt)) ||
    !/^[a-f0-9]{64}$/.test(admission.receipts.dockerInspectSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(admission.receipts.stackMarkerSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(admission.receipts.portForwardsSha256 ?? '')
  )
    refuse('MAIN_RECEIPT_HASHES_REQUIRED')
  const volume = admission.volume
  if (
    !volume ||
    volume.name !== admissionVolumeName(admission.runId) ||
    volume.driver !== 'local' ||
    !Number.isFinite(Date.parse(volume.createdAt)) ||
    !/^[a-f0-9]{64}$/.test(volume.inspectSha256 ?? '')
  )
    refuse('ADMISSION_VOLUME_IDENTITY')
  if (
    receipts?.inspect?.sha256 !== admission.receipts.dockerInspectSha256 ||
    receipts?.stack?.sha256 !== admission.receipts.stackMarkerSha256 ||
    receipts?.portForwards?.sha256 !== admission.receipts.portForwardsSha256
  )
    refuse('MAIN_RECEIPT_FILE_HASH')
  if (
    !['fixture', 'real'].includes(admission.mode) ||
    !Array.isArray(admission.bindings) ||
    admission.bindings.length !== 2 ||
    new Set(admission.bindings.map(binding => binding.provider)).size !== 2 ||
    !admission.bindings.some(binding => binding.provider === 'codex-subscription') ||
    !admission.bindings.some(binding => binding.provider === 'grok-subscription')
  )
    refuse('PROVIDER_BINDINGS_REQUIRED')
  verifyRunnerEnvironment(env, physical.observation)
  const seen = new Set()
  for (const [kind, service] of [
    ['rest', 'external-rest-api'],
    ['rpc', 'rpc-proxy'],
  ]) {
    const target = admission.transports?.[kind]
    let url
    try {
      url = new URL(target?.origin)
    } catch {
      refuse('OWNED_TRANSPORT_REQUIRED')
    }
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname) ||
      !url.port ||
      !['127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname) ||
      ['3000', '8090', '8091', '8094', '8098'].includes(url.port) ||
      target.service !== service ||
      target.profile !== admission.profile ||
      target.context !== admission.context ||
      target.worktreeId !== stack.worktreeId ||
      target.gitHead !== stack.gitHead ||
      target.portsReceiptSha256 !== stack.portsReceiptSha256 ||
      !/^[a-f0-9]{64}$/.test(target.forwardBindingSha256)
    )
      refuse('OWNED_TRANSPORT_REQUIRED')
    if (seen.has(url.origin)) refuse('TRANSPORT_TARGETS_AMBIGUOUS')
    seen.add(url.origin)
  }
  verifyRuntimeReceipts(admission, receipts, phase)
}

// In-container only: prove the sealed binary really is the pinned artifact.
export function verifySealedArtifacts(admission) {
  const artifact = admission.thirdPartyArtifacts?.[0]
  if (!artifact) refuse('THIRD_PARTY_ARTIFACT_REQUIRED')
  const stat = fs.lstatSync('/usr/local/bin/sfw')
  if (!stat.isFile() || stat.isSymbolicLink()) refuse('THIRD_PARTY_ARTIFACT_CHANGED')
  verifyThirdPartyArtifact({
    bytes: fs.readFileSync('/usr/local/bin/sfw'),
    asset: {
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      arch: artifact.arch,
      machine: artifact.elfMachine,
    },
  })
}

export function verifySourceManifest(manifest, repoRoot) {
  if (
    manifest.kind !== 'evenfire-subscription-image-source-v1' ||
    !/^[a-f0-9]{40}$/.test(manifest.gitHead) ||
    !/^[a-f0-9]{40}$/.test(manifest.gitTree) ||
    !/^[a-f0-9]{64}$/.test(manifest.inputManifestSha256) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 20_000
  )
    refuse('SOURCE_MANIFEST_REQUIRED')
  const seen = new Set()
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      path.isAbsolute(file.path) ||
      file.path.split('/').includes('..') ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      /(^|\/)(\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|cookies?[^/]*|[^/]*credential[^/]*|[^/]*wallet[^/]*|[^/]*keystore[^/]*)($|\/)|\.(pem|key|log)$/i.test(
        file.path
      )
    )
      refuse('SOURCE_PATH_OR_IDENTITY')
    seen.add(file.path)
    const filename = path.resolve(repoRoot, file.path),
      stat = fs.lstatSync(filename)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(filename) !== filename ||
      stat.size !== file.bytes ||
      digest(fs.readFileSync(filename)) !== file.sha256
    )
      refuse('SOURCE_ARTIFACT_CHANGED')
  }
  for (const required of [
    'desktop-app/dist/main.js',
    'desktop-app/ui-dist/index.html',
    'desktop-app/package-lock.json',
    'mcp-host/package-lock.json',
    'desktop-app/test/e2e-playwright/subscriptionImageFixtures.ts',
    'desktop-app/test/e2e-playwright/subscriptionImageRunContract.ts',
    'desktop-app/test/e2e-playwright/subscription-image-input.spec.ts',
    'desktop-app/test/e2e-playwright/playwright.subscription-image.config.ts',
    'scripts/e2e/prepare-subscription-remaining-fixtures.mjs',
    'scripts/e2e/prepare-subscription-remaining-fixtures.gfs.mjs',
    'scripts/e2e/prepare-subscription-remaining-fixtures.runtime.mjs',
    'scripts/e2e/prepare-subscription-remaining-fixtures.prepare.mjs',
    'desktop-app/test/e2e-playwright/subscriptionRemainingJourneysContract.ts',
    'scripts/e2e/fixtures/subscription-image-decoder.mjs',
    'scripts/e2e/fixtures/subscription-image-challenge.cjs',
    'scripts/e2e/fixtures/subscription-image-session.mjs',
    'scripts/e2e/fixtures/subscription-image-runner.base-image',
  ]) {
    if (!seen.has(required)) refuse('SOURCE_REQUIRED_ARTIFACT_MISSING')
  }
}
