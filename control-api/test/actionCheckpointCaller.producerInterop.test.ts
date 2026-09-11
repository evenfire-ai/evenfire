import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { requireActionCheckpointCaller } from '../src/middleware/actionCheckpointCaller.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

function app() {
  const value = express()
  value.post('/checkpoint', requireActionCheckpointCaller, (req, res) => {
    res.status(200).json(req.actionCheckpointCaller)
  })
  return value
}

describe('mcp-host checkpoint caller producer interoperability', () => {
  it('accepts the real HCC runtime-access JWT producer and binds one exact Host', async () => {
    const issued = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['chatllm'])

    const response = await request(app())
      .post('/checkpoint')
      .set('authorization', `Bearer ${issued.token}`)
      .expect(200)

    expect(response.body).toEqual({
      service: 'mcp-host',
      trustPlane: 'mcp_host_runtime_jwt',
      permittedResource: { type: 'host', logicalId: `${config.hostsNamespace}/chatllm` },
    })
  })

  it('accepts the real WRC runtime-access JWT producer only at its recipe binding', async () => {
    const issued = issueMcpHostAccessJwt('sandbox-recipes', 'report-recipe', [
      'sandbox-recipes/report-recipe',
    ])

    const response = await request(app())
      .post('/checkpoint')
      .set('authorization', `Bearer ${issued.token}`)
      .expect(200)

    expect(response.body.permittedResource).toEqual({
      type: 'workflow_recipe',
      logicalId: 'sandbox-recipes/report-recipe',
    })
  })

  it('rejects a real signed runtime token with an ambiguous resource list', async () => {
    const issued = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['chatllm', 'other'])

    await request(app())
      .post('/checkpoint')
      .set('authorization', `Bearer ${issued.token}`)
      .expect(401, { error: 'Unauthorized' })
  })
})
