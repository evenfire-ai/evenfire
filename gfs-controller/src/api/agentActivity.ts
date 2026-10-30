import type { IncomingMessage } from "node:http";
import type { AuthzContext } from "../authz/permissionClient";
import type { AgentActivityStatus } from "../db/userFileActivity";
import { LogThrottle } from "../logThrottle";
import { GfsError } from "./errors";

/** One unattributed-run line per run per minute, like the rate-limit denial line. */
export const AGENT_ACTIVITY_LOG_INTERVAL_MS = 60_000;

/**
 * Only a first-party Host can be attributed (D9/D14): the subject must be
 * `host:1st:<namespace>/<name>`, and `gfs_record_agent_file_activity` is the
 * authority that compares `<namespace>/<name>` with the run's binding.
 */
const FIRST_PARTY_HOST_SUB =
  /^host:1st:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\/[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The run id a GFS content call carries for a Desktop chat, or `undefined`.
 *
 * Absent means "this call is not attributable" and is not an error. A present
 * header must be a UUID sent by a first-party Host: a user principal cannot
 * attribute anything (control-api builds the Host's headers itself), so the
 * combination is a caller defect, not a silent no-op. Runs before authorization
 * so a malformed header never reaches the permission store.
 */
export function attributionRunOf(
  req: IncomingMessage,
  ctx: Pick<AuthzContext, "primarySubject">,
): string | undefined {
  const header = req.headers["x-gfs-attribution-run"];
  const value = typeof header === "string" ? header : undefined;
  if (value === undefined) return undefined;
  if (!UUID.test(value)) {
    throw new GfsError(
      "path_invalid",
      "x-gfs-attribution-run must be a UUID",
      "attribution_run_invalid",
    );
  }
  if (!FIRST_PARTY_HOST_SUB.test(ctx.primarySubject)) {
    throw new GfsError(
      "path_invalid",
      "x-gfs-attribution-run is only accepted from a first-party Host",
      "attribution_run_not_allowed",
    );
  }
  return value.toLowerCase();
}

/**
 * Applies the record status to the request:
 *
 * - `recorded` continues.
 * - `host_mismatch` is a 403: the run id exists but is bound to another Host, so
 *   the caller cannot claim it.
 * - `no_binding`, `binding_without_namespace` and `excluded_origin` record
 *   nothing and let the agent's request proceed, with one throttled line per run
 *   so an unattributed run is visible without flooding the log (D18, D23, D19).
 *   The line carries no user id (none is known), no resource name and no
 *   content.
 */
export class AgentActivityStatusReporter {
  private readonly throttle: LogThrottle;

  constructor(
    private readonly clock: () => number,
    intervalMs: number = AGENT_ACTIVITY_LOG_INTERVAL_MS,
  ) {
    this.throttle = new LogThrottle(intervalMs, clock);
  }

  report(status: AgentActivityStatus, requestId: string | undefined, runId: string): void {
    if (status === "recorded") return;
    if (status === "host_mismatch") {
      throw new GfsError("forbidden", "attribution run is not bound to this Host");
    }
    const suppressed = this.throttle.admit(runId);
    if (suppressed !== undefined) {
      console.warn(
        `[gfsc] agent_activity_unattributed reason=${status} request_id=${requestId ?? "-"} ` +
          `run_id=${runId} suppressed=${suppressed}`,
      );
    }
  }
}
