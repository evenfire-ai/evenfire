import { AppService } from '../../../../src/appService.js'
import {
  GfsClient,
  type GfsHeldAffordances,
  type GfsTransport,
} from '../../../../src/gfs/uriHandler.js'

/**
 * Route-shaped held-bit inputs pass through the real Desktop GfsClient and
 * AppService.gfsAffordances producer before a renderer consumer sees them.
 * The control-api authority response is deliberately transport-controlled here;
 * this fixture does not execute the server's heldPermissions ACL evaluation.
 */
export function appServiceAffordanceProducer(
  resolveHeld: (resourceId: string) => Promise<GfsHeldAffordances>
) {
  const transport: GfsTransport = {
    baseUrl: 'https://control-api.fixture.test',
    requestJson: async <T>(_method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string) => {
      const match = /\/resources\/([^/]+)\/affordances/.exec(new URL(url).pathname)
      const targetResourceId = match?.[1]
      if (!targetResourceId) throw new Error(`Unexpected affordance URL: ${url}`)
      return (await resolveHeld(decodeURIComponent(targetResourceId))) as T
    },
    fetchBytes: async () => new ArrayBuffer(0),
  }
  const service = Object.create(AppService.prototype) as AppService
  Object.assign(service, {
    gfsClient: new GfsClient(transport),
    sessionToken: 'fixture-session-token',
  })
  return (resourceId: string, drive = 'main') => service.gfsAffordances(resourceId, drive)
}

export function heldPermissionResponse(held: string[], isOperator = false): GfsHeldAffordances {
  return { held, isOperator }
}
