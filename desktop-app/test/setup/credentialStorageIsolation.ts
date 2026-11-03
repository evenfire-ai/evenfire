import { afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import Module, { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const attemptKey = Symbol.for('evenfire.vitest.credentialStorageAttempts')
const state = process as unknown as Record<symbol, string[] | undefined>
state[attemptKey] ??= []
const syntheticCredentialRoots = new Set<string>()

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
  const nativeDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, 'native')
  if (nativeDescriptor && typeof nativeDescriptor.value === 'function') {
    Object.defineProperty(replacement, 'native', {
      ...nativeDescriptor,
      value: wrapper(nativeDescriptor.value),
    })
  }
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
const originalLstatSync = fs.lstatSync.bind(fs)
const originalStatSync = fs.statSync.bind(fs)
const originalReaddirSync = fs.readdirSync.bind(fs)
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

/** Add a synthetic protected root for isolated guard tests; no official data is involved. */
export function registerSyntheticCredentialStorageRoot(root: string): () => void {
  const normalized = path.resolve(root)
  const canonical = canonicalPath(normalized)
  syntheticCredentialRoots.add(normalized)
  syntheticCredentialRoots.add(canonical)
  return () => {
    syntheticCredentialRoots.delete(normalized)
    syntheticCredentialRoots.delete(canonical)
  }
}

function isSyntheticProtectedPath(candidate: string): boolean {
  return [...syntheticCredentialRoots].some(
    base => candidate === base || candidate.startsWith(`${base}${path.sep}`)
  )
}

function pathCandidate(value: unknown): string | null {
  return value instanceof URL && value.protocol === 'file:'
    ? fileURLToPath(value)
    : Buffer.isBuffer(value)
      ? value.toString()
      : typeof value === 'string'
        ? value
        : null
}

function isWithin(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function protectedRoots(): string[] {
  return [...new Set([officialBase, canonicalOfficialBase, ...syntheticCredentialRoots])]
}

function globSegmentCanMatch(pattern: string, value: string, dot: boolean): boolean {
  if (pattern === '**') return dot || !value.startsWith('.')
  const hasMagic = /[*?\[\]{}()!+@]/.test(pattern)
  if (!hasMagic) return pattern === value
  if (!dot && value.startsWith('.') && !pattern.startsWith('.') && !pattern.includes('{'))
    return false
  return true
}

function globPatternCanReachRoot(
  effectivePattern: string,
  protectedRoot: string,
  dot: boolean
): boolean {
  const patternRoot = path.parse(effectivePattern).root
  const protectedPathRoot = path.parse(protectedRoot).root
  if (patternRoot.toLowerCase() !== protectedPathRoot.toLowerCase()) return false
  const patternSegments = path
    .relative(patternRoot, effectivePattern)
    .split(path.sep)
    .filter(Boolean)
  const protectedSegments = path
    .relative(patternRoot, protectedRoot)
    .split(path.sep)
    .filter(Boolean)
  const memo = new Map<string, boolean>()

  const canReach = (patternIndex: number, protectedIndex: number): boolean => {
    if (protectedIndex === protectedSegments.length) return true
    if (patternIndex === patternSegments.length) return false
    const key = `${patternIndex}:${protectedIndex}`
    const prior = memo.get(key)
    if (prior !== undefined) return prior
    const patternSegment = patternSegments[patternIndex]!
    const protectedSegment = protectedSegments[protectedIndex]!
    const result =
      patternSegment === '**'
        ? canReach(patternIndex + 1, protectedIndex) ||
          (globSegmentCanMatch(patternSegment, protectedSegment, dot) &&
            canReach(patternIndex, protectedIndex + 1))
        : globSegmentCanMatch(patternSegment, protectedSegment, dot) &&
          canReach(patternIndex + 1, protectedIndex + 1)
    memo.set(key, result)
    return result
  }

  return canReach(0, 0)
}

function canonicalGlobPattern(pattern: string): {
  pattern: string
  traversalRoot: string
  requiresWildcardSymlinkPreflight: boolean
} {
  const root = path.parse(pattern).root
  const segments = path.relative(root, pattern).split(path.sep).filter(Boolean)
  let staticSegmentCount = 0
  while (
    staticSegmentCount < segments.length &&
    !/[*?\[\]{}()!+@]/.test(segments[staticSegmentCount]!)
  ) {
    staticSegmentCount += 1
  }
  const staticPrefix = path.join(root, ...segments.slice(0, staticSegmentCount))
  const traversalRoot = canonicalPath(staticPrefix)
  const patternTail = segments.slice(staticSegmentCount)
  const requiresWildcardSymlinkPreflight = segments.some(
    (segment, index) =>
      segment !== '**' && /[*?\[\]{}()!+@]/.test(segment) && index < segments.length - 2
  )
  return {
    pattern: path.join(traversalRoot, ...patternTail),
    traversalRoot,
    // A non-globstar wildcard can select a parent before explicit symlink and file segments.
    requiresWildcardSymlinkPreflight,
  }
}

function checkGlobScope(args: unknown[]): string[] {
  const patternValues = Array.isArray(args[0]) ? args[0] : [args[0]]
  const options = args[1]
  const hasCwd = Boolean(options && typeof options === 'object' && 'cwd' in options)
  const cwdValue = hasCwd ? pathCandidate((options as { cwd?: unknown }).cwd) : null
  if (hasCwd && !cwdValue) refuse('unverifiable-credential-glob')
  const lexicalCwd = path.resolve(cwdValue ?? process.cwd())
  if (isOfficialPath(lexicalCwd) || isSyntheticProtectedPath(lexicalCwd))
    refuse('glob-credential-scope')
  const patternStrings = patternValues.map(value => {
    const pattern = pathCandidate(value)
    if (!pattern) refuse('unverifiable-credential-glob')
    return pattern
  })
  const cwd = canonicalPath(lexicalCwd)
  if (
    patternStrings.some(pattern => /[{}]/.test(pattern) && pattern.includes('..')) ||
    (cwd !== lexicalCwd &&
      patternStrings.some(
        pattern =>
          !path.isAbsolute(pattern) && pattern.split(/[\\/]+/).some(segment => segment === '..')
      ))
  ) {
    refuse('glob-credential-scope')
  }
  const dot = Boolean(options && typeof options === 'object' && 'dot' in options && options.dot)
  const effectivePatterns = patternStrings.map(pattern => path.resolve(cwd, pattern))
  const canonicalPatterns = effectivePatterns.map(canonicalGlobPattern)
  if (
    [...effectivePatterns, ...canonicalPatterns.map(({ pattern }) => pattern)].some(pattern =>
      protectedRoots().some(root => globPatternCanReachRoot(pattern, root, dot))
    )
  ) {
    refuse('glob-credential-scope')
  }
  const followsSymlinks = Boolean(
    options && typeof options === 'object' && 'followSymlinks' in options && options.followSymlinks
  )
  if (
    followsSymlinks ||
    canonicalPatterns.some(
      ({ requiresWildcardSymlinkPreflight }) => requiresWildcardSymlinkPreflight
    )
  ) {
    for (const { traversalRoot } of canonicalPatterns) {
      assertNoDereferencedProtectedTarget(traversalRoot, protectedRoots(), 'glob-credential-scope')
    }
  }
  return effectivePatterns
}

function checkPaths(args: unknown[], pathCount = args.length, checksCwd = false): void {
  const candidates = checksCwd ? checkGlobScope(args) : args.slice(0, pathCount)
  for (const value of candidates) {
    const candidate = pathCandidate(value)
    if (!candidate) continue
    const normalized = path.resolve(candidate)
    if (isOfficialPath(normalized)) refuse('official-credential-files')
    if (isSyntheticProtectedPath(normalized)) refuse('synthetic-credential-files')
    const canonical = canonicalPath(normalized)
    if (isOfficialPath(normalized) || isOfficialPath(canonical)) refuse('official-credential-files')
    if (isSyntheticProtectedPath(normalized) || isSyntheticProtectedPath(canonical))
      refuse('synthetic-credential-files')
  }
}

function checkRecursiveCopy(args: unknown[]): void {
  const options = args[2]
  if (!options || typeof options !== 'object' || !('recursive' in options)) return
  const copyOptions = options as { recursive?: boolean; dereference?: boolean }
  if (copyOptions.recursive !== true) return
  const sourceValue = pathCandidate(args[0])
  const destinationValue = pathCandidate(args[1])
  if (!sourceValue || !destinationValue) return
  const source = canonicalPath(path.resolve(sourceValue))
  const destination = canonicalPath(path.resolve(destinationValue))
  const roots = protectedRoots()
  if (roots.some(root => pathsOverlap(source, root) || pathsOverlap(destination, root)))
    refuse('recursive-credential-filesystem-operation')
  if (copyOptions.dereference === true) assertNoDereferencedProtectedTarget(source, roots)
}

function assertNoDereferencedProtectedTarget(
  source: string,
  roots: readonly string[],
  refusalKind = 'recursive-credential-filesystem-operation'
): void {
  const visitedDirectories = new Set<string>()
  let inspectedEntries = 0
  const maximumEntries = 50_000
  const maximumDepth = 128

  const visit = (candidate: string, depth: number): void => {
    inspectedEntries += 1
    if (inspectedEntries > maximumEntries || depth > maximumDepth) refuse(refusalKind)

    let sourceStat: ReturnType<typeof originalLstatSync>
    try {
      sourceStat = originalLstatSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      refuse(refusalKind)
    }

    if (sourceStat.isSymbolicLink()) {
      let target: string
      try {
        target = originalRealpath(candidate)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return
        refuse(refusalKind)
      }
      if (roots.some(root => pathsOverlap(target, root))) refuse(refusalKind)
      let targetStat: ReturnType<typeof originalStatSync>
      try {
        targetStat = originalStatSync(target)
      } catch {
        refuse(refusalKind)
      }
      if (targetStat.isDirectory()) visit(target, depth + 1)
      return
    }

    const canonical = canonicalPath(candidate)
    if (roots.some(root => pathsOverlap(canonical, root))) refuse(refusalKind)
    if (!sourceStat.isDirectory() || visitedDirectories.has(canonical)) return
    visitedDirectories.add(canonical)

    let entries: { name: string }[]
    try {
      entries = originalReaddirSync(candidate, { withFileTypes: true }) as unknown as {
        name: string
      }[]
    } catch {
      refuse(refusalKind)
    }
    for (const entry of entries) visit(path.join(candidate, entry.name), depth + 1)
  }

  visit(source, 0)
}

const filesystemPathMethods: ReadonlyArray<{
  name: string
  pathCount?: number
  checksCwd?: boolean
  promiseResult?: boolean
  recursiveCopy?: boolean
}> = [
  { name: 'access' },
  { name: 'appendFile' },
  { name: 'chmod' },
  { name: 'chown' },
  { name: 'copyFile', pathCount: 2 },
  { name: 'cp', pathCount: 2, recursiveCopy: true },
  { name: 'exists' },
  { name: 'link', pathCount: 2 },
  { name: 'lchmod' },
  { name: 'lchown' },
  { name: 'lstat' },
  { name: 'lutimes' },
  { name: 'mkdir' },
  { name: 'mkdtemp' },
  { name: 'mkdtempDisposable', promiseResult: true },
  { name: 'open' },
  { name: 'openAsBlob', promiseResult: true },
  { name: 'opendir' },
  { name: 'readFile' },
  { name: 'readdir' },
  { name: 'readlink' },
  { name: 'realpath' },
  { name: 'rename', pathCount: 2 },
  { name: 'rm' },
  { name: 'rmdir' },
  { name: 'stat' },
  { name: 'statfs' },
  { name: 'symlink', pathCount: 2 },
  { name: 'truncate' },
  { name: 'unlink' },
  { name: 'utimes' },
  { name: 'watch' },
  { name: 'watchFile' },
  { name: 'writeFile' },
  { name: 'createReadStream' },
  { name: 'createWriteStream' },
  { name: 'glob', checksCwd: true },
]

function guardPathMethod(
  pathCount: number,
  checksCwd = false,
  promiseApi = false,
  recursiveCopy = false
) {
  return (original: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      try {
        checkPaths(args, pathCount, checksCwd)
        if (recursiveCopy) checkRecursiveCopy(args)
      } catch (error) {
        if (promiseApi) return Promise.reject(error)
        throw error
      }
      return original.apply(this, args)
    }
}

for (const {
  name,
  pathCount = 1,
  checksCwd = false,
  promiseResult = false,
  recursiveCopy = false,
} of filesystemPathMethods) {
  replace(fs, name, guardPathMethod(pathCount, checksCwd, promiseResult, recursiveCopy))
  replace(fs, `${name}Sync`, guardPathMethod(pathCount, checksCwd, false, recursiveCopy))
  replace(
    fsPromises,
    name,
    guardPathMethod(pathCount, checksCwd, name !== 'watch' && name !== 'glob', recursiveCopy)
  )
}

syncBuiltinESMExports()

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
    syncBuiltinESMExports()
  }
})
