import { lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'

type WindowsAclModule = typeof import('../src/windowsSessionAuthorityAcl.js')

const TEST_USER_SID = 'S-1-5-21-0-0-0-1001'

/**
 * Keep producer/persistence unit tests focused on their auth contract on Windows.
 * The native ACL contract remains exercised by windowsSessionAuthorityAcl.native.test.ts.
 */
export function createWindowsSessionAuthorityAclUnitFixture(
  actual: WindowsAclModule
): WindowsAclModule {
  if (process.platform !== 'win32') return actual

  function evidence(userDataPath: string, authorityPath: string) {
    const root = lstatSync(userDataPath)
    const authority = lstatSync(authorityPath)
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      !authority.isDirectory() ||
      authority.isSymbolicLink() ||
      path.resolve(authorityPath) !== path.join(path.resolve(userDataPath), 'sessions')
    ) {
      throw new Error('Windows ACL unit fixture requires the canonical authority directory')
    }

    return {
      userSid: TEST_USER_SID,
      rootIdentity: `${root.dev}:${root.ino}`,
      authorityIdentity: `${authority.dev}:${authority.ino}`,
      objectCount: 1,
      authorityOwnerSid: TEST_USER_SID,
    }
  }

  return {
    ...actual,
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath) {
      mkdirSync(authorityPath, { recursive: true })
      return evidence(userDataPath, authorityPath)
    },
    verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath) {
      return evidence(userDataPath, authorityPath)
    },
  }
}
