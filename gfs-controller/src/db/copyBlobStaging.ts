import type { Readable } from "node:stream";
import { GfsError } from "../api/errors";
import { BlobVerificationError } from "../storage/blobStore";
import { generationBlobKey } from "../storage/paths";
import { discardCandidate, type PgBlobStagingStore, type StagingBlobStore } from "./blobStaging";

export type CopyBlobSource =
  | { kind: "generation"; stream: Readable }
  | { kind: "legacy_flat"; reopen: () => Promise<Readable> };

export interface StageCopiedBlobInput {
  requestId: string;
  destinationResourceId: string;
  generation: string;
  source: CopyBlobSource;
  expectedBytes: number;
  expectedSha256: string;
  deadlineAtMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

function precondition(message: string): never {
  throw new GfsError("precondition_failed", message);
}

/** Stage one copy candidate. The caller supplies one request id for the whole tree. */
export async function stageCopiedBlob(
  manifests: PgBlobStagingStore,
  blobs: StagingBlobStore,
  input: StageCopiedBlobInput
): Promise<{ blobKey: string; bytes: number; contentSha256: string }> {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0) {
    precondition("copy source size is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) {
    precondition("copy source digest is invalid");
  }
  if (!Number.isFinite(input.deadlineAtMs)) precondition("copy deadline is invalid");
  const now = input.now ?? Date.now;
  const checkDeadline = (): void => {
    input.signal?.throwIfAborted();
    if (now() >= input.deadlineAtMs) precondition("synchronous copy deadline exceeded");
  };
  checkDeadline();
  const blobKey = generationBlobKey(input.destinationResourceId, input.generation);
  const budget = { deadlineAtMs: input.deadlineAtMs, signal: input.signal, now: input.now };
  await manifests.recordStaged({
    blobKey,
    requestId: input.requestId,
    resourceId: input.destinationResourceId,
    candidateKind: "generation",
    contentSha256: input.expectedSha256,
    bytes: input.expectedBytes,
  }, budget);
  let physicalCandidateOwned = false;
  // For a legacy_flat source we own the reopened stream. writeImmutable's
  // pipeline() destroys its input once reached, but a throw BEFORE pipeline —
  // the checkDeadline() below, or writeImmutable's own parent/symlink/O_EXCL
  // guards and deadline checks firing before it pipes — would otherwise leak the
  // reopened file descriptor. Generation streams stay owned by the caller
  // (copyPublication destroys them), so only the reopened legacy stream is
  // tracked here for destruction on error. destroy() is idempotent.
  let ownedLegacyStream: Readable | undefined;
  try {
    checkDeadline();
    // Legacy rows have no committed digest. Their preflight must hash and close
    // one stream, then provide this explicit reopen callback for the copy pass.
    let stream: Readable;
    if (input.source.kind === "generation") {
      stream = input.source.stream;
    } else {
      stream = await input.source.reopen();
      ownedLegacyStream = stream;
    }
    checkDeadline();
    const options = { signal: input.signal, checkDeadline };
    const written = await blobs.writeImmutable(input.destinationResourceId, input.generation, stream, options);
    physicalCandidateOwned = true;
    if (
      written.blobKey !== blobKey ||
      written.bytes !== input.expectedBytes ||
      written.contentSha256 !== input.expectedSha256
    ) {
      precondition("copy source changed after preflight");
    }
    await blobs.verify(blobKey, input.expectedBytes, input.expectedSha256, options);
    return written;
  } catch (err) {
    // Destroy the reopened legacy stream if writeImmutable threw before its
    // pipeline() consumed it; otherwise the reopened fd leaks. No-op once piped.
    ownedLegacyStream?.destroy();
    // Reopen and write failures occur before ownership is established. Keep
    // the staged manifest for reconciliation rather than deleting a key that
    // may already belong to a committed request.
    if (physicalCandidateOwned) {
      await discardCandidate(manifests, blobs, blobKey, budget).catch(() => undefined);
    }
    if (err instanceof BlobVerificationError) precondition("copy source or staged bytes changed after preflight");
    throw err;
  }
}
