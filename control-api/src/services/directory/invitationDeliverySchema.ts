import type { DbClient } from '../../db.js'

export async function applyInvitationDeliveryCommandFoundation(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS invitation_delivery_commands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invitation_id UUID NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
      authorized_by UUID REFERENCES users(id) ON DELETE SET NULL,
      delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('create', 'resend')),
      status TEXT NOT NULL DEFAULT 'authorized'
        CHECK (status IN ('authorized', 'delivered', 'failed', 'cancelled')),
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      failure_code TEXT,
      CHECK (
        (status = 'authorized' AND completed_at IS NULL)
        OR (status <> 'authorized' AND completed_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS invitation_delivery_commands_authorized_idx
      ON invitation_delivery_commands (authorized_at, id)
      WHERE status = 'authorized';
    CREATE INDEX IF NOT EXISTS invitation_delivery_commands_invitation_idx
      ON invitation_delivery_commands (invitation_id, authorized_at DESC);

    REVOKE ALL PRIVILEGES ON TABLE invitation_delivery_commands
      FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invitation_delivery_commands
      TO control_api_runtime;
  `)
}
