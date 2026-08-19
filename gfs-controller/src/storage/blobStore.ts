import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open as fsOpen,
  rmdir as fsRmdir,
  rm as fsRm,
  stat as fsStat,
  statfs as fsStatfs,
} from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  generationBlobKey,
  normalizeBlobKey,
  normalizeResourceId,
  PathError,
  resolveBlobKeyPath,
  resolveBlobPath,
} from "./paths";
import {
  ImmutableBlobFilesystem,
  isErrno,
  syncFilesystemPath,
  type DurabilitySync,
  type GenerationDirectoryOwnership,
  type RemoveBlobPath,
  type RemoveEmptyDirectory,
} from "./immutableBlobFilesystem";

export interface ImmutableBlob {
  blobKey: string;
  bytes: number;
  contentSha256: string;
}
export interface ImmutableWriteOptions {
  signal?: AbortSignal;
  checkDeadline?: () => void;
}
export type FilesystemStats = (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
type ExclusiveBlobOpen = (path: string, flags: number, mode: number) => ReturnType<typeof fsOpen>;
const readFilesystemStats: FilesystemStats = async path => {
  const stats = await fsStatfs(path, { bigint: true });
  return { bavail: stats.bavail, bsize: stats.bsize };
};

export class ReadOnlyStoreError extends Error {
  readonly code = "forbidden";
  constructor(message = "this gfsc replica mounts the drive read-only") {
    super(message);
    this.name = "ReadOnlyStoreError";
  }
}

export class BlobNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("blob not found");
    this.name = "BlobNotFoundError";
  }
}
export class BlobVerificationError extends Error {
  constructor(message = "immutable blob verification failed") {
    super(message);
    this.name = "BlobVerificationError";
  }
}
export class BlobWriteCleanupError extends AggregateError {
  constructor(
    readonly writeError: unknown,
    readonly cleanupErrors: readonly unknown[]
  ) {
    super([writeError, ...cleanupErrors], "immutable blob write failed and cleanup was incomplete", {
      cause: writeError,
    });
    this.name = "BlobWriteCleanupError";
  }
}

function immutableBlobKey(resourceId: unknown, generation: unknown): string {
  try {
    return generationBlobKey(resourceId, generation);
  } catch (err) {
    if (err instanceof PathError) throw new PathError("invalid immutable blob identity");
    throw err;
  }
}

function committedBlobKey(resourceId: string, blobKey: string): string {
  let normalized: string;
  try {
    normalized = normalizeBlobKey(blobKey);
  } catch (err) {
    if (err instanceof PathError) throw new PathError("invalid committed blob reference");
    throw err;
  }
  if (!normalized.startsWith(`${normalizeResourceId(resourceId)}/`)) {
    throw new PathError("blob key does not belong to resource");
  }
  return normalized;
}

/** Immutable generations plus read-only legacy flat blobs. */
export class BlobStore {
  private readonly immutableFilesystem: ImmutableBlobFilesystem;

  constructor(
    private readonly prefix: string,
    private readonly role: "writer" | "reader",
    private readonly durabilitySync: DurabilitySync = syncFilesystemPath,
    private readonly filesystemStats: FilesystemStats = readFilesystemStats,
    private readonly openExclusive: ExclusiveBlobOpen = fsOpen,
    removeBlobPath?: RemoveBlobPath,
    removeEmptyDirectory?: RemoveEmptyDirectory
  ) {
    this.immutableFilesystem = new ImmutableBlobFilesystem(
      prefix,
      durabilitySync,
      removeBlobPath,
      removeEmptyDirectory
    );
  }

  private requireWriter(): void {
    if (this.role !== "writer") throw new ReadOnlyStoreError();
  }

  private checkWrite(options: ImmutableWriteOptions): void {
    options.signal?.throwIfAborted();
    options.checkDeadline?.();
  }

  async availableBytes(): Promise<bigint> {
    const stats = await this.filesystemStats(this.prefix);
    if (stats.bavail < 0n || stats.bsize < 0n) {
      throw new Error("filesystem reported invalid available space");
    }
    return stats.bavail * stats.bsize;
  }

  async writeImmutable(
    resourceId: string,
    generation: string,
    data: Readable | Buffer,
    options: ImmutableWriteOptions = {}
  ): Promise<ImmutableBlob> {
    this.requireWriter();
    this.checkWrite(options);
    const blobKey = immutableBlobKey(resourceId, generation);
    const path = resolveBlobKeyPath(this.prefix, blobKey);
    const parent = dirname(path);
    const generationRoot = dirname(parent);
    const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
    const digest = createHash("sha256");
    let bytes = 0;
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          options.signal?.throwIfAborted();
          options.checkDeadline?.();
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.length;
          digest.update(value);
          callback(null, value);
        } catch (err) {
          callback(err as Error);
        }
      },
    });
    let created = false;
    const directoryOwnership: GenerationDirectoryOwnership = {
      generationRoot: false,
      resourceDirectory: false,
    };
    try {
      this.checkWrite(options);
      await this.immutableFilesystem.ensureGenerationParent(path, directoryOwnership);
      this.checkWrite(options);
      await this.immutableFilesystem.assertSafeParents(path);
      await this.immutableFilesystem.assertNotSymlink(path);
      this.checkWrite(options);
      const handle = await this.openExclusive(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      created = true;
      await pipeline(source, hashing, handle.createWriteStream(), { signal: options.signal });
      this.checkWrite(options);
      for (const syncPath of [path, parent, generationRoot, this.prefix]) {
        this.checkWrite(options);
        await this.durabilitySync(syncPath);
        this.checkWrite(options);
      }
      const info = await fsStat(path);
      if (!info.isFile() || info.size !== bytes) {
        throw new BlobVerificationError("immutable blob size verification failed");
      }
      const contentSha256 = digest.digest("hex");
      await this.verify(blobKey, bytes, contentSha256, options);
      return { blobKey, bytes, contentSha256 };
    } catch (err) {
      const cleanupErrors = await this.immutableFilesystem.cleanupFailedWrite(
        path,
        created,
        directoryOwnership
      );
      if (cleanupErrors.length > 0) {
        throw new BlobWriteCleanupError(err, cleanupErrors);
      }
      throw err;
    }
  }

  async verify(
    blobKey: string,
    expectedBytes: number,
    expectedSha256: string,
    options: ImmutableWriteOptions = {}
  ): Promise<void> {
    this.checkWrite(options);
    const path = resolveBlobKeyPath(this.prefix, blobKey);
    await this.immutableFilesystem.assertSafeParents(path);
    await this.immutableFilesystem.assertNotSymlink(path);
    const digest = createHash("sha256");
    let bytes = 0;
    const handle = await fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      this.checkWrite(options);
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      digest.update(value);
    }
    this.checkWrite(options);
    const actual = digest.digest("hex");
    if (bytes !== expectedBytes || actual !== expectedSha256) {
      throw new BlobVerificationError("immutable blob digest verification failed");
    }
  }

  async read(resourceId: string, blobKey?: string | null): Promise<Readable> {
    const normalizedBlobKey = blobKey ? committedBlobKey(resourceId, blobKey) : null;
    const path = normalizedBlobKey
      ? resolveBlobKeyPath(this.prefix, normalizedBlobKey)
      : resolveBlobPath(this.prefix, resourceId);
    try {
      await this.immutableFilesystem.assertSafeParents(path);
      await this.immutableFilesystem.assertNotSymlink(path);
      const handle = await fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new PathError("blob path is not a file");
        return handle.createReadStream();
      } catch (err) {
        await handle.close().catch(() => undefined);
        throw err;
      }
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new BlobNotFoundError();
      throw err;
    }
  }

  async delete(resourceId: string): Promise<void> {
    this.requireWriter();
    const path = resolveBlobPath(this.prefix, resourceId);
    await this.immutableFilesystem.assertSafeParents(path);
    await this.immutableFilesystem.assertNotSymlink(path);
    try {
      await fsRm(path, { force: false });
      await this.durabilitySync(this.prefix);
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new BlobNotFoundError();
      throw err;
    }
  }

  async deleteByKey(blobKey: string): Promise<void> {
    this.requireWriter();
    const path = resolveBlobKeyPath(this.prefix, blobKey);
    const parent = dirname(path);
    const generationRoot = dirname(parent);
    try {
      await this.immutableFilesystem.assertSafeDirectory(generationRoot);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      await this.durabilitySync(this.prefix);
      return;
    }

    let parentExists = true;
    try {
      await this.immutableFilesystem.assertSafeParents(path);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      parentExists = false;
    }

    if (parentExists) {
      await this.immutableFilesystem.assertNotSymlink(path);
      try {
        await fsRm(path, { force: false });
      } catch (err) {
        if (!isErrno(err, "ENOENT")) throw err;
      }
      await this.durabilitySync(parent);
    }

    try {
      await fsRmdir(parent);
    } catch (err) {
      if (!isErrno(err, "ENOENT") && !isErrno(err, "ENOTEMPTY")) throw err;
    }
    await this.durabilitySync(generationRoot);
    await this.durabilitySync(this.prefix);
  }
  async deleteLegacyFlat(resourceId: string): Promise<void> {
    return this.delete(resourceId);
  }
}
