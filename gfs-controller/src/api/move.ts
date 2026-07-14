/**
 * Move / rename validation (spec community.md §Move, rename, delete).
 *
 * A move is a pure DB reparent — bytes live flat by resourceId, so nothing is
 * renamed or relocated on disk. This module is the writer-routed, side-effect-
 * free core that the gfs write path uses to decide whether a rename/move is
 * legal and which permission checks it requires:
 *
 *   - rename (name)   → `write` on the resource.
 *   - move  (reparent)→ `write` + `delete` on the source parent, `write` on the
 *                       destination parent. Never crosses `drive` (cross_boundary).
 *   - concurrency     → monotonic `version`; `etag = version`; a stale `If-Match`
 *                       is `precondition_failed` (writer-routed, never checked
 *                       against a possibly-stale reader replica).
 *
 * Pure — no I/O. The caller loads the rows, runs requiredChecks() against the
 * permission store, applies the DB reparent, and bumps `version`.
 */

export type GfsPermission = "read" | "write" | "delete" | "manage_acl" | "share";

export type MoveErrorCode =
  | "path_invalid"
  | "cross_boundary"
  | "precondition_failed"
  | "not_found";

export class MoveError extends Error {
  constructor(
    readonly code: MoveErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MoveError";
  }
}

/** A single (resourceId, op) authorization the caller must hold for the change. */
export interface PermissionCheck {
  resourceId: string;
  op: GfsPermission;
}

export interface MoveRequest {
  /** The resource being changed. */
  resourceId: string;
  sourceDrive: string;
  /** Current parent (null for a drive root, which cannot be moved/renamed away). */
  sourceParentId: string | null;
  /** Its current monotonic version (= etag). */
  currentVersion: number;
  /** New name (rename) — NFC-normalized + validated. */
  newName?: string;
  /** New parent + its drive (move). */
  newParentId?: string;
  destDrive?: string;
  /** R + the destination's ancestor ids — supplied for the descendant cycle check. */
  destAncestors?: string[];
  /** Optional optimistic-concurrency guard. */
  ifMatch?: number;
}

export interface MovePlan {
  kind: "rename" | "move" | "rename+move";
  /** Final name to write (validated). */
  name?: string;
  newParentId?: string;
  /** Permission checks the caller must satisfy (spec §Move). */
  checks: PermissionCheck[];
  /** version to write (currentVersion + 1). */
  nextVersion: number;
}

const NAME_MAX = 255;
/** Control characters (incl. NUL) are never valid in a name; spaces ARE valid. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

/**
 * NFC-normalize and validate a path segment. Rejects empty, `.`/`..`, any
 * slash, control chars (incl. NUL), and over-length names. Spaces ARE allowed
 * ("My Report.md") — the blob is keyed by resourceId, not name.
 */
export function normalizeName(raw: string): string {
  if (typeof raw !== "string") throw new MoveError("path_invalid", "name must be a string");
  const name = raw.normalize("NFC");
  if (
    name.length === 0 ||
    name.length > NAME_MAX ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    CONTROL_CHARS.test(name)
  ) {
    throw new MoveError("path_invalid", `invalid name: ${JSON.stringify(raw)}`);
  }
  return name;
}

/** Throw precondition_failed when a provided If-Match does not match the version. */
export function assertIfMatch(currentVersion: number, ifMatch?: number): void {
  if (ifMatch !== undefined && ifMatch !== currentVersion) {
    throw new MoveError("precondition_failed", `If-Match ${ifMatch} != version ${currentVersion}`);
  }
}

/**
 * Build the validated plan for a rename and/or move. Throws MoveError on a bad
 * name, a stale If-Match, a cross-drive move, or a no-op request. The returned
 * `checks` are exactly the spec's required permissions:
 *   rename → write on the resource;
 *   move   → write+delete on the source parent, write on the destination parent.
 */
export function planMove(req: MoveRequest): MovePlan {
  assertIfMatch(req.currentVersion, req.ifMatch);

  const wantsRename = req.newName !== undefined;
  const wantsMove = req.newParentId !== undefined;
  if (!wantsRename && !wantsMove) {
    throw new MoveError("path_invalid", "no rename or move requested");
  }

  const checks: PermissionCheck[] = [];
  let name: string | undefined;

  if (wantsRename) {
    name = normalizeName(req.newName as string);
    // rename authority is `write` on the resource itself.
    checks.push({ resourceId: req.resourceId, op: "write" });
  }

  if (wantsMove) {
    // Fail-closed: a move MUST state its destination drive — never assume the
    // source drive, or a cross-drive move with an omitted destDrive slips through.
    if (req.destDrive === undefined) {
      throw new MoveError("path_invalid", "destDrive is required for a move");
    }
    if (req.destDrive !== req.sourceDrive) {
      throw new MoveError("cross_boundary", "cross-drive move is forbidden");
    }
    if (req.sourceParentId === null) {
      throw new MoveError("path_invalid", "the drive root cannot be moved");
    }
    const dest = req.newParentId as string;
    // Cycle guard: a resource may never move into itself or its own descendants
    // (that would orphan the subtree and loop ancestor traversal). The trivial
    // self-move is checkable purely; the full descendant check uses destAncestors
    // (R + the destination's ancestors) when the caller supplies it.
    if (dest === req.resourceId || (req.destAncestors !== undefined && req.destAncestors.includes(req.resourceId))) {
      throw new MoveError("path_invalid", "cannot move a resource into its own subtree");
    }
    // move authority: write+delete on the source parent, write on the dest parent.
    checks.push({ resourceId: req.sourceParentId, op: "write" });
    checks.push({ resourceId: req.sourceParentId, op: "delete" });
    checks.push({ resourceId: dest, op: "write" });
  }

  const kind: MovePlan["kind"] =
    wantsRename && wantsMove ? "rename+move" : wantsRename ? "rename" : "move";

  return {
    kind,
    name,
    newParentId: wantsMove ? (req.newParentId as string) : undefined,
    checks,
    nextVersion: req.currentVersion + 1,
  };
}
