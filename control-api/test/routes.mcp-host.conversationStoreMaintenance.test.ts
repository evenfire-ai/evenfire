import { describe, expect, it } from 'vitest'
import { currentConversationStoreMaintenance } from '../src/routes/mcp-host/hosts-heartbeat.routes.js'

const maintenance = {
  maintenanceId: '10000000-0000-4000-8000-000000000004',
  hostUid: 'host-current',
  pvcUid: 'pvc-current',
  phase: 'quiescing',
}
const host = { metadata: { uid: 'host-current' }, status: { conversationStore: { maintenance } } }

describe('authenticated heartbeat conversation-store maintenance read', () => {
  it('returns only the controller challenge under the authenticated current Host binding', () => {
    expect(currentConversationStoreMaintenance(host, 'host-current')).toEqual(maintenance)
  })
  it.each([undefined, 'host-recreated'])(
    'refuses absent or stale authenticated Host UID: %s',
    uid => {
      expect(() => currentConversationStoreMaintenance(host, uid)).toThrow(
        'maintenance_binding_unavailable'
      )
    }
  )
  it('refuses stale controller binding and missing PVC evidence', () => {
    expect(() =>
      currentConversationStoreMaintenance(
        { ...host, metadata: { uid: 'host-recreated' } },
        'host-current'
      )
    ).toThrow('maintenance_binding_unavailable')
    const missing = {
      ...host,
      status: { conversationStore: { maintenance: { ...maintenance, pvcUid: '' } } },
    }
    expect(() => currentConversationStoreMaintenance(missing, 'host-current')).toThrow(
      'maintenance_binding_unavailable'
    )
  })
  it('preserves ordinary heartbeat responses outside active maintenance', () => {
    expect(currentConversationStoreMaintenance({}, undefined)).toBeNull()
    const released = {
      ...host,
      status: { conversationStore: { maintenance: { ...maintenance, phase: 'released' } } },
    }
    expect(currentConversationStoreMaintenance(released, undefined)).toBeNull()
  })
})
