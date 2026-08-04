import { describe, expect, it } from "vitest";
import { GfsError } from "./errors";
import { CopyDestinationSnapshot, CopyPreflightInput, CopySnapshotNode, preflightCopy } from "./copy";

const SOURCE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FILE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DEST = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ROOT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function node(over: Partial<CopySnapshotNode> = {}): CopySnapshotNode {
  return {
    resourceId: SOURCE,
    drive: "main",
    parentResourceId: ROOT,
    name: "source",
    kind: "directory",
    pathCache: "/source",
    version: 7,
    bytes: 0n,
    blobKey: null,
    contentSha256: null,
    deletedAt: null,
    depth: 0,
    cycle: false,
    underTombstone: false,
    ...over,
  };
}

function destination(over: Partial<CopyDestinationSnapshot> = {}): CopyDestinationSnapshot {
  return {
    ancestors: [
      node({ resourceId: DEST, parentResourceId: ROOT, name: "archive", pathCache: "/archive", version: 2, depth: 0 }),
      node({ resourceId: ROOT, parentResourceId: null, name: "", pathCache: "/", version: 1, depth: 1 }),
    ],
    liveChildren: [],
    ...over,
  };
}

function input(over: Partial<CopyPreflightInput> = {}): CopyPreflightInput {
  return {
    drive: "main",
    sourceResourceId: SOURCE,
    destinationParentId: DEST,
    ifMatch: 7,
    snapshot: [
      node(),
      node({
        resourceId: FILE,
        parentResourceId: SOURCE,
        name: "résumé.txt",
        pathCache: "/source/résumé.txt",
        kind: "file",
        version: 3,
        bytes: 12n,
        blobKey: `${FILE.replaceAll("-", "")}/generation`,
        contentSha256: "a".repeat(64),
        depth: 1,
      }),
    ],
    destination: destination(),
    maxObjects: 1000,
    maxBytes: 1024 * 1024 * 1024,
    deadlineAtMs: 31_000,
    nowMs: 1_000,
    ...over,
  };
}

function expectCode(fn: () => unknown, code: GfsError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("preflightCopy", () => {
  it("returns deterministic totals and an old-id parent map without allocating identities", () => {
    const request = input({ snapshot: [...input().snapshot].reverse() });
    const plan = preflightCopy(request);

    expect(plan.nodes.map(item => item.resourceId)).toEqual([SOURCE, FILE]);
    expect(plan).toMatchObject({ rootName: "source", objectCount: 2, fileCount: 1, folderCount: 1, totalBytes: 12n });
    expect([...plan.parentByResourceId.entries()]).toEqual([
      [SOURCE.replaceAll("-", ""), null],
      [FILE.replaceAll("-", ""), SOURCE.replaceAll("-", "")],
    ]);
  });

  it("NFC-normalizes an explicit destination name", () => {
    expect(preflightCopy(input({ newName: "re\u0301sume\u0301" })).rootName).toBe("résumé");
  });

  it("accepts a newly-created source root at version 0 with If-Match 0", () => {
    expect(preflightCopy(input({ ifMatch: 0, snapshot: [node({ version: 0 })] })).objectCount).toBe(1);
  });

  it("copies the observed live folder when historical tombstoned children are absent from the snapshot", () => {
    const plan = preflightCopy(input({ snapshot: [node()] }));
    expect(plan).toMatchObject({ objectCount: 1, folderCount: 1, fileCount: 0, totalBytes: 0n });
  });

  it("rejects an empty drive without inventing a drive-name grammar", () => {
    expectCode(() => preflightCopy(input({ drive: "" })), "path_invalid");
  });

  it("admits object and byte totals exactly at their configured limits", () => {
    expect(preflightCopy(input({ maxObjects: 2, maxBytes: 12 })).totalBytes).toBe(12n);
  });

  it("admits the documented 1000-object default and rejects object 1001", () => {
    const descendants = Array.from({ length: 999 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return node({
        resourceId: `00000000-0000-4000-8000-${suffix}`,
        parentResourceId: SOURCE,
        name: `file-${index + 1}`,
        pathCache: `/source/file-${index + 1}`,
        kind: "file",
        version: 0,
        bytes: 1n,
        blobKey: `00000000000040008000${suffix}/generation`,
        contentSha256: "a".repeat(64),
        depth: 1,
      });
    });
    const atDefault = [node(), ...descendants];

    expect(preflightCopy(input({ snapshot: atDefault }))).toMatchObject({
      objectCount: 1000,
      fileCount: 999,
      folderCount: 1,
      totalBytes: 999n,
    });

    expectCode(
      () => preflightCopy(input({ snapshot: [
        ...atDefault,
        node({
          resourceId: "00000000-0000-4000-8000-000000001000",
          parentResourceId: SOURCE,
          name: "file-1000",
          pathCache: "/source/file-1000",
          kind: "file",
          version: 0,
          bytes: 1n,
          blobKey: "00000000000040008000000000001000/generation",
          contentSha256: "b".repeat(64),
          depth: 1,
        }),
      ] })),
      "payload_too_large"
    );
  });

  it.each([
    ["objects", { maxObjects: 1 }],
    ["bytes", { maxBytes: 11 }],
  ])("rejects one over the configured %s limit before publication", (_label, over) => {
    expectCode(() => preflightCopy(input(over)), "payload_too_large");
  });

  it("rejects a byte sum that cannot be represented safely", () => {
    expectCode(
      () => preflightCopy(input({ snapshot: [node({ kind: "file", bytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n })], maxBytes: Number.MAX_SAFE_INTEGER })),
      "payload_too_large"
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid operational limit %s",
    invalid => expectCode(() => preflightCopy(input({ maxObjects: invalid })), "path_invalid")
  );

  it("requires the root If-Match and rejects a stale value", () => {
    expectCode(() => preflightCopy(input({ ifMatch: undefined })), "precondition_failed");
    expectCode(() => preflightCopy(input({ ifMatch: 6 })), "precondition_failed");
  });

  it("rejects at the deadline boundary", () => {
    expectCode(() => preflightCopy(input({ nowMs: 31_000 })), "precondition_failed");
    expect(preflightCopy(input({ nowMs: 30_999 })).objectCount).toBe(2);
  });

  it("rejects an absent source or destination", () => {
    expectCode(() => preflightCopy(input({ snapshot: [] })), "not_found");
    expectCode(() => preflightCopy(input({ destination: { ancestors: [], liveChildren: [] } })), "not_found");
  });

  it("rejects a destination equal to or below the frozen source", () => {
    expectCode(
      () => preflightCopy(input({ destinationParentId: SOURCE, destination: destination({ ancestors: [node(), node({ resourceId: ROOT, parentResourceId: null, name: "", pathCache: "/", depth: 1 })] }) })),
      "path_invalid"
    );
    expectCode(
      () => preflightCopy(input({
        destinationParentId: FILE,
        snapshot: [node(), node({ resourceId: FILE, parentResourceId: SOURCE, name: "nested", pathCache: "/source/nested", depth: 1 })],
        destination: destination({ ancestors: [
          node({ resourceId: FILE, parentResourceId: SOURCE, name: "nested", pathCache: "/source/nested", depth: 0 }),
          node({ parentResourceId: ROOT, pathCache: "/source", depth: 1 }),
          node({ resourceId: ROOT, parentResourceId: null, name: "", pathCache: "/", depth: 2 }),
        ] }),
      })),
      "path_invalid"
    );
  });

  it("rejects a live root-name collision but accepts an explicit conflict-free name", () => {
    const withCollision = destination({ liveChildren: [{ resourceId: OTHER, name: "source" }] });
    expectCode(() => preflightCopy(input({ destination: withCollision })), "already_exists");
    expect(preflightCopy(input({ destination: withCollision, newName: "source-copy" })).rootName).toBe("source-copy");
  });

  it.each([
    ["source cycle flag", { snapshot: [node({ cycle: true })] }],
    ["live node below tombstone", { snapshot: [node({ underTombstone: true })] }],
    ["duplicate source id", { snapshot: [node(), node({ depth: 1, parentResourceId: SOURCE })] }],
    ["disconnected descendant", { snapshot: [node(), node({ resourceId: FILE, parentResourceId: OTHER, depth: 1 })] }],
    ["parent is a file", { snapshot: [node({ kind: "file" }), node({ resourceId: FILE, parentResourceId: SOURCE, depth: 1 })] }],
    ["tombstone", { snapshot: [node({ deletedAt: "2026-07-17T00:00:00.000Z" })] }],
    ["invalid depth", { snapshot: [node({ depth: -1 })] }],
    ["nonzero directory bytes", { snapshot: [node({ bytes: 1n })] }],
    ["negative file bytes", { snapshot: [node({ kind: "file", bytes: -1n })] }],
    ["non-NFC source name", { snapshot: [node({ name: "re\u0301sume\u0301" })] }],
  ])("rejects structurally invalid snapshot: %s", (_label, over) => {
    expectCode(() => preflightCopy(input(over as Partial<CopyPreflightInput>)), "precondition_failed");
  });

  it("rejects cross-drive source and destination ancestry", () => {
    expectCode(() => preflightCopy(input({ snapshot: [node({ drive: "other" })] })), "cross_boundary");
    expectCode(
      () => preflightCopy(input({ destination: destination({ ancestors: [node({ resourceId: DEST, drive: "other" })] }) })),
      "cross_boundary"
    );
  });

  it("rejects an invalid destination parent, broken ancestry, cycle, or noncanonical drive root", () => {
    expectCode(() => preflightCopy(input({ destination: destination({ ancestors: [node({ resourceId: DEST, kind: "file" })] }) })), "not_a_directory");
    expectCode(() => preflightCopy(input({ destination: destination({ ancestors: [node({ resourceId: DEST, parentResourceId: OTHER }), node({ resourceId: ROOT, parentResourceId: null, name: "", depth: 1 })] }) })), "precondition_failed");
    expectCode(() => preflightCopy(input({ destination: destination({ ancestors: [node({ resourceId: DEST, cycle: true })] }) })), "precondition_failed");
    expectCode(() => preflightCopy(input({ destination: destination({ ancestors: [node({ resourceId: DEST, parentResourceId: ROOT }), node({ resourceId: ROOT, parentResourceId: null, name: "root", depth: 1 })] }) })), "precondition_failed");
  });

  it("rejects invalid names and duplicate destination child ids", () => {
    expectCode(() => preflightCopy(input({ newName: "../bad" })), "path_invalid");
    expectCode(
      () => preflightCopy(input({ destination: destination({ liveChildren: [{ resourceId: OTHER, name: "one" }, { resourceId: OTHER, name: "two" }] }) })),
      "precondition_failed"
    );
  });

  it("rejects stale and non-canonical source or destination path caches", () => {
    expectCode(() => preflightCopy(input({ snapshot: [node(), node({ resourceId: FILE, parentResourceId: SOURCE, name: "file", kind: "file", pathCache: "/stale/file", bytes: 1n, depth: 1 })] })), "precondition_failed");
    expectCode(() => preflightCopy(input({ snapshot: [node({ pathCache: "/source/" })] })), "precondition_failed");
    expectCode(() => preflightCopy(input({ destination: destination({ ancestors: [node({ resourceId: DEST, parentResourceId: ROOT, name: "archive", pathCache: "/stale/archive", depth: 0 }), node({ resourceId: ROOT, parentResourceId: null, name: "", pathCache: "/", depth: 1 })] }) })), "precondition_failed");
  });
});
