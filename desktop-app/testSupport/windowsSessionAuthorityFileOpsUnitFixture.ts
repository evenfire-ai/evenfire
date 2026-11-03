import fs from 'node:fs'

type FileOpsModule = {
  moveSessionAuthorityFileDurablySync: (
    source: string,
    destination: string,
    replaceExisting?: boolean
  ) => void
}

/**
 * Keep authentication unit tests independent from the native Windows PowerShell launcher.
 * The Windows durability suite exercises that production boundary directly.
 */
export function createWindowsSessionAuthorityFileOpsUnitFixture<T extends FileOpsModule>(
  actual: T
): T {
  if (process.platform !== 'win32') return actual

  return {
    ...actual,
    moveSessionAuthorityFileDurablySync(source, destination, replaceExisting = false) {
      if (!replaceExisting) {
        try {
          fs.lstatSync(destination)
          throw Object.assign(new Error('Session authority destination already exists'), {
            code: 'EEXIST',
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      fs.renameSync(source, destination)
    },
  }
}
