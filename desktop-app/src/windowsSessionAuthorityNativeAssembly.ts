import { app } from 'electron'
import path from 'node:path'

export const WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV =
  'EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY'

const ASSEMBLY_NAME = 'WindowsSessionAuthorityNative.dll'

/** Locate the build-produced native helper without resolving paths from ambient environment. */
export function windowsSessionAuthorityNativeAssemblyPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (app?.isPackaged && resourcesPath) return path.join(resourcesPath, ASSEMBLY_NAME)
  return path.resolve(__dirname, '..', 'resources', ASSEMBLY_NAME)
}
