// E2E-only private session bootstrap. Starts one dbus session daemon, one Xvfb
// display and one gnome-keyring daemon inside the inspected runner container,
// unlocks the keyring with a per-run random unlock value held only in this
// process memory, proves the native keytar roundtrip and proves the login
// keyring file is encrypted. Nothing here launches Electron or touches the host.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  RunnerAdmissionError,
  verifyEncryptedKeyringFiles,
  verifyNativePrivateKeychain,
} from '../../tests/lib/subscription-image-runner-contract.mjs'

const refuse = code => {
  throw new RunnerAdmissionError(code)
}
export const SESSION_READY_DEADLINE_MS = 30_000
const POLL_INTERVAL_MS = 100

export function sessionPaths(home) {
  return {
    runtimeDir: path.join(home, 'runtime'),
    busSocket: path.join(home, 'runtime', 'bus'),
    xauthority: path.join(home, '.Xauthority'),
    x11SocketDir: '/tmp/.X11-unix',
    dataHome: path.join(home, '.local', 'share'),
    configHome: path.join(home, '.config'),
    cacheHome: path.join(home, '.cache'),
  }
}

async function waitFor(check, code, deadlineMs = SESSION_READY_DEADLINE_MS) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = check()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() - started > deadlineMs) refuse(code)
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function capture(child, limit = 8 * 1024) {
  const chunks = []
  let bytes = 0
  const collect = value => {
    bytes += value.length
    if (bytes <= limit) chunks.push(value)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  return () => Buffer.concat(chunks).toString('utf8')
}

function spawnOrRefuse(command, args, options, code) {
  const child = spawn(command, args, options)
  child.once('error', () => {})
  if (!Number.isSafeInteger(child.pid)) refuse(code)
  return child
}

async function waitForExit(child, deadlineMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ code: null, signal: 'timeout' }), deadlineMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('SESSION_DIRECTORY_UNSAFE')
  fs.chmodSync(directory, 0o700)
}

async function startSessionBus(paths, home) {
  const child = spawnOrRefuse(
    'dbus-daemon',
    [
      '--session',
      '--fork',
      `--address=unix:path=${paths.busSocket}`,
      '--print-address=1',
      '--print-pid=1',
    ],
    { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
    'SESSION_DBUS_UNAVAILABLE'
  )
  const output = capture(child)
  const result = await waitForExit(child, SESSION_READY_DEADLINE_MS)
  if (result.code !== 0) refuse('SESSION_DBUS_START_FAILED')
  const lines = output()
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const address = lines.find(line => /^unix:path=\//.test(line))
  const pidLine = lines.find(line => /^[1-9][0-9]*$/.test(line))
  if (!address || !pidLine) refuse('SESSION_DBUS_OUTPUT')
  const socket = await waitFor(
    () => {
      const stat = fs.lstatSync(paths.busSocket)
      return stat.isSocket() && stat.uid === process.getuid() ? paths.busSocket : null
    },
    'SESSION_DBUS_SOCKET_TIMEOUT'
  )
  return { pid: Number(pidLine), address, socketPath: socket }
}

async function startDisplay(paths, home) {
  fs.mkdirSync(paths.x11SocketDir, { recursive: true, mode: 0o1777 })
  fs.chmodSync(paths.x11SocketDir, 0o1777)
  let displayNumber = 99
  for (; displayNumber > 10; displayNumber -= 1) {
    if (!fs.existsSync(path.join(paths.x11SocketDir, `X${displayNumber}`))) break
  }
  const value = `:${displayNumber}`
  try {
    execFileSync(
      'xauth',
      ['-f', paths.xauthority, 'add', value, 'MIT-MAGIC-COOKIE-1', randomBytes(16).toString('hex')],
      { env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000, stdio: 'ignore' }
    )
  } catch {
    refuse('SESSION_XAUTH_UNAVAILABLE')
  }
  const authority = fs.lstatSync(paths.xauthority)
  if (
    !authority.isFile() ||
    authority.isSymbolicLink() ||
    authority.uid !== process.getuid() ||
    (authority.mode & 0o077) !== 0
  )
    refuse('SESSION_XAUTHORITY_MODE')
  const child = spawnOrRefuse(
    'Xvfb',
    [value, '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-auth', paths.xauthority],
    { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
    'SESSION_XVFB_UNAVAILABLE'
  )
  capture(child)
  let exited = null
  child.once('exit', (code, signal) => {
    exited = { code, signal }
  })
  const socketPath = path.join(paths.x11SocketDir, `X${displayNumber}`)
  await waitFor(
    () => {
      if (exited) refuse('SESSION_XVFB_EXITED')
      const socket = fs.lstatSync(socketPath)
      return socket.isSocket() && socket.uid === process.getuid() ? socketPath : null
    },
    'SESSION_XVFB_SOCKET_TIMEOUT'
  )
  return { pid: child.pid, value, socketPath, xauthorityPath: paths.xauthority }
}

async function startKeyring(paths, home, env, repoRoot) {
  const unlockValue = randomBytes(32).toString('hex')
  const child = spawnOrRefuse(
    'gnome-keyring-daemon',
    ['--foreground', '--unlock', '--components=secrets'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
    'SESSION_KEYRING_UNAVAILABLE'
  )
  capture(child)
  child.stdin.end(`${unlockValue}\n`)
  try {
    await waitFor(
      () => {
        const control = path.join(paths.runtimeDir, 'keyring')
        if (fs.existsSync(control) || fs.existsSync(path.join(paths.dataHome, 'keyrings')))
          return true
        return null
      },
      'SESSION_KEYRING_TIMEOUT'
    )
    verifyNativePrivateKeychain(repoRoot, env)
  } catch (err) {
    try {
      child.kill('SIGKILL')
    } catch {
      // The failure below is the reported outcome.
    }
    throw err
  }
  verifyEncryptedKeyringFiles(env, process.getuid())
  return { pid: child.pid, process: child }
}

export async function startPrivateSession({ home, repoRoot, desktopRequire }) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(process.getuid?.()))
    refuse('NONROOT_LINUX_REQUIRED')
  if (fs.realpathSync(home) !== home) refuse('SESSION_HOME_UNSAFE')
  if (process.env.HOME !== home) refuse('SESSION_HOME_ENV')
  if (Number(process.versions.node.split('.')[0]) !== 24) refuse('NODE24_REQUIRED')
  if (typeof desktopRequire !== 'function') refuse('SESSION_REQUIRE_MISSING')
  const paths = sessionPaths(home)
  privateDirectory(paths.runtimeDir)
  privateDirectory(paths.dataHome)
  privateDirectory(paths.configHome)
  privateDirectory(paths.cacheHome)
  const children = []
  const stop = () => {
    for (const child of children) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Best effort; the container owns final teardown.
      }
    }
  }
  try {
    const sessionBus = await startSessionBus(paths, home)
    children.push({ kill: signal => process.kill(sessionBus.pid, signal) })
    const display = await startDisplay(paths, home)
    children.push({ kill: signal => process.kill(display.pid, signal) })
    const env = {
      DISPLAY: display.value,
      XAUTHORITY: paths.xauthority,
      DBUS_SESSION_BUS_ADDRESS: sessionBus.address,
      XDG_RUNTIME_DIR: paths.runtimeDir,
      XDG_DATA_HOME: paths.dataHome,
      XDG_CONFIG_HOME: paths.configHome,
      XDG_CACHE_HOME: paths.cacheHome,
    }
    const keyring = await startKeyring(paths, home, { ...process.env, ...env }, repoRoot)
    children.push({ kill: signal => keyring.process.kill(signal) })
    return {
      expected: {
        sessionBus: {
          pid: sessionBus.pid,
          address: sessionBus.address,
          socketPath: sessionBus.socketPath,
        },
        display: {
          pid: display.pid,
          value: display.value,
          socketPath: display.socketPath,
          xauthorityPath: display.xauthorityPath,
        },
        keyring: { pid: keyring.pid },
      },
      env,
      assertAlive: () => {
        for (const [pid, code] of [
          [sessionBus.pid, 'SESSION_BUS_EXITED'],
          [display.pid, 'SESSION_DISPLAY_EXITED'],
          [keyring.pid, 'SESSION_KEYRING_EXITED'],
        ]) {
          if (!Number.isSafeInteger(pid)) refuse(code)
          try {
            process.kill(pid, 0)
          } catch {
            refuse(code)
          }
        }
      },
      stop,
    }
  } catch (err) {
    stop()
    throw err
  }
}
