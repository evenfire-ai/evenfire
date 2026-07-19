import { describe, expect, it, vi } from 'vitest'
import express, { type RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import {
  createTracingInFlightLimiter,
  requireAdministrativeEventSubmitter,
  requireAgentRunEventSubmitter,
  requireInfrastructureTelemetrySubmitter,
} from '../src/middleware/tracingSubmitterAuth.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

type SubmitterProperty =
  | 'agentRunEventSubmitter'
  | 'administrativeEventSubmitter'
  | 'infrastructureTelemetrySubmitter'

function signInternalControl(
  issuer: 'hcc' | 'wrc',
  options: { subject?: string; audience?: string; scope?: string } = {}
): string {
  return jwt.sign(
    {
      iss: issuer,
      aud: options.audience ?? 'control-api',
      sub: options.subject ?? `${issuer}-provisioner`,
      scope: options.scope,
    },
    issuer === 'hcc'
      ? config.internalControlJwtHccHmacSecret
      : config.internalControlJwtWrcHmacSecret,
    {
      algorithm: 'HS256',
      expiresIn: 60,
      jwtid: `${issuer}-${options.subject ?? 'provisioner'}`,
    }
  )
}

function makeGuardApp(guard: RequestHandler, property: SubmitterProperty) {
  const app = express()
  app.post('/test', guard, (req, res) => res.json(req[property]))
  return app
}

describe('tracing submitter auth', () => {
  it('fails fast when the per-replica tracing in-flight budget is exhausted', async () => {
    const app = express()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const handler = vi.fn(async (_req, res) => {
      await firstBlocked
      res.status(204).end()
    })
    app.post('/test', createTracingInFlightLimiter(1), handler)

    const first = request(app)
      .post('/test')
      .then(response => response)
    while (handler.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    const rejected = await request(app).post('/test')
    expect(rejected.status).toBe(503)
    expect(rejected.body).toEqual({ error: 'tracing_capacity_exhausted' })
    expect(rejected.headers['retry-after']).toBe('1')

    releaseFirst()
    expect((await first).status).toBe(204)
    expect(
      (
        await request(app)
          .post('/test')
          .then(response => {
            releaseFirst()
            return response
          })
      ).status
    ).toBe(204)
  })
  it('accepts the existing runtime access JWT for agent-run submission only', async () => {
    const { token } = issueMcpHostAccessJwt('sandbox-recipes', 'trace-recipe', ['host-a'])
    const agentApp = makeGuardApp(requireAgentRunEventSubmitter, 'agentRunEventSubmitter')

    const agentAllowed = await request(agentApp)
      .post('/test')
      .set('Authorization', `Bearer ${token}`)

    expect(agentAllowed.status).toBe(200)
    expect(agentAllowed.body.sourceService).toBe('mcp-host')
    expect(agentAllowed.body.hostRefs).toEqual(['host-a'])

    const administrativeApp = makeGuardApp(
      requireAdministrativeEventSubmitter,
      'administrativeEventSubmitter'
    )
    const denied = await request(administrativeApp)
      .post('/test')
      .set('Authorization', `Bearer ${token}`)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'tracing_submission_forbidden' })
  })

  it('accepts exact WRC InternalControl for workflow agent-run lifecycle only', async () => {
    const app = makeGuardApp(requireAgentRunEventSubmitter, 'agentRunEventSubmitter')
    const response = await request(app)
      .post('/test')
      .set('Authorization', `Bearer ${signInternalControl('wrc')}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      kind: 'wrc_internal_control',
      sourceService: 'workflow-recipes',
      serviceSub: 'wrc-provisioner',
      allowedEventTypes: ['run_start', 'run_end'],
    })
  })

  it('does not let exact HCC InternalControl submit agent-run evidence', async () => {
    const app = makeGuardApp(requireAgentRunEventSubmitter, 'agentRunEventSubmitter')
    const response = await request(app)
      .post('/test')
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)

    expect(response.status).toBe(403)
  })

  it.each([
    ['hcc', 'hcc_internal_control', ['linked_outcome']],
    ['wrc', 'wrc_internal_control', ['linked_outcome', 'service_action']],
  ] as const)(
    'normalizes exact %s administrative authority',
    async (issuer, kind, allowedKinds) => {
      const app = makeGuardApp(requireAdministrativeEventSubmitter, 'administrativeEventSubmitter')
      const response = await request(app)
        .post('/test')
        .set('Authorization', `Bearer ${signInternalControl(issuer)}`)

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ kind, allowedKinds })
    }
  )

  it.each([
    ['hcc', 'hcc_internal_control', 'hcc_managed', undefined],
    [
      'wrc',
      'wrc_internal_control',
      'wrc_managed',
      ['lifecycle_transition', 'reconcile_outcome', 'controller_error'],
    ],
  ] as const)(
    'normalizes exact %s infrastructure authority',
    async (issuer, kind, resourceAuthority, allowedTelemetryTypes) => {
      const app = makeGuardApp(
        requireInfrastructureTelemetrySubmitter,
        'infrastructureTelemetrySubmitter'
      )
      const response = await request(app)
        .post('/test')
        .set('Authorization', `Bearer ${signInternalControl(issuer)}`)

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ kind, resourceAuthority })
      if (allowedTelemetryTypes) {
        expect(response.body.allowedTelemetryTypes).toEqual(allowedTelemetryTypes)
        expect(response.body.allowedTelemetryTypes).not.toContain('capacity_sample')
        expect(response.body.allowedTelemetryTypes).not.toContain('usage_sample')
      }
    }
  )

  it('rejects a valid internal JWT with a generic subject even when it claims write scope', async () => {
    const scopedGenericToken = signInternalControl('wrc', {
      subject: 'service:trace-forwarder',
      scope: 'agent-run-events:write infrastructure-telemetry-events:write',
    })

    for (const [guard, property] of [
      [requireAgentRunEventSubmitter, 'agentRunEventSubmitter'],
      [requireAdministrativeEventSubmitter, 'administrativeEventSubmitter'],
      [requireInfrastructureTelemetrySubmitter, 'infrastructureTelemetrySubmitter'],
    ] as const) {
      const response = await request(makeGuardApp(guard, property))
        .post('/test')
        .set('Authorization', `Bearer ${scopedGenericToken}`)
      expect(response.status).toBe(403)
    }
  })

  it('rejects missing credentials and an exact subject with the wrong audience as 403', async () => {
    const app = makeGuardApp(requireAgentRunEventSubmitter, 'agentRunEventSubmitter')
    expect((await request(app).post('/test')).status).toBe(403)

    const wrongAudience = signInternalControl('wrc', { audience: 'other-service' })
    const response = await request(app)
      .post('/test')
      .set('Authorization', `Bearer ${wrongAudience}`)
    expect(response.status).toBe(403)
  })
})
