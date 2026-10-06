import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IncomingMessage } from '../server/types'
import { isProtectedRealPath } from './protectedPaths'
import type { ScopedWorkspaceProvider } from './scopedWorkspace'
import { deriveUserKeyFromSource } from './userKey'

export interface CallerRootBinding {
  root?: string
  failureCode?: 'EACCES' | 'EEXIST' | 'EIO' | 'ENOENT' | 'ENOSPC' | 'ENOTDIR' | 'EPERM' | 'EROFS'
}

/**
 * Verify the managed caller shape `<host>/users/<caller>` without prohibiting
 * a platform alias on the Host base itself. The `users` parent and caller root
 * must be real directories; a protected resolved root is not a caller root.
 * Filesystem errors propagate so callers can distinguish degradation from redirects.
 */
export function verifyManagedCallerRootPath(lexicalCallerRoot: string): string | undefined {
  const lexicalCaller = path.resolve(lexicalCallerRoot)
  const callerName = path.basename(lexicalCaller)
  const lexicalUsersRoot = path.dirname(lexicalCaller)
  if (path.basename(lexicalUsersRoot) !== 'users' || !callerName || callerName === '.') {
    return undefined
  }
  const lexicalHostBase = path.dirname(lexicalUsersRoot)
  const canonicalHostBase = fs.realpathSync(lexicalHostBase)
  const canonicalUsersRoot = path.join(canonicalHostBase, 'users')
  const usersInfo = fs.lstatSync(lexicalUsersRoot)
  if (!usersInfo.isDirectory() || usersInfo.isSymbolicLink()) return undefined
  const callerInfo = fs.lstatSync(lexicalCaller)
  if (!callerInfo.isDirectory() || callerInfo.isSymbolicLink()) return undefined
  const canonicalCallerRoot = path.join(canonicalUsersRoot, callerName)
  if (
    fs.realpathSync(lexicalCaller) !== canonicalCallerRoot ||
    isProtectedRealPath(canonicalCallerRoot, canonicalHostBase)
  ) {
    return undefined
  }
  return canonicalCallerRoot
}

function bindingFailureCode(error: unknown): CallerRootBinding['failureCode'] {
  const code = (error as NodeJS.ErrnoException)?.code
  if (
    code === 'EACCES' ||
    code === 'EEXIST' ||
    code === 'EIO' ||
    code === 'ENOENT' ||
    code === 'ENOSPC' ||
    code === 'ENOTDIR' ||
    code === 'EPERM' ||
    code === 'EROFS'
  ) {
    return code
  }
  return undefined
}

/**
 * Derive a verified caller root without turning filesystem degradation into a
 * fake system identity or shared-root fallback. Unexpected programming errors
 * propagate; only concrete caller-root creation/access failures return undefined.
 */
export function resolveCallerRootBinding(
  provider: ScopedWorkspaceProvider | null | undefined,
  sourceMessage?: Pick<IncomingMessage, 'sender' | 'channelType'> | null
): CallerRootBinding {
  if (!provider) return {}
  try {
    const lexicalHostBase = path.resolve(provider.baseRootPath)
    const canonicalHostBase = fs.realpathSync(lexicalHostBase)
    const lexicalUsersRoot = path.join(lexicalHostBase, 'users')
    const canonicalUsersRoot = path.join(canonicalHostBase, 'users')

    // Establish and verify the trusted parent before provider.forSource(),
    // which get-or-creates the caller child. A redirected parent must never
    // receive that child creation.
    let usersInfo: fs.Stats
    try {
      usersInfo = fs.lstatSync(lexicalUsersRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fs.mkdirSync(lexicalUsersRoot, { recursive: false, mode: 0o700 })
      usersInfo = fs.lstatSync(lexicalUsersRoot)
    }
    if (
      !usersInfo.isDirectory() ||
      usersInfo.isSymbolicLink() ||
      fs.realpathSync(lexicalUsersRoot) !== canonicalUsersRoot
    ) {
      return { failureCode: 'EEXIST' }
    }

    const callerKey = deriveUserKeyFromSource(sourceMessage)
    const expectedLexicalCallerRoot = path.join(lexicalUsersRoot, callerKey)
    const lexicalCallerRoot = path.resolve(provider.forSource(sourceMessage).userRootPath)
    if (lexicalCallerRoot !== expectedLexicalCallerRoot) return { failureCode: 'EEXIST' }

    const canonicalCallerRoot = verifyManagedCallerRootPath(lexicalCallerRoot)
    if (
      canonicalCallerRoot === undefined ||
      canonicalCallerRoot !== path.join(canonicalUsersRoot, callerKey)
    ) {
      return { failureCode: 'EEXIST' }
    }
    return { root: canonicalCallerRoot }
  } catch (error) {
    const failureCode = bindingFailureCode(error)
    if (failureCode === undefined) throw error
    return { failureCode }
  }
}
