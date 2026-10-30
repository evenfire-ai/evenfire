import { createServer } from 'node:http'
import { AppService } from '../../../../src/appService.js'
import {
  GfsClient,
  type GfsHeldAffordances,
  type GfsTransport,
} from '../../../../src/gfs/uriHandler.js'
import { ApiError, requestJson } from '../../../../src/httpClient.js'

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

/** Produce a real HTTP ApiError that AppService/GfsClient can surface through
 *  the renderer's affordance bridge with vetted status and Retry-After markers. */
export async function affordancesApiError(
  status: number,
  body: { code: string; message: string },
  resourceId = 'fixture-parent'
): Promise<ApiError> {
  const server = createServer((_req, res) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'retry-after': '7',
    })
    res.end(JSON.stringify({ ok: false, error: body }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await requestJson(
      'GET',
      `http://127.0.0.1:${port}/api/v1/me/gfs/resources/${encodeURIComponent(resourceId)}/affordances?drive=main`,
      { token: 'fixture-session-token' }
    )
    throw new Error(`expected affordances to reject with a ${status} failure`)
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
