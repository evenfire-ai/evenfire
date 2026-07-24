import { GfsError } from "./errors";
import { normalizeResourceName, ResourceNameError } from "./resourceName";
import { normalizeResourceId, PathError } from "../storage/paths";

/** One immutable metadata observation returned by the recursive snapshot query. */
export interface CopySnapshotNode {
  resourceId: string;
  drive: string;
  parentResourceId: string | null;
  name: string;
  kind: "file" | "directory";
  pathCache: string | null;
  version: number;
  bytes: bigint;
  blobKey: string | null;
  contentSha256: string | null;
  deletedAt: string | null;
  depth: number;
  /** True when the recursive CTE encountered an id already on its traversal path. */
  cycle: boolean;
  /** Integrity sentinel: a live row was reached through a tombstoned ancestor. */
  underTombstone: boolean;
}

/** Destination parent plus its complete upward ancestry and current live children. */
export interface CopyDestinationSnapshot {
  ancestors: CopySnapshotNode[];
  liveChildren: Array<{ resourceId: string; name: string }>;
}

export interface CopyPreflightInput {
  drive: string;
  sourceResourceId: string;
  destinationParentId: string;
  newName?: string;
  ifMatch?: number;
  snapshot: CopySnapshotNode[];
  destination: CopyDestinationSnapshot;
  maxObjects: number;
  maxBytes: number;
  deadlineAtMs: number;
  nowMs: number;
}

export interface CopyPreflightPlan {
  nodes: CopySnapshotNode[];
  rootName: string;
  objectCount: number;
  fileCount: number;
  folderCount: number;
  totalBytes: bigint;
  /** Frozen old-id parent relation; the source root is represented by null. */
  parentByResourceId: ReadonlyMap<string, string | null>;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function rid(value: string): string {
  try {
    return normalizeResourceId(value);
  } catch (error) {
    if (error instanceof PathError) throw new GfsError("path_invalid", error.message);
    throw error;
  }
}

function validName(raw: string): string {
  try {
    return normalizeResourceName(raw);
  } catch (error) {
    if (error instanceof ResourceNameError) throw new GfsError("path_invalid", error.message);
    throw error;
  }
}

function failStructure(message: string): never {
  throw new GfsError("precondition_failed", message);
}

function assertDeadline(input: CopyPreflightInput): void {
  if (!Number.isFinite(input.deadlineAtMs) || !Number.isFinite(input.nowMs)) {
    throw new GfsError("path_invalid", "copy deadline must be finite");
  }
  if (input.nowMs >= input.deadlineAtMs) {
    throw new GfsError("precondition_failed", "synchronous copy deadline exceeded");
  }
}

function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GfsError("path_invalid", `${name} must be a positive safe integer`);
  }
}

function canonicalAbsolutePath(path: string): string {
  if (!path.startsWith("/") || (path.length > 1 && path.endsWith("/")) || path.includes("//")) {
    failStructure("copy snapshot contains a non-canonical path");
  }
  if (path === "/") return path;
  const segments = path.slice(1).split("/").map(validName);
  const canonical = `/${segments.join("/")}`;
  if (canonical !== path) failStructure("copy snapshot contains a non-canonical path");
  return canonical;
}

function childPath(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

/**
 * Validate a frozen recursive copy snapshot without allocating identities or
 * touching blob storage. All comparisons use canonical rids while the returned
 * nodes retain the database values needed for the later transactional recheck.
 */
export function preflightCopy(input: CopyPreflightInput): CopyPreflightPlan {
  if (typeof input.drive !== "string" || input.drive.length === 0) {
    throw new GfsError("path_invalid", "copy drive must be a non-empty string");
  }
  assertDeadline(input);
  assertLimit("maxObjects", input.maxObjects);
  assertLimit("maxBytes", input.maxBytes);

  const sourceId = rid(input.sourceResourceId);
  const destinationId = rid(input.destinationParentId);
  if (input.snapshot.length === 0) {
    throw new GfsError("not_found", "copy source not found");
  }
  if (input.snapshot.length > input.maxObjects) {
    throw new GfsError("payload_too_large", "copy exceeds the configured synchronous limits");
  }
  if (input.destination.ancestors.length === 0) {
    throw new GfsError("not_found", "copy destination not found");
  }

  const nodes = [...input.snapshot].sort((a, b) => a.depth - b.depth || rid(a.resourceId).localeCompare(rid(b.resourceId)));
  const byId = new Map<string, CopySnapshotNode>();
  const parentByResourceId = new Map<string, string | null>();
  let totalBytes = 0n;
  let fileCount = 0;
  let folderCount = 0;

  for (const node of nodes) {
    const nodeId = rid(node.resourceId);
    if (byId.has(nodeId)) failStructure("copy snapshot contains a duplicate resource id or cycle");
    byId.set(nodeId, node);
    if (node.cycle) failStructure("copy source contains a parent cycle");
    if (node.underTombstone) failStructure("copy source contains a live node below a tombstone");
    if (node.drive !== input.drive) throw new GfsError("cross_boundary", "copy source crosses drive boundary");
    if (node.deletedAt !== null) failStructure("copy source changed or contains a tombstone");
    if (!Number.isSafeInteger(node.version) || node.version < 0) failStructure("copy source has an invalid version");
    if (!Number.isSafeInteger(node.depth) || node.depth < 0) failStructure("copy snapshot has an invalid depth");
    if (node.kind !== "file" && node.kind !== "directory") failStructure("copy source has an invalid kind");
    if (node.name !== node.name.normalize("NFC")) failStructure("copy source contains a non-canonical name");
    if (nodeId !== sourceId || node.depth !== 0) validName(node.name);

    if (node.kind === "file") {
      if (node.bytes < 0n) failStructure("copy source has a negative file size");
      totalBytes += node.bytes;
      if (totalBytes > MAX_SAFE_BIGINT) {
        throw new GfsError("payload_too_large", "copy byte total exceeds safe integer precision");
      }
      fileCount += 1;
    } else {
      if (node.bytes !== 0n) failStructure("copy source directory has physical bytes");
      folderCount += 1;
    }
  }

  const root = byId.get(sourceId);
  if (!root || root.depth !== 0) failStructure("copy snapshot root does not match the requested source");
  if (nodes.filter(node => node.depth === 0).length !== 1) failStructure("copy snapshot has multiple roots");
  if (input.ifMatch === undefined || input.ifMatch !== root.version) {
    throw new GfsError("precondition_failed", "copy source If-Match is required and must match the root version");
  }

  if (root.pathCache === null) failStructure("copy source has no canonical path");
  const rootPath = canonicalAbsolutePath(root.pathCache);
  if (root.parentResourceId === null) {
    if (root.name !== "" || rootPath !== "/") failStructure("copy source drive root is non-canonical");
  } else if (rootPath.split("/").at(-1) !== root.name) {
    failStructure("copy source root path does not match its name");
  }

  for (const node of nodes) {
    const nodeId = rid(node.resourceId);
    if (nodeId === sourceId) {
      parentByResourceId.set(nodeId, null);
      continue;
    }
    if (node.parentResourceId === null) failStructure("copy snapshot contains a disconnected root");
    const parentId = rid(node.parentResourceId);
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "directory" || parent.depth + 1 !== node.depth) {
      failStructure("copy snapshot contains an invalid parent map");
    }
    if (node.pathCache === null || parent.pathCache === null || node.pathCache !== childPath(parent.pathCache, node.name)) {
      failStructure("copy source path cache is stale");
    }
    parentByResourceId.set(nodeId, parentId);
  }

  const ancestorIds = new Set<string>();
  const ancestors = [...input.destination.ancestors].sort((a, b) => a.depth - b.depth);
  for (const ancestor of ancestors) {
    const ancestorId = rid(ancestor.resourceId);
    if (ancestorIds.has(ancestorId) || ancestor.cycle) failStructure("copy destination contains a parent cycle");
    ancestorIds.add(ancestorId);
    if (ancestor.drive !== input.drive) throw new GfsError("cross_boundary", "copy destination crosses drive boundary");
    if (ancestor.deletedAt !== null) failStructure("copy destination changed or contains a tombstone");
    if (!Number.isSafeInteger(ancestor.version) || ancestor.version < 0) failStructure("copy destination has an invalid version");
    if (ancestor.kind !== "directory") throw new GfsError("not_a_directory", "copy destination is not a directory");
    if (ancestor.name !== ancestor.name.normalize("NFC")) failStructure("copy destination contains a non-canonical name");
  }
  const destination = ancestors.find(node => rid(node.resourceId) === destinationId && node.depth === 0);
  if (!destination) failStructure("copy destination snapshot does not match the requested parent");
  for (let index = 0; index < ancestors.length; index += 1) {
    const node = ancestors[index];
    if (index === ancestors.length - 1) {
      if (node.parentResourceId !== null || node.name !== "" || node.pathCache !== "/") failStructure("copy destination has no canonical drive root");
    } else {
      const next = ancestors[index + 1];
      if (node.parentResourceId === null || rid(node.parentResourceId) !== rid(next.resourceId) || next.depth !== node.depth + 1) {
        failStructure("copy destination ancestry is incomplete");
      }
      validName(node.name);
      if (node.pathCache === null || next.pathCache === null || node.pathCache !== childPath(next.pathCache, node.name)) {
        failStructure("copy destination path cache is stale");
      }
    }
  }

  if (byId.has(destinationId)) {
    throw new GfsError("path_invalid", "copy destination cannot be the source or its descendant");
  }

  const rootName = validName(input.newName ?? root.name);
  const childIds = new Set<string>();
  for (const child of input.destination.liveChildren) {
    const childId = rid(child.resourceId);
    if (childIds.has(childId)) failStructure("copy destination children contain duplicate resource ids");
    childIds.add(childId);
    if (child.name !== child.name.normalize("NFC")) failStructure("copy destination contains a non-canonical child name");
    validName(child.name);
    if (child.name === rootName) {
      // Accepted trade-off (adversarial review, issue #797): returning
      // `already_exists` confirms to a caller holding write-but-not-read on the
      // destination that one attacker-chosen name exists here — the classic
      // POSIX EEXIST create oracle. The leaked bit is low value (the caller
      // already holds write on the destination and supplies the name), so copy
      // intentionally does not additionally require read on the destination
      // parent, keeping the capability gate (read source + write dest) simple.
      throw new GfsError("already_exists", `a resource named '${rootName}' already exists here`);
    }
  }

  if (totalBytes > BigInt(input.maxBytes)) {
    throw new GfsError("payload_too_large", "copy exceeds the configured synchronous limits");
  }

  return {
    nodes,
    rootName,
    objectCount: nodes.length,
    fileCount,
    folderCount,
    totalBytes,
    parentByResourceId,
  };
}
