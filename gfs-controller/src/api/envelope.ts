import { GfsError } from "./errors";

/**
 * Standard gfsc response envelope: `{ ok: true, data }` on success,
 * `{ ok: false, error: { code, message, reason? } }` on failure. A `gone`
 * (410) carries `reason` so a tombstoned resource and an expired published
 * reference are distinguishable.
 */
export interface OkEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorBody {
  code: string;
  message: string;
  reason?: string;
  retryAfterSeconds?: number;
  limit?: string;
}

export interface ErrEnvelope {
  ok: false;
  error: ErrorBody;
}

export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function fail(error: GfsError): ErrEnvelope {
  const body: ErrorBody = { code: error.code, message: error.message };
  if (error.reason !== undefined) body.reason = error.reason;
  if (error.retryAfterSeconds !== undefined) body.retryAfterSeconds = error.retryAfterSeconds;
  if (error.limit !== undefined) body.limit = error.limit;
  return { ok: false, error: body };
}

/**
 * Map any thrown value to an envelope + HTTP status. A GfsError maps to its
 * declared code/status; anything else is an `internal` (500) — failures are
 * surfaced, never swallowed into a misleading success.
 */
export function toResponse(error: unknown): { status: number; body: ErrEnvelope } {
  if (error instanceof GfsError) {
    return { status: error.status, body: fail(error) };
  }
  // Some lower layers throw typed errors carrying a `.code` that matches the
  // envelope vocabulary (auth, blob store). Honor it when present; otherwise
  // fail loud as internal.
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "unauthorized") {
    return { status: 401, body: { ok: false, error: { code: "unauthorized", message } } };
  }
  if (code === "forbidden") {
    return { status: 403, body: { ok: false, error: { code: "forbidden", message } } };
  }
  if (code === "not_found") {
    return { status: 404, body: { ok: false, error: { code: "not_found", message } } };
  }
  if (code === "path_invalid") {
    return { status: 400, body: { ok: false, error: { code: "path_invalid", message } } };
  }
  return {
    status: 500,
    body: { ok: false, error: { code: "internal", message: "internal server error" } },
  };
}
