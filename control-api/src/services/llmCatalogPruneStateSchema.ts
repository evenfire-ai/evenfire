import type { DbClient } from '../db.js'
import { PROVIDER_KEY_MAP } from './modelsDevClient.js'

/**
 * State the catalog prune and the attention feed read on `llm_allowed_models`,
 * plus the prune's own run log, in two migrations.
 *
 * The first only adds the columns, in one ALTER TABLE: it is the only statement
 * of the change that needs an AccessExclusiveLock on `llm_allowed_models`, and
 * it holds it for a catalog update only (constant defaults, so no rewrite; the
 * CHECK is NOT VALID, so no scan). The lock waits at most 2 s behind the
 * readers the previous image keeps running; a timeout fails the migration
 * whole and the Job retries it. Anything slower (the scan that validates the
 * CHECK, the backfills) belongs to the second, which takes no lock that blocks
 * readers.
 */
export async function applyLlmCatalogPruneColumnsSchema(db: DbClient): Promise<void> {
  // Short on purpose: while it waits, every new reader of the table queues
  // behind it (admin routes, Host validation, the plugin-workload gate, the
  // ConfigMap publisher).
  await db.query(`SET LOCAL lock_timeout = '2s'`)
  // - enabled_managed_by: who decided the current `enabled`. 'catalog' rows may
  //   be pruned and re-enabled by the sync; 'operator' rows never are. The
  //   default is the safe side: a row nobody classifies stays the operator's,
  //   including every row an image without this column inserts.
  // - auto_disabled_at: set only by the prune. It is the token that lets the
  //   sync turn the row back on if the model returns to the catalog.
  // - stale_since / stale_episode / deprecated_episode: kept by the trigger of
  //   the next migration. The episodes are `integer`, not `bigint`: node-pg
  //   returns int8 as a string, and the attention feed compares the episode an
  //   operator acknowledged with `===`.
  // - attention_ack: per-kind acknowledgement of an attention item.
  // The runtime's table-level DML grant on llm_allowed_models covers the new
  // columns.
  // No IF NOT EXISTS: the statement is atomic, it runs once per database, and
  // a database that already has the columns (an earlier head of this change)
  // records this migration through its legacy alias without running it.
  await db.query(`
    ALTER TABLE llm_allowed_models
      ADD COLUMN enabled_managed_by TEXT NOT NULL DEFAULT 'operator',
      ADD COLUMN auto_disabled_at TIMESTAMPTZ NULL,
      ADD COLUMN stale_since TIMESTAMPTZ NULL,
      ADD COLUMN stale_episode INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN deprecated_episode INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN attention_ack JSONB NULL,
      ADD CONSTRAINT llm_allowed_models_enabled_managed_by_check
        CHECK (enabled_managed_by IN ('catalog', 'operator')) NOT VALID;
  `)
}

/**
 * The rest of the state, none of it blocking plain readers of
 * `llm_allowed_models`: the whole migration holds an ExclusiveLock (writers and
 * row-locking reads wait, plain SELECTs do not), which covers VALIDATE
 * CONSTRAINT, the backfills and CREATE OR REPLACE TRIGGER (a DROP TRIGGER would
 * take an AccessExclusiveLock, which is why the trigger is replaced, not
 * dropped). The statements run in this order on purpose: the backfill, then
 * the trigger. The backfill writes `stale_since` and the episode counters
 * directly; created before it, the trigger would not overwrite them (it never
 * touches a row that is not entering a state), but it would still be firing on
 * every backfilled row for nothing.
 */
export async function applyLlmCatalogPruneStateSchema(db: DbClient): Promise<void> {
  // Taken first and held to the commit, so no writer of the previous image is
  // half-way through the table while the backfill locks rows and the trigger
  // is created; asked for later, the trigger's lock deadlocks with a writer
  // waiting on a backfilled row. EXCLUSIVE, not SHARE ROW EXCLUSIVE: the
  // previous image's PUT reads its row with SELECT ... FOR UPDATE (RowShare)
  // before its UPDATE, and SHARE ROW EXCLUSIVE does not conflict with RowShare,
  // so it would be granted between the two and deadlock all the same. It also
  // keeps every write out until the trigger exists, so no row turns stale
  // without its stale_since and episode. Plain SELECTs never wait;
  // SELECT ... FOR UPDATE / FOR SHARE do.
  await db.query(`LOCK TABLE llm_allowed_models IN EXCLUSIVE MODE`)
  await db.query(`
    ALTER TABLE llm_allowed_models
      VALIDATE CONSTRAINT llm_allowed_models_enabled_managed_by_check;
  `)

  // Rows already stale start their grace period at the upgrade, which is the
  // safe side: none of them can be pruned before a full grace period passes.
  await db.query(`
    UPDATE llm_allowed_models
       SET stale_since = NOW(), stale_episode = 1
     WHERE stale AND stale_episode = 0;
    UPDATE llm_allowed_models
       SET deprecated_episode = 1
     WHERE catalog_status = 'deprecated' AND deprecated_episode = 0;
  `)

  // A row becomes 'catalog' only when nothing suggests a human chose its
  // `enabled`. The audit cannot tell whether an update changed `enabled` (it
  // stores the request body, not the previous value) and the sync writes no
  // per-model audit, so any audit row that names `enabled`, or any disable,
  // keeps the row the operator's. `discovered_at` is written only by the sync's
  // INSERT: the seeded rows 0135 handed to the sync have it NULL, and their
  // contract is that the sync never changes their `enabled`. Subscription
  // providers also use source='discovery' and are excluded by the provider list.
  // A dismissed pair is excluded too. This marks more rows 'operator' than the
  // runtime rule would; that is intended.
  await db.query(
    `UPDATE llm_allowed_models AS t
        SET enabled_managed_by = 'catalog'
      WHERE t.source = 'discovery'
        AND t.discovered_at IS NOT NULL
        AND t.provider = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM llm_catalog_dismissed d
           WHERE d.provider = t.provider AND d.model = t.model
        )
        AND NOT EXISTS (
          SELECT 1 FROM llm_allowed_models_audit a
           WHERE a.provider = t.provider AND a.model = t.model
             AND (a.action = 'disable' OR a.detail ? 'enabled')
        )`,
    [Object.keys(PROVIDER_KEY_MAP)]
  )

  // Keeps the grace clock and the episode counters for every writer of the
  // table (catalog sync, rename, subscription rebuilds) without each of them
  // knowing about it. An episode opens when a row ENTERS `stale` or
  // `deprecated`, on INSERT too, and never decreases, so an acknowledgement
  // bound to an episode reopens when the state is left and entered again.
  // `IS TRUE` / `IS NOT TRUE` make NULL count as "not in the state":
  // catalog_status is NULL for a GA model, so NULL -> 'deprecated' is an entry.
  // Outside an entry NEW is left untouched (except clearing stale_since off a
  // non-stale row), so an UPDATE that writes these columns directly is kept.
  // No table access: it runs as the invoker and needs no SECURITY DEFINER.
  await db.query(`
    CREATE OR REPLACE FUNCTION llm_allowed_models_track_episodes() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog
    AS $$
    BEGIN
      IF NEW.stale IS TRUE AND (TG_OP = 'INSERT' OR OLD.stale IS NOT TRUE) THEN
        NEW.stale_since := now();
        IF TG_OP = 'INSERT' THEN
          NEW.stale_episode := 1;
        ELSE
          NEW.stale_episode := OLD.stale_episode + 1;
        END IF;
      ELSIF NEW.stale IS NOT TRUE THEN
        NEW.stale_since := NULL;
      END IF;
      IF (NEW.catalog_status = 'deprecated') IS TRUE
         AND (TG_OP = 'INSERT' OR (OLD.catalog_status = 'deprecated') IS NOT TRUE) THEN
        IF TG_OP = 'INSERT' THEN
          NEW.deprecated_episode := 1;
        ELSE
          NEW.deprecated_episode := OLD.deprecated_episode + 1;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    REVOKE ALL ON FUNCTION llm_allowed_models_track_episodes() FROM PUBLIC;

    CREATE OR REPLACE TRIGGER llm_allowed_models_track_episodes
      BEFORE INSERT OR UPDATE ON llm_allowed_models
      FOR EACH ROW EXECUTE FUNCTION llm_allowed_models_track_episodes();
  `)

  // One row per prune run, written after the sync's transaction committed.
  // Not a column set on llm_catalog_sync_runs: that row is inserted inside the
  // sync's transaction and the runtime has no UPDATE on it. Append-only for
  // the runtime. `sync_ran_at` is the `ran_at` of the sync run it followed.
  await db.query(`
    CREATE TABLE IF NOT EXISTS llm_catalog_prune_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sync_ran_at TIMESTAMPTZ NOT NULL,
      candidates INTEGER NOT NULL DEFAULT 0 CHECK (candidates >= 0),
      prefiltered INTEGER NOT NULL DEFAULT 0 CHECK (prefiltered >= 0),
      examined_locked INTEGER NOT NULL DEFAULT 0 CHECK (examined_locked >= 0),
      pruned INTEGER NOT NULL DEFAULT 0 CHECK (pruned >= 0),
      aborted BOOLEAN NOT NULL DEFAULT false,
      abort_reason TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_catalog_prune_runs_ran_at
      ON llm_catalog_prune_runs (ran_at DESC);

    REVOKE ALL ON TABLE llm_catalog_prune_runs
      FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT ON TABLE llm_catalog_prune_runs TO control_api_runtime;
  `)
}
