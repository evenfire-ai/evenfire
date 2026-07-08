import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  rm as fsRm,
  stat as fsStat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PathError, resolveBlobPath } from "./paths";

export interface BlobStat {
  exists: boolean;
  bytes: number;
}

export class ReadOnlyStoreError extends Error {
  readonly code = "forbidden";
  constructor(message = "this gfsc replica mounts the drive read-only") {
    super(message);
    this.name = "ReadOnlyStoreError";
  }
}

export class BlobNotFoundError extends Error {
  readonly code = "not_found";
  constructor(resourceId: string) {
    super(`blob not found: ${resourceId}`);
    this.name = "BlobNotFoundError";
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Flat blob store: opaque bytes keyed by resourceId at `<prefix>/<resourceId>`.
 * The writer replica mounts the volume RW; reader replicas mount it RO and must
 * never mutate (enforced here AND by the pod's read-only mount). The human path
 * is DB metadata, never reflected on disk, so there is no rename/move here — a
 * move is a pure DB reparent.
 */
export class BlobStore {
  constructor(
    private readonly prefix: string,
    private readonly role: "writer" | "reader"
  ) {}

  private requireWriter(): void {
    if (this.role !== "writer") throw new ReadOnlyStoreError();
  }

  /**
   * Reject a symlink at the blob path. gfsc never follows a symlink out of the
   * prefix; a missing path is fine (the blob simply does not exist yet).
   */
  private async assertNotSymlink(path: string): Promise<void> {
    try {
      const info = await fsLstat(path);
      if (info.isSymbolicLink()) {
        throw new PathError("blob path is a symlink");
      }
    } catch (err) {
      if (isErrno(err, "ENOENT")) return;
      throw err;
    }
  }

  async write(resourceId: string, data: Readable | Buffer): Promise<{ bytes: number }> {
    this.requireWriter();
    const path = resolveBlobPath(this.prefix, resourceId);
    await this.assertNotSymlink(path);
    await fsMkdir(dirname(path), { recursive: true });
    const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
    await pipeline(source, createWriteStream(path, { flags: "w", mode: 0o600 }));
    const info = await fsStat(path);
    return { bytes: info.size };
  }

  async read(resourceId: string): Promise<Readable> {
    const path = resolveBlobPath(this.prefix, resourceId);
    await this.assertNotSymlink(path);
    try {
      await fsStat(path);
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new BlobNotFoundError(resourceId);
      throw err;
    }
    return createReadStream(path);
  }

  async stat(resourceId: string): Promise<BlobStat> {
    const path = resolveBlobPath(this.prefix, resourceId);
    try {
      const info = await fsStat(path);
      return { exists: true, bytes: info.size };
    } catch (err) {
      if (isErrno(err, "ENOENT")) return { exists: false, bytes: 0 };
      throw err;
    }
  }

  async delete(resourceId: string): Promise<void> {
    this.requireWriter();
    const path = resolveBlobPath(this.prefix, resourceId);
    await this.assertNotSymlink(path);
    try {
      await fsRm(path, { force: false });
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new BlobNotFoundError(resourceId);
      throw err;
    }
  }

  /**
   * Physical enumeration of stored blob keys (for ops / GC). The human-facing
   * directory listing is DB-driven (cursor-paginated), never this call.
   */
  async list(): Promise<string[]> {
    try {
      return await fsReaddir(this.prefix);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
  }
}
