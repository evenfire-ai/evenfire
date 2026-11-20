-- Frozen event function and path settings for the historical search-path upgrade case.
-- Apply only to a disposable fixture with the earlier indexed retention definitions.
    CREATE OR REPLACE FUNCTION public.governed_trace_prune_expired_events(
      requested_family text,
      batch_limit integer DEFAULT 1000
    )
    RETURNS TABLE (event_family text, event_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
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
                  WHERE (telemetry_type = ANY (ARRAY['capacity_sample'::text, 'usage_sample'::text]))
                    AND telemetry.occurred_at < cutoff_30d
                    AND (telemetry.occurred_at, telemetry.event_id) >=
                        (resume_at, COALESCE(resume_id, '00000000-0000-0000-0000-000000000000'::uuid))
                    AND telemetry.event_id IS DISTINCT FROM resume_id
                  ORDER BY telemetry.occurred_at, telemetry.event_id
                  LIMIT batch_limit)
                UNION ALL
                (SELECT telemetry.occurred_at, telemetry.event_id, cutoff_90d AS cutoff
                   FROM public.infrastructure_telemetry_events AS telemetry
                  WHERE (telemetry_type <> ALL (ARRAY['capacity_sample'::text, 'usage_sample'::text]))
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

      -- Immediate integrity constraints see both deletes at the end of the statement.
      IF requested_family = 'agent_run' THEN
        RETURN QUERY
          WITH deleted_family AS (
            DELETE FROM public.agent_run_events AS events WHERE events.event_id = ANY(selected_ids)
          )
          DELETE FROM public.governed_event_stream AS stream
           WHERE stream.event_family = requested_family AND stream.event_id = ANY(selected_ids)
           RETURNING stream.event_family, stream.event_id;
      ELSIF requested_family = 'administrative' THEN
        RETURN QUERY
          WITH deleted_family AS (
            DELETE FROM public.administrative_events AS events WHERE events.event_id = ANY(selected_ids)
          )
          DELETE FROM public.governed_event_stream AS stream
           WHERE stream.event_family = requested_family AND stream.event_id = ANY(selected_ids)
           RETURNING stream.event_family, stream.event_id;
      ELSE
        RETURN QUERY
          WITH deleted_family AS (
            DELETE FROM public.infrastructure_telemetry_events AS events WHERE events.event_id = ANY(selected_ids)
          )
          DELETE FROM public.governed_event_stream AS stream
           WHERE stream.event_family = requested_family AND stream.event_id = ANY(selected_ids)
           RETURNING stream.event_family, stream.event_id;
      END IF;
    END;
    $$;
    ALTER FUNCTION public.governed_trace_prune_expired_costs(integer)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.governed_trace_prune_expired_prompts(integer)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.governed_trace_enforce_append_only()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.governed_trace_assert_stream_integrity()
      SET search_path = pg_catalog, public, pg_temp;
