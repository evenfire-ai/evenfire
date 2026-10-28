import { afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const attemptKey = Symbol.for('evenfire.vitest.credentialStorageAttempts')
const state = process as unknown as Record<symbol, string[] | undefined>
state[attemptKey] ??= []

function refuse(kind: string): never {
  state[attemptKey]!.push(kind)
  throw new Error(`Unit-test credential isolation refused ${kind}`)
}

/** Exported only for guard self-tests, which deliberately exercise a blocked dispatch. */
export function takeCredentialStorageIsolationAttempts(): string[] {
  const attempts = state[attemptKey] ?? []
  state[attemptKey] = []
  return attempts
}

const nativeModule = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string
  _extensions: Record<string, (module: unknown, filename: string) => unknown>
}
const restorers: (() => void)[] = []

function replace(
  target: object,
  key: string,
  wrapper: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (!descriptor || typeof descriptor.value !== 'function') return
  const replacement = wrapper(descriptor.value)
  Object.defineProperty(target, key, { ...descriptor, value: replacement })
  restorers.push(() => {
    if ((target as Record<string, unknown>)[key] === replacement)
      Object.defineProperty(target, key, descriptor)
  })
}

function isInstalledKeytar(filename: string): boolean {
  const normalized = filename.replaceAll('\\', '/')
  return (
    normalized.includes('/keytar/') &&
    (normalized.endsWith('.node') || normalized.endsWith('/lib/keytar.js'))
  )
}

replace(
  nativeModule,
  '_load',
  original =>
    function (this: unknown, ...args) {
      const [request, parent, isMain] = args as [string, unknown, boolean]
      const resolved = nativeModule._resolveFilename(request, parent, isMain)
      if (typeof resolved === 'string' && isInstalledKeytar(resolved)) refuse('native-keytar')
      return original.apply(this, args)
    }
)
replace(
  nativeModule._extensions,
  '.node',
  original =>
    function (this: unknown, ...args) {
      const filename = args[1]
      if (typeof filename === 'string' && isInstalledKeytar(filename)) refuse('native-keytar')
      return original.apply(this, args)
    }
)

// Node's Electron package is not a running app. A missed Electron mock must not fall
// through to the developer's official home credential files either.
const officialBase = path.join(os.homedir(), '.evenfire')
const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync)
function canonicalPath(candidate: string): string {
  let ancestor = candidate
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(originalRealpath(ancestor), ...suffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') refuse('unverifiable-credential-path')
      const parent = path.dirname(ancestor)
      if (parent === ancestor) refuse('unverifiable-credential-path')
      suffix.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}
const canonicalOfficialBase = canonicalPath(officialBase)
function isOfficialPath(candidate: string): boolean {
  return [officialBase, canonicalOfficialBase].some(
    base => candidate === base || candidate.startsWith(`${base}${path.sep}`)
  )
}
function checkPaths(args: unknown[]): void {
  for (const value of args) {
    const candidate =
      value instanceof URL && value.protocol === 'file:'
        ? fileURLToPath(value)
        : Buffer.isBuffer(value)
          ? value.toString()
          : typeof value === 'string'
            ? value
            : null
    if (!candidate) continue
    const normalized = path.resolve(candidate)
    if (isOfficialPath(normalized) || isOfficialPath(canonicalPath(normalized)))
      refuse('official-credential-files')
  }
}
for (const method of [
  'open',
  'readFile',
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'unlink',
  'rename',
  'stat',
  'lstat',
  'access',
  'realpath',
  'exists',
]) {
  replace(
    fs,
    `${method}Sync`,
    original =>
      function (this: unknown, ...args) {
        checkPaths(args.slice(0, method === 'rename' ? 2 : 1))
        return original.apply(this, args)
      }
  )
  replace(
    fsPromises,
    method,
    original =>
      function (this: unknown, ...args) {
        try {
          checkPaths(args.slice(0, method === 'rename' ? 2 : 1))
        } catch (error) {
          return Promise.reject(error)
        }
        return original.apply(this, args)
      }
  )
}

function assertNoEscape(): void {
  const attempts = takeCredentialStorageIsolationAttempts()
  if (attempts.length > 0) {
    throw new Error(`Credential test backend escaped isolation (${attempts.join(', ')})`)
  }
}
afterEach(assertNoEscape)
afterAll(() => {
  try {
    assertNoEscape()
  } finally {
    for (const restore of restorers.reverse()) restore()
  }
})
