import {
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  rm,
} from "node:fs/promises";
import { dirname, sep } from "node:path";
import { PathError } from "./paths";

export interface GenerationDirectoryOwnership {
  generationRoot: boolean;
  resourceDirectory: boolean;
}

export type DurabilitySync = (path: string) => Promise<void>;
export type RemoveBlobPath = (path: string) => Promise<void>;
export type RemoveEmptyDirectory = (path: string) => Promise<void>;

export function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

export async function syncFilesystemPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const removeBlobPath: RemoveBlobPath = async path => rm(path, { force: false });

export class ImmutableBlobFilesystem {
  constructor(
    private readonly prefix: string,
    private readonly durabilitySync: DurabilitySync,
    private readonly removeBlob: RemoveBlobPath = removeBlobPath,
    private readonly removeDirectory: RemoveEmptyDirectory = rmdir
  ) {}

  /** Reject a blob-path symlink; a missing path is valid before an immutable write. */
  async assertNotSymlink(path: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new PathError("blob path is a symlink");
    } catch (err) {
      if (isErrno(err, "ENOENT")) return;
      throw err;
    }
  }

  async assertSafeDirectory(directory: string): Promise<void> {
    const base = await this.resolveStoragePrefix();
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new PathError("blob parent must be a real directory");
    }
    const resolvedDirectory = await realpath(directory);
    if (resolvedDirectory !== base && !resolvedDirectory.startsWith(`${base}${sep}`)) {
      throw new PathError("blob parent escapes the storage prefix");
    }
  }

  async assertSafeParents(path: string): Promise<void> {
    await this.assertSafeDirectory(dirname(path));
  }

  private async resolveStoragePrefix(): Promise<string> {
    const prefixInfo = await lstat(this.prefix);
    if (prefixInfo.isSymbolicLink() || !prefixInfo.isDirectory()) {
      throw new PathError("storage prefix must be a real directory");
    }
    return realpath(this.prefix);
  }

  async ensureGenerationParent(
    path: string,
    ownership: GenerationDirectoryOwnership
  ): Promise<void> {
    const parent = dirname(path);
    const generationRoot = dirname(parent);
    const ensureDirectory = async (
      directory: string,
      ownershipKey: keyof GenerationDirectoryOwnership
    ): Promise<void> => {
      try {
        await mkdir(directory, { mode: 0o700 });
        ownership[ownershipKey] = true;
      } catch (err) {
        if (!isErrno(err, "EEXIST")) throw err;
      }
      await this.assertSafeDirectory(directory);
    };

    await ensureDirectory(generationRoot, "generationRoot");
    await ensureDirectory(parent, "resourceDirectory");
  }

  /**
   * Cleanup must be durable before a caller may discard its staging manifest.
   * Independent steps continue after a fault so reconciliation has the
   * smallest possible orphan, but every cleanup fault is returned to caller.
   */
  async cleanupFailedWrite(
    path: string,
    ownsBlob: boolean,
    ownership: GenerationDirectoryOwnership
  ): Promise<unknown[]> {
    if (!ownsBlob && !ownership.resourceDirectory && !ownership.generationRoot) return [];
    const parent = dirname(path);
    const generationRoot = dirname(parent);
    const errors: unknown[] = [];
    let parentIsSafe = false;

    try {
      await this.assertSafeDirectory(parent);
      parentIsSafe = true;
    } catch (err) {
      if (!isErrno(err, "ENOENT")) errors.push(err);
    }

    if (ownsBlob && parentIsSafe) {
      try {
        await this.removeBlob(path);
      } catch (err) {
        if (!isErrno(err, "ENOENT")) errors.push(err);
      }
      try {
        await this.durabilitySync(parent);
      } catch (err) {
        if (!isErrno(err, "ENOENT")) errors.push(err);
      }
    }

    if (ownership.resourceDirectory) {
      try {
        await this.removeDirectory(parent);
      } catch (err) {
        if (!isErrno(err, "ENOENT") && !isErrno(err, "ENOTEMPTY")) errors.push(err);
      }
      try {
        await this.durabilitySync(generationRoot);
      } catch (err) {
        if (!isErrno(err, "ENOENT")) errors.push(err);
      }
    }

    if (ownership.generationRoot) {
      try {
        await this.removeDirectory(generationRoot);
      } catch (err) {
        if (!isErrno(err, "ENOENT") && !isErrno(err, "ENOTEMPTY")) errors.push(err);
      }
      try {
        await this.durabilitySync(this.prefix);
      } catch (err) {
        errors.push(err);
      }
    }

    return errors;
  }
}
