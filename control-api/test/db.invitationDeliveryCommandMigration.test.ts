import { describe, expect, it, vi } from 'vitest'
import { applyInvitationDeliveryCommandFoundation } from '../src/services/directory/invitationDeliverySchema.js'

describe('invitation delivery command migration', () => {
  it('persists non-secret authorized delivery commands with bounded runtime access', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await applyInvitationDeliveryCommandFoundation({ query })

    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS invitation_delivery_commands')
    expect(sql).toContain("delivery_kind IN ('create', 'resend')")
    expect(sql).toContain("status IN ('authorized', 'delivered', 'failed', 'cancelled')")
    expect(sql).toContain('REFERENCES invitations(id) ON DELETE CASCADE')
    expect(sql).toContain("WHERE status = 'authorized'")
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE invitation_delivery_commands')
    expect(sql).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invitation_delivery_commands'
    )
    expect(sql).toContain('TO control_api_runtime')
    expect(sql).not.toContain('token')
  })
})
