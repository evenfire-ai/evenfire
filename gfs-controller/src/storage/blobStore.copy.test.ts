import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "./blobStore";
import { resolveBlobKeyPath } from "./paths";

const RID = "0123456789abcdef0123456789abcdef";
const GENERATION = "11111111-1111-4111-8111-111111111111";

describe("BlobStore copy staging safeguards", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gfs-copy-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("computes available bytes with bigint statfs operands", async () => {
    const bavail = 9_007_199_254_740_993n;
    const bsize = 4096n;
    const store = new BlobStore(dir, "writer", async () => undefined, async path => {
      expect(path).toBe(dir);
      return { bavail, bsize };
    });
    expect(await store.availableBytes()).toBe(bavail * bsize);
  });

  it("awaits stream cancellation and removes partial bytes on abort", async () => {
    const controller = new AbortController();
    let sourceClosed = false;
    const source = Readable.from((async function* () {
      try {
        yield Buffer.from("first");
        controller.abort(new Error("copy cancelled"));
        yield Buffer.from("second");
      } finally {
        sourceClosed = true;
      }
    })());
    const store = new BlobStore(dir, "writer");
    await expect(store.writeImmutable(RID, GENERATION, source, { signal: controller.signal })).rejects.toThrow();
    expect(sourceClosed).toBe(true);
    expect(existsSync(resolveBlobKeyPath(dir, `${RID}/${GENERATION}`))).toBe(false);
  });

  it("propagates ENOSPC without leaving a partial generation", async () => {
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const source = new Readable({ read() { this.destroy(full); } });
    const store = new BlobStore(dir, "writer");
    await expect(store.writeImmutable(RID, GENERATION, source)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(existsSync(resolveBlobKeyPath(dir, `${RID}/${GENERATION}`))).toBe(false);
  });

  it("checks the deadline around every durability sync and cleans a failed candidate", async () => {
    let checks = 0;
    let syncs = 0;
    const store = new BlobStore(dir, "writer", async () => { syncs += 1; });
    await expect(store.writeImmutable(RID, GENERATION, Buffer.from("data"), {
      checkDeadline: () => {
        checks += 1;
        if (syncs === 2) throw new Error("deadline");
      },
    })).rejects.toThrow("deadline");
    expect(syncs).toBe(5); // two write syncs, then three cleanup directory syncs
    expect(checks).toBeGreaterThan(4);
    expect(existsSync(resolveBlobKeyPath(dir, `${RID}/${GENERATION}`))).toBe(false);
  });
});
