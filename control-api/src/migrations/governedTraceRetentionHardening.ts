import type { DbClient } from '../db.js'
import { TELEMETRY_RETENTION_PREDICATES } from './governedTraceRetention.js'

export const GOVERNED_TRACE_RETENTION_HARDENING_MIGRATION =
  '0158_governed_trace_retention_hardening'

export async function applyGovernedTraceRetentionHardening(db: DbClient): Promise<void> {
  // Install the final definitions in place on databases with the indexed retention migration.
  await db.query(`
    CREATE OR REPLACE FUNCTION public.governed_trace_prune_expired_events(
      requested_family text,
      batch_limit integer DEFAULT 1000
    )
    RETURNS TABLE (event_family text, event_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
    DECLARE
      prune_time timestamptz;
      cutoff_30d timestamptz;
      cutoff_90d timestamptz;
      selected_ids uuid[];
      resume_at timestamptz := '-infinity';
      resume_id uuid;
      examined_in_page integer;
      candidate record;
      locked_id uuid;
    BEGIN
      IF requested_family IS NULL
         OR requested_family NOT IN ('agent_run', 'administrative', 'infrastructure_telemetry') THEN
        RAISE EXCEPTION 'unsupported governed event family: %', requested_family;
      END IF;
      IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'governed trace retention batch must be between 1 and 1000';
      END IF;

      prune_time := clock_timestamp();
      cutoff_90d := prune_time - INTERVAL '90 days';

      IF requested_family = 'infrastructure_telemetry' THEN
        cutoff_30d := prune_time - INTERVAL '30 days';
        selected_ids := ARRAY[]::uuid[];
        LOOP
          examined_in_page := 0;
          -- Bound each input before sorting. Acquire row locks only as each page is consumed.
          FOR candidate IN
            SELECT queued.occurred_at, queued.event_id, queued.cutoff
              FROM (
                (SELECT telemetry.occurred_at, telemetry.event_id, cutoff_30d AS cutoff
                   FROM public.infrastructure_telemetry_events AS telemetry
                  WHERE ${TELEMETRY_RETENTION_PREDICATES.samples}
                    AND telemetry.occurred_at < cutoff_30d
                    AND (telemetry.occurred_at, telemetry.event_id) >=
                        (resume_at, COALESCE(resume_id, '00000000-0000-0000-0000-000000000000'::uuid))
                    AND telemetry.event_id IS DISTINCT FROM resume_id
                  ORDER BY telemetry.occurred_at, telemetry.event_id
                  LIMIT batch_limit)
                UNION ALL
                (SELECT telemetry.occurred_at, telemetry.event_id, cutoff_90d AS cutoff
                   FROM public.infrastructure_telemetry_events AS telemetry
                  WHERE ${TELEMETRY_RETENTION_PREDICATES.other}
                    AND telemetry.occurred_at < cutoff_90d
                    AND (telemetry.occurred_at, telemetry.event_id) >=
                        (resume_at, COALESCE(resume_id, '00000000-0000-0000-0000-000000000000'::uuid))
                    AND telemetry.event_id IS DISTINCT FROM resume_id
                  ORDER BY telemetry.occurred_at, telemetry.event_id
                  LIMIT batch_limit)
              ) AS queued
             ORDER BY queued.occurred_at, queued.event_id
             LIMIT batch_limit
          LOOP
            examined_in_page := examined_in_page + 1;
            resume_at := candidate.occurred_at;
            resume_id := candidate.event_id;

            SELECT stream.event_id INTO locked_id
              FROM public.governed_event_stream AS stream
             WHERE stream.event_family = 'infrastructure_telemetry'
               AND stream.event_id = candidate.event_id
               AND stream.occurred_at < candidate.cutoff
               FOR UPDATE OF stream SKIP LOCKED;

            IF FOUND THEN
              selected_ids := array_append(selected_ids, locked_id);
              EXIT WHEN cardinality(selected_ids) = batch_limit;
            END IF;
          END LOOP;

          EXIT WHEN cardinality(selected_ids) = batch_limit OR examined_in_page < batch_limit;
        END LOOP;
      ELSE
        SELECT ARRAY(
          SELECT stream.event_id
            FROM public.governed_event_stream AS stream
           WHERE stream.event_family = requested_family
             AND stream.occurred_at < cutoff_90d
           ORDER BY stream.occurred_at, stream.stream_sequence
           LIMIT batch_limit
           FOR UPDATE OF stream SKIP LOCKED
        ) INTO selected_ids;
      END IF;

      IF cardinality(selected_ids) = 0 THEN
        RETURN;
      END IF;

      -- Immediate constraint triggers see both deletes at the end of the statement.
      IF requested_family = 'agent_run' THEN
        RETURN QUERY
          WITH deleted_family AS (
            DELETE FROM public.agent_run_events AS events WHERE events.event_id = ANY(selected_ids)
          )
          DELETE FROM public.governed_event_stream AS stream
           WHERE stream.event_family = 'agent_run' AND stream.event_id = ANY(selected_ids)
           RETURNING stream.event_family, stream.event_id;
      ELSIF requested_family = 'administrative' THEN
        RETURN QUERY
          WITH deleted_family AS (
            DELETE FROM public.administrative_events AS events WHERE events.event_id = ANY(selected_ids)
          )
          DELETE FROM public.governed_event_stream AS stream
           WHERE stream.event_family = 'administrative' AND stream.event_id = ANY(selected_ids)
           RETURNING stream.event_family, stream.event_id;
      ELSE
        RETURN QUERY
          WITH deleted_family AS (
            DELETE FROM public.infrastructure_telemetry_events AS events WHERE events.event_id = ANY(selected_ids)
          )
          DELETE FROM public.governed_event_stream AS stream
           WHERE stream.event_family = 'infrastructure_telemetry' AND stream.event_id = ANY(selected_ids)
           RETURNING stream.event_family, stream.event_id;
      END IF;
    END;
    $$;

    CREATE OR REPLACE FUNCTION public.governed_trace_prune_expired_costs(
      batch_limit INTEGER DEFAULT 1000
    )
    RETURNS TABLE (id UUID)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF batch_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'governed trace retention batch must be between 1 and 1000';
      END IF;

      RETURN QUERY
      WITH selected AS MATERIALIZED (
        SELECT daily.id
          FROM public.infrastructure_cost_daily AS daily
         WHERE daily.utc_day < (clock_timestamp() AT TIME ZONE 'UTC')::date - 365
         ORDER BY daily.utc_day, daily.id
         LIMIT batch_limit
         FOR UPDATE OF daily SKIP LOCKED
      ),
      deleted_components AS (
        DELETE FROM public.infrastructure_cost_daily_components AS component
         USING selected
         WHERE component.daily_cost_id = selected.id
         RETURNING component.daily_cost_id
      ),
      deleted_daily AS (
        DELETE FROM public.infrastructure_cost_daily AS daily
         USING selected
         WHERE daily.id = selected.id
         RETURNING daily.id
      )
      SELECT deleted_daily.id FROM deleted_daily;
    END;
    $$;

    CREATE OR REPLACE FUNCTION public.governed_trace_assert_stream_integrity()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    DECLARE
      checked_family TEXT;
      checked_event_id UUID;
      family_row_exists BOOLEAN;
      stream_row_exists BOOLEAN;
    BEGIN
      IF TG_TABLE_NAME = 'governed_event_stream' THEN
        IF TG_OP = 'DELETE' THEN
          checked_family := OLD.event_family;
          checked_event_id := OLD.event_id;
        ELSE
          checked_family := NEW.event_family;
          checked_event_id := NEW.event_id;
        END IF;
      ELSIF TG_TABLE_NAME = 'agent_run_events' THEN
        checked_family := 'agent_run';
        checked_event_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
      ELSIF TG_TABLE_NAME = 'administrative_events' THEN
        checked_family := 'administrative';
        checked_event_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
      ELSE
        checked_family := 'infrastructure_telemetry';
        checked_event_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.governed_event_stream
         WHERE event_family = checked_family AND event_id = checked_event_id
      ) INTO stream_row_exists;

      IF checked_family = 'agent_run' THEN
        SELECT EXISTS (SELECT 1 FROM public.agent_run_events WHERE event_id = checked_event_id) INTO family_row_exists;
      ELSIF checked_family = 'administrative' THEN
        SELECT EXISTS (SELECT 1 FROM public.administrative_events WHERE event_id = checked_event_id) INTO family_row_exists;
      ELSE
        SELECT EXISTS (SELECT 1 FROM public.infrastructure_telemetry_events WHERE event_id = checked_event_id) INTO family_row_exists;
      END IF;

      IF family_row_exists <> stream_row_exists THEN
        RAISE EXCEPTION 'governed event family row and stream pointer must commit together (%:%)', checked_family, checked_event_id;
      END IF;
      RETURN NULL;
    END;
    $$;

    ALTER FUNCTION public.governed_trace_enforce_append_only()
      SET search_path = pg_catalog, pg_temp;
    ALTER FUNCTION public.governed_trace_prune_expired_prompts(integer)
      SET search_path = pg_catalog, pg_temp;
  `)
}
