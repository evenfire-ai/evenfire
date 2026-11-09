import { Pool, type PoolConfig } from "pg";

/** Writes one log line (the service's `[gfsc]`-prefixed stderr lines). */
export type PoolErrorLog = (message: string) => void;

/** The `error` event surface of a pg Client or Pool. */
export interface ErrorEventSource {
  on(event: "error", listener: (err: Error) => void): unknown;
  removeListener(event: "error", listener: (err: Error) => void): unknown;
}

function describePgError(err: unknown): string {
  // Never log the error object itself: pg-pool attaches the client (with its
  // connection parameters) as `err.client` before it emits.
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  // One line per event: strip CR/LF so a driver message cannot forge lines.
  // (api/serve.ts sanitizeForLog is not imported: serve.ts reaches this module
  // through permissionClient -> deadlineQuery, which would make a cycle.)
  return (typeof code === "string" ? `${code} ${message}` : message).replace(/[\r\n]+/g, " ").slice(0, 512);
}

/**
 * Creates the service's pg Pool with an `error` listener attached.
 *
 * pg-pool listens for `error` on every idle client. When the backend ends an
 * idle connection (a Postgres restart sends 57P01 `terminating connection due
 * to administrator command`), pg-pool removes that client from the pool, ends
 * it, and re-emits the error on the pool (`pg-pool/index.js:51-63`). A pool
 * with no `error` listener turns that emit into an uncaught exception, which
 * crashed every gfsc pod on every Postgres restart (issue #700).
 *
 * The listener only logs. Nothing is lost: the broken client is already out of
 * the pool, and the next checkout opens a new connection (`pg-pool/index.js:241`).
 */
export function createGfsPool(
  connectionString: string,
  log: PoolErrorLog,
  PoolClass: new (config: PoolConfig) => Pool = Pool
): Pool {
  const pool = new PoolClass({ connectionString });
  pool.on("error", (err) => {
    log(`[gfsc] pg pool discarded an idle client after a connection error: ${describePgError(err)}`);
  });
  return pool;
}

/** The first `error` a client emitted, and the listener's removal. */
export interface ClientErrorListener {
  readonly error: Error | undefined;
  detach(): void;
}

/**
 * Holds an `error` listener on a pg client until `detach()`.
 *
 * pg emits `error` on a connected client when its connection fails: always
 * when no query is active, and also alongside the failed query on an
 * unexpected socket end (`pg/lib/client.js:198-218`, `:411-430`). With no
 * listener that emit is an uncaught exception. A pooled client has none while
 * it is checked out: pg-pool removes its idle listener at checkout and adds it
 * back on release (`pg-pool/index.js:344`, `:385`). A standalone Client has
 * none unless its owner adds one.
 *
 * The listener records the error and nothing else, so the caller must surface
 * it. pg already rejects the in-flight query, and every later query on the
 * client fails because pg marks it not queryable (`pg/lib/client.js:415`,
 * `:700-704`). A pooled caller passes `error` to `release()` so pg-pool
 * destroys the connection. Same approach as control-api `src/db.ts`
 * (`withTransaction`).
 */
export function holdClientErrorListener(client: ErrorEventSource): ClientErrorListener {
  let first: Error | undefined;
  const onError = (err: unknown): void => {
    first ??= err instanceof Error ? err : new Error(String(err));
  };
  client.on("error", onError);
  return {
    get error() {
      return first;
    },
    detach() {
      client.removeListener("error", onError);
    },
  };
}
