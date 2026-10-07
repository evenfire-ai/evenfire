import * as fs from 'fs'
import * as path from 'path'
import { isProtectedRealPath, isProtectedWorkspacePath } from '../../workspace/protectedPaths'
import { assertStateDbPathAllowed } from '../../workspace/stateProtection'

export function isWithinDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Shared path validation for file_read and file_write.
 *
 * Risk 3.5.1: Defense-in-depth against path traversal:
 * - Reject null bytes
 * - Reject absolute paths
 * - Reject parent directory traversal (..)
 * - Resolve within workspace and verify symlinks
 */
export function validatePath(
  requestedPath: string,
  workspacePath: string
): { valid: boolean; resolved: string; error?: string } {
  // Reject null bytes (Risk 3.5.1)
  if (requestedPath.includes('\0')) {
    return { valid: false, resolved: '', error: 'Path contains null bytes' }
  }

  // Reject absolute paths (Risk 3.5.1)
  if (path.isAbsolute(requestedPath)) {
    return { valid: false, resolved: '', error: 'Absolute paths not allowed' }
  }

  // Reject parent directory traversal (Risk 3.5.1)
  if (requestedPath.includes('..')) {
    return {
      valid: false,
      resolved: '',
      error: 'Directory traversal (..) not allowed',
    }
  }

  if (isProtectedWorkspacePath(requestedPath)) {
    return {
      valid: false,
      resolved: '',
      error: 'Reserved workspace path is not agent-accessible',
    }
  }

  // Resolve within workspace
  const resolved = path.resolve(workspacePath, requestedPath)
  try {
    assertStateDbPathAllowed(requestedPath, workspacePath)
  } catch (err) {
    return { valid: false, resolved: '', error: (err as Error).message }
  }

  // Verify resolved path is within workspace (symlink protection)
  const realWorkspace = fs.realpathSync(workspacePath)
  let realResolved: string
  try {
    realResolved = fs.realpathSync(resolved)
  } catch {
    // File doesn't exist yet (for writes) — walk up to the first existing
    // ancestor and verify it's within the workspace. This supports creating
    // files in nested directories that don't exist yet (e.g., "mathlib/utils.js").
    let ancestor = path.dirname(resolved)
    while (ancestor !== path.dirname(ancestor)) {
      try {
        const realAncestor = fs.realpathSync(ancestor)
        if (!isWithinDirectory(realAncestor, realWorkspace)) {
          return {
            valid: false,
            resolved: '',
            error: 'Path resolves outside workspace',
          }
        }
        if (isProtectedRealPath(realAncestor, realWorkspace)) {
          return {
            valid: false,
            resolved: '',
            error: 'Reserved workspace path is not agent-accessible',
          }
        }
        return { valid: true, resolved }
      } catch {
        ancestor = path.dirname(ancestor)
      }
    }
    return {
      valid: false,
      resolved: '',
      error: 'No valid ancestor directory found within workspace',
    }
  }

  if (!isWithinDirectory(realResolved, realWorkspace)) {
    return {
      valid: false,
      resolved: '',
      error: 'Path resolves outside workspace (symlink)',
    }
  }

  if (isProtectedRealPath(realResolved, realWorkspace)) {
    return {
      valid: false,
      resolved: '',
      error: 'Reserved workspace path is not agent-accessible',
    }
  }

  return { valid: true, resolved }
}
