import type { DbClient } from '../../db.js'
import { PR2_READINESS_CONTRACT_VERSION, PR2_READINESS_HOPS } from './pr2ReadinessContract.js'

export async function applyPr2ReadinessEvidenceSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pr2_readiness_activations (
      environment_id TEXT PRIMARY KEY,
      source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
      accepted_by TEXT NOT NULL CHECK (char_length(accepted_by) BETWEEN 1 AND 255),
      accepted_at TIMESTAMPTZ NOT NULL,
      max_runtime_evidence_age_seconds INTEGER NOT NULL
        CHECK (max_runtime_evidence_age_seconds BETWEEN 1 AND 86400),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (environment_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$')
    );

    CREATE TABLE IF NOT EXISTS pr2_readiness_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      environment_id TEXT NOT NULL
        REFERENCES pr2_readiness_activations(environment_id) ON DELETE CASCADE,
      source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
      hop TEXT NOT NULL CHECK (hop IN (${PR2_READINESS_HOPS.map(h => `'${h}'`).join(', ')})),
      evidence_class TEXT NOT NULL CHECK (evidence_class IN ('build', 'runtime')),
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
        'exact_head_ci', 'producer_contract', 'static_analysis', 'real_postgres',
        'deployment_render', 'service_runtime'
      )),
      writer_principal TEXT NOT NULL CHECK (writer_principal IN (
        'operator-build-importer', 'control-api', 'external-rest-api', 'rpc-proxy',
        'mcp-host', 'workflow-recipes', 'gfs-controller', 'workspace-files-controller'
      )),
      evidence_reference TEXT NOT NULL CHECK (char_length(evidence_reference) BETWEEN 1 AND 255),
      outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'withdrawn')),
      service_version TEXT NOT NULL CHECK (char_length(service_version) BETWEEN 1 AND 127),
      contract_version TEXT NOT NULL CHECK (contract_version = '${PR2_READINESS_CONTRACT_VERSION}'),
      deployment_revision TEXT NULL CHECK (
        deployment_revision IS NULL OR char_length(deployment_revision) BETWEEN 1 AND 127
      ),
      image_revision TEXT NULL CHECK (
        image_revision IS NULL OR char_length(image_revision) BETWEEN 1 AND 127
      ),
      observed_at TIMESTAMPTZ NOT NULL,
      invalidated_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (environment_id, source_revision, hop, evidence_class, evidence_kind, writer_principal),
      CHECK (
        (evidence_class = 'build' AND writer_principal = 'operator-build-importer'
          AND evidence_kind <> 'service_runtime') OR
        (evidence_class = 'runtime' AND writer_principal <> 'operator-build-importer'
          AND evidence_kind = 'service_runtime')
      )
    );
    CREATE INDEX IF NOT EXISTS pr2_readiness_evidence_assembly_idx
      ON pr2_readiness_evidence (environment_id, source_revision, hop, evidence_class);
  `)
}
