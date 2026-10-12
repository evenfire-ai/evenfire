import type { DbClient } from '../db.js'

const NAMESPACE_RENAMES = [
  ['admin_codex_read:', 'admin_subscription_read:'],
  ['admin_codex_write:', 'admin_subscription_write:'],
  ['codex_oauth_callback:', 'subscription_oauth_callback:'],
] as const

/** Existing opaque long-key digests cannot be backfilled from their hashes. */
export function legacyAdministrativeRateLimitHashInput(key: string): string {
  for (const [legacy, current] of NAMESPACE_RENAMES) {
    if (key.startsWith(current)) return legacy + key.slice(current.length)
  }
  return key
}

/**
 * Preserve active quota accounting across the provider-neutral rename.
 * initDb holds a transaction and migration advisory lock. The table lock
 * serializes the backfill with increments; the invoker trigger also routes
 * older binaries to the same rows during rolling updates and rollback.
 * Legacy provider spellings are intentionally confined to this compatibility
 * boundary. Retire the trigger only after older writers/rollback are retired.
 */
export async function applyAdminSubscriptionRateLimitNamespace(db: DbClient): Promise<void> {
  const cases = NAMESPACE_RENAMES.map(
    ([legacy, current], index) => `
    ${index === 0 ? 'IF' : 'ELSIF'} left(input_key, ${legacy.length}) = '${legacy}' THEN
      canonical_key := '${current}' || substring(input_key FROM ${legacy.length + 1});
    ELSIF left(input_key, ${current.length}) = '${current}' THEN
      legacy_input := '${legacy}' || substring(input_key FROM ${current.length + 1});
  `
  ).join('\n')
  await db.query(`
    LOCK TABLE rate_limit_buckets IN ACCESS EXCLUSIVE MODE;

    CREATE OR REPLACE FUNCTION public.canonical_admin_subscription_bucket_key(input_key TEXT)
    RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
    SET search_path = pg_catalog AS $$
    DECLARE
      canonical_key TEXT := input_key;
      legacy_input TEXT := input_key;
    BEGIN
      ${cases}
      ELSE
        RETURN input_key;
      END IF;
      IF octet_length(canonical_key) > 512 THEN
        RETURN 'sha256-long-key:' || encode(sha256(convert_to(legacy_input, 'UTF8')), 'hex');
      END IF;
      RETURN canonical_key;
    END;
    $$;

    INSERT INTO rate_limit_buckets (bucket_key, window_start_ms, count)
    SELECT public.canonical_admin_subscription_bucket_key(bucket_key),
           window_start_ms, SUM(count)::INTEGER
    FROM rate_limit_buckets
    WHERE public.canonical_admin_subscription_bucket_key(bucket_key) <> bucket_key
    GROUP BY public.canonical_admin_subscription_bucket_key(bucket_key), window_start_ms
    ON CONFLICT (bucket_key, window_start_ms)
    DO UPDATE SET count = rate_limit_buckets.count + EXCLUDED.count;
    DELETE FROM rate_limit_buckets
    WHERE public.canonical_admin_subscription_bucket_key(bucket_key) <> bucket_key;

    CREATE OR REPLACE FUNCTION public.normalize_admin_subscription_bucket_key()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog AS $$
    BEGIN
      NEW.bucket_key := public.canonical_admin_subscription_bucket_key(NEW.bucket_key);
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS normalize_admin_subscription_bucket_key ON rate_limit_buckets;
    CREATE TRIGGER normalize_admin_subscription_bucket_key
    BEFORE INSERT OR UPDATE ON rate_limit_buckets
    FOR EACH ROW EXECUTE FUNCTION public.normalize_admin_subscription_bucket_key();
  `)
}
