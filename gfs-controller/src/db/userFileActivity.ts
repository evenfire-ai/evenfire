import type { TxClient } from "./writeStore";

/** Minimal query surface — a pg Pool or PoolClient satisfies this. */
export interface ActivityDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * What `gfs_record_agent_file_activity` decided. `recorded` is the only status
 * that wrote rows; the other three are D18/D23 unattributed cases that record
 * nothing and let the agent's request proceed.
 */
export type AgentActivityStatus =
  | "recorded"
  | "no_binding"
  | "host_mismatch"
  | "excluded_origin"
  | "binding_without_namespace";

const STATUSES = new Set<string>([
  "recorded",
  "no_binding",
  "host_mismatch",
  "excluded_origin",
  "binding_without_namespace",
]);

/**
 * A Desktop user's content write, inside the publication transaction: the rows
 * commit with the file and roll back with it.
 */
export async function recordUserFileActivity(
  client: TxClient,
  desktopUserId: string,
  resourceIds: string[],
): Promise<void> {
  await client.query("SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])", [
    desktopUserId,
    resourceIds,
  ]);
}

/**
 * An agent's content read, write or copy, for the user its Desktop chat run is
 * bound to.
 *
 * `db` is the pool (a read: one autocommit statement, the same mode the read
 * path's own audit append uses) or the write/copy transaction client. This
 * function never opens a transaction and never checks a client out of the pool.
 * The user id is not a parameter: the function reads it from the binding row
 * control-api wrote after verifying the user's RPC token.
 */
export async function recordAgentFileActivity(
  db: ActivityDb,
  hostSubject: string,
  runId: string,
  resourceIds: string[],
): Promise<AgentActivityStatus> {
  const result = await db.query(
    "SELECT public.gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])",
    [hostSubject, runId, resourceIds],
  );
  const value = (result.rows[0] as Record<string, unknown> | undefined)
    ?.gfs_record_agent_file_activity;
  if (typeof value === "string" && STATUSES.has(value)) return value as AgentActivityStatus;
  // An unrecognised answer means the database and this service disagree about
  // the contract. Surface it instead of guessing whether rows were written.
  throw new Error(`gfs_record_agent_file_activity returned an unknown status: ${String(value)}`);
}
