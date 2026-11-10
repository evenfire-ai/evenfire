import { readFileSync } from 'node:fs'
import {
  LEGACY_SEEDED_ALLOWED_MODELS,
  LEGACY_SEEDED_MODEL_PRICES,
} from '../../src/data/llmCatalogLegacySeeds.js'
import type { DbClient } from '../../src/db.js'
import type { RawModelsDevCatalog } from '../../src/services/modelsDevClient.js'

/**
 * The live models.dev capture SEEDED_ALLOWED_MODELS_LISTED_BY_CATALOG was
 * derived from, frozen. The migration list is frozen with it: regenerating
 * `modelsDevLiveCatalog.json` must not change what these tests compare it to.
 */
export const CATALOG_CAPTURE_0135: { capturedAt: string; catalog: RawModelsDevCatalog } =
  JSON.parse(
    readFileSync(
      new URL('../fixtures/modelsDevLiveCatalog.2026-10-30.json', import.meta.url),
      'utf8'
    )
  )

/**
 * Re-runs the statements the retired seed migrations (0044, 0056, 0057, 0058,
 * 0100) executed, so a test can stand up the database of an installation that
 * applied them. The column lists match those statements exactly: everything
 * else comes from the column DEFAULTs, as it did then.
 */
export async function applyLegacyCatalogSeeds(db: DbClient): Promise<void> {
  await db.query(
    `INSERT INTO llm_model_prices
       (provider, model, input_token_price, output_token_price, cache_read_token_price, cache_write_token_price)
     SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
     ON CONFLICT DO NOTHING`,
    [
      LEGACY_SEEDED_MODEL_PRICES.map(r => r.provider),
      LEGACY_SEEDED_MODEL_PRICES.map(r => r.model),
      LEGACY_SEEDED_MODEL_PRICES.map(r => r.input_token_price),
      LEGACY_SEEDED_MODEL_PRICES.map(r => r.output_token_price),
      LEGACY_SEEDED_MODEL_PRICES.map(r => r.cache_read_token_price),
      LEGACY_SEEDED_MODEL_PRICES.map(r => r.cache_write_token_price),
    ]
  )
  await db.query(
    `INSERT INTO llm_allowed_models (provider, model, vendor)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     ON CONFLICT DO NOTHING`,
    [
      LEGACY_SEEDED_ALLOWED_MODELS.map(r => r.provider),
      LEGACY_SEEDED_ALLOWED_MODELS.map(r => r.model),
      LEGACY_SEEDED_ALLOWED_MODELS.map(r => r.vendor),
    ]
  )
}
