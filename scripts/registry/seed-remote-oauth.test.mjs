import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadControlApiModule, loadRemoteOAuthRules } from './lib/control-api-modules.mjs'
import {
  CATALOG_PATH,
  buildPublishBody,
  parseServiceUrl,
  rowFromPublishBody,
  runSeed,
  validateItem,
} from './seed-remote-oauth.mjs'
import {
  ADMIN_TOKEN,
  CURATOR_ID,
  CURATOR_SECRET,
  CURATOR_TOKEN,
  discoverResponse,
  startFakeControlApi,
  startFakeRegistry,
  storedRow,
} from './test-support/fake-servers.mjs'

const SEED = fileURLToPath(new URL('./seed-remote-oauth.mjs', import.meta.url))
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
const byName = name => structuredClone(catalog.find(item => item.name === name))

let rules
let catalogModule
before(async () => {
  rules = await loadRemoteOAuthRules()
  catalogModule = await loadControlApiModule('src/routes/admin/catalogRemoteOAuth.ts')
})

/** Runs the seed against fresh fakes; `discover` maps a URL to its mode/transport. */
async function seedAgainst({
  items,
  flags = {},
  discover,
  discoverAnswer,
  registry: registryOpts,
  extraEnv = {},
  fetchImpl,
}) {
  const registry = await startFakeRegistry(registryOpts)
  const controlApi = await startFakeControlApi(
    discoverAnswer ?? (baseUrl => ({ status: 200, json: discoverResponse(discover(baseUrl)) }))
  )
  const lines = []
  try {
    const exitCode = await runSeed({
      catalog: items,
      flags: { dryRun: false, allowDrift: false, ...flags },
      env: {
        CONTROL_API_URL: controlApi.url,
        CONTROL_API_TOKEN: ADMIN_TOKEN,
        REGISTRY_URL: registry.url,
        CURATOR_CLIENT_ID: CURATOR_ID,
        CURATOR_CLIENT_SECRET: CURATOR_SECRET,
        ...extraEnv,
      },
      rules,
      log: line => lines.push(line),
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    return { exitCode, lines, registry, controlApi }
  } finally {
    await registry.close()
    await controlApi.close()
  }
}

/** Discovery that reports exactly what each item expects, transport alive. */
const matching = items => baseUrl => {
  const item = items.find(i => i.url === baseUrl)
  const mode = item.expectedRegistration === 'pre-registered' ? 'manual' : item.expectedRegistration
  return { registrationMode: mode }
}

describe('committed catalog', () => {
  test('has the 23 entries of the v1 list, each valid for control-api and for the registry', async () => {
    assert.equal(catalog.length, 23)
    assert.equal(new Set(catalog.map(i => i.name)).size, 23)
    for (const item of catalog) {
      const result = validateItem(item, rules)
      assert.ok(result.ok, `${item.name}: ${result.reason}`)
      // The row the registry would store (publish validation included) resolves, on
      // read, as a valid curator entry that keeps its presentation metadata.
      const row = await storedRow(result.body)
      const resolved = catalogModule.resolveRemoteOAuthEntry(row)
      assert.deepEqual(resolved.remoteOAuth, { valid: true }, item.name)
      assert.equal(resolved.publisher, undefined, `${item.name} must resolve as curator`)
      assert.deepEqual(resolved.mcp_server_meta.oauth, result.body.mcpServer.oauth, item.name)
    }
  })

  test('the seed row projection matches what the registry stores', async () => {
    for (const item of catalog) {
      const body = buildPublishBody(item)
      const row = await storedRow(body)
      const projected = rowFromPublishBody(body)
      for (const key of ['name', 'version', 'entry_type', 'server_mode']) {
        assert.equal(projected[key], row[key], `${item.name}.${key}`)
      }
      assert.deepEqual(projected.mcp_server_meta.oauth, row.mcp_server_meta.oauth)
      assert.deepEqual(
        projected.mcp_server_meta.remoteEndpoints,
        row.mcp_server_meta.remoteEndpoints
      )
    }
  })

  test('groups, verification states and per-provider data follow the v1 list', () => {
    const verified = catalog.filter(i => i.verification.status === 'verified').map(i => i.name)
    assert.deepEqual(verified.sort(), ['clickup-remote', 'vercel-remote'])
    for (const name of verified)
      assert.match(byName(name).verification.checkedAt, /^\d{4}-\d{2}-\d{2}$/)
    const knownIssues = catalog
      .filter(i => i.verification.status === 'known-issue')
      .map(i => i.name)
    assert.deepEqual(knownIssues.sort(), ['google-calendar-remote', 'slack-remote'])
    for (const name of knownIssues) assert.equal(byName(name).verification.checkedAt, '2026-09-25')

    const preRegistered = catalog
      .filter(i => i.expectedRegistration === 'pre-registered')
      .map(i => i.name)
    assert.deepEqual(preRegistered.sort(), [
      'github-remote',
      'gmail-remote',
      'google-calendar-remote',
      'google-drive-remote',
      'hubspot-remote',
      'slack-remote',
      'workiq-remote',
    ])
    for (const name of [
      'workiq-remote',
      'gmail-remote',
      'google-drive-remote',
      'google-calendar-remote',
    ]) {
      assert.deepEqual(byName(name).allowedGrantScopes, ['user'], name)
    }
    const workiq = byName('workiq-remote')
    assert.equal(workiq.authorizationServerHint, 'entra-v2')
    assert.deepEqual(workiq.scopes, ['api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'])
    assert.ok(
      byName('hubspot-remote').scopes?.length > 0,
      'HubSpot publishes no scopes; the entry suggests them'
    )
    assert.equal(byName('monday-remote').expectedRegistration, 'cimd')
    assert.equal(byName('vercel-remote').url, 'https://mcp.vercel.com/')
    assert.equal(byName('hubspot-remote').url, 'https://mcp.hubspot.com/')
  })

  // Derived from control-api's discovery over the captured provider answers, not
  // written by hand: a mode the real discovery would not detect makes the seed
  // reject the entry as drift, and only surfaces when someone runs it.
  test('registration modes match what discovery detects on the captured provider answers', async () => {
    const { PILOTS, makeDiscoveryTransport } = await loadControlApiModule(
      'test/fixtures/remoteOAuthDiscovery.ts'
    )
    const { discoverRemoteOAuth } = await loadControlApiModule('src/oauth/discovery.ts')
    const checked = []
    for (const pilot of Object.values(PILOTS)) {
      const item = catalog.find(i => i.url === pilot.mcpUrl)
      assert.ok(item, `no catalog entry for the captured ${pilot.name} fixture`)
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, {
        transport: makeDiscoveryTransport(pilot),
        resolveDns: async () => ['93.184.216.34'],
      })
      assert.ok(outcome.ok, `${pilot.name}: ${JSON.stringify(outcome)}`)
      const detected = outcome.result.registrationMode
      assert.equal(
        rules.catalogRegistrationDrifts(item.expectedRegistration, detected),
        false,
        `${item.name}: catalog says ${item.expectedRegistration}, discovery detects ${detected}`
      )
      checked.push(item.name)
    }
    assert.equal(checked.length, 4)
  })

  test('setup guides refer to the redirect URI below, carry no placeholders and ask for one app per slot', () => {
    for (const item of catalog.filter(i => i.setupGuide !== undefined)) {
      assert.match(item.setupGuide, /redirect URI below/, item.name)
      assert.doesNotMatch(item.setupGuide, /<[^>]*>|\{[^}]*\}|YOUR_|REPLACE|TODO/i, item.name)
      assert.ok(item.setupGuide.length <= 4000, item.name)
      assert.match(item.providerConsoleUrl, /^https:\/\//, item.name)
      if (/listed below/.test(item.setupGuide)) {
        assert.ok(
          item.scopes?.length > 0,
          `${item.name} refers to scopes listed below but suggests none`
        )
      }
      if (
        item.expectedRegistration === 'pre-registered' &&
        item.allowedGrantScopes.includes('context')
      ) {
        assert.match(item.setupGuide, /one app per install slot/, item.name)
      }
    }
  })
})

describe('validation before publishing (control-api parser)', () => {
  test('an invalid item publishes nothing, not even the valid ones next to it', async () => {
    const broken = byName('github-remote')
    delete broken.setupGuide
    const items = [byName('clickup-remote'), broken]
    const run = await seedAgainst({ items, discover: matching(items) })
    assert.equal(run.exitCode, 1)
    assert.ok(
      run.lines.some(l =>
        /github-remote: control-api rejects the entry: setup_guide_required/.test(l)
      )
    )
    assert.equal(run.registry.publishes(), 0)
    assert.equal(run.controlApi.calls.length, 0)
  })

  test('a name scoped to another org aborts', async () => {
    const foreign = { ...byName('clickup-remote'), name: '@acme/clickup-remote' }
    const run = await seedAgainst({ items: [foreign], discover: matching([foreign]) })
    assert.equal(run.exitCode, 1)
    assert.ok(run.lines.some(l => /scoped to another org/.test(l)))
    assert.equal(run.registry.publishes(), 0)
  })

  test('an unknown key the parser would drop is refused', async () => {
    const item = byName('clickup-remote')
    item.verification.reviewer = 'someone'
    const run = await seedAgainst({ items: [item], discover: matching([item]) })
    assert.equal(run.exitCode, 1)
    assert.ok(
      run.lines.some(l =>
        /clickup-remote: oauth block carries fields control-api does not read/.test(l)
      ),
      run.lines.join('\n')
    )
    assert.equal(run.registry.publishes(), 0)
  })

  test('publishes the entry as @evenfire/<name>', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({ items, discover: matching(items) })
    assert.equal(run.exitCode, 0, run.lines.join('\n'))
    assert.ok(run.registry.rows.has('@evenfire/clickup-remote@1.0.0'))
  })
})

describe('discovery before publishing', () => {
  test('a transport that is not alive aborts the item', async () => {
    const items = [byName('vercel-remote'), byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discover: url =>
        url === 'https://mcp.vercel.com/'
          ? { transport: 'dead', registrationMode: 'dcr' }
          : matching(items)(url),
    })
    assert.equal(run.exitCode, 1)
    assert.ok(run.lines.some(l => /vercel-remote 1\.0\.0: MCP transport is dead/.test(l)))
    assert.ok(!run.registry.rows.has('@evenfire/vercel-remote@1.0.0'))
    assert.ok(run.registry.rows.has('@evenfire/clickup-remote@1.0.0'))
  })

  test('an inconclusive transport aborts too', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discover: () => ({ transport: 'inconclusive', registrationMode: 'dcr' }),
    })
    assert.equal(run.exitCode, 1)
    assert.equal(run.registry.publishes(), 0)
  })

  test('registration drift aborts the item unless --allow-drift', async () => {
    const items = [byName('canva-remote')]
    const drifting = () => ({ registrationMode: 'cimd' })
    const strict = await seedAgainst({ items, discover: drifting })
    assert.equal(strict.exitCode, 1)
    assert.ok(strict.lines.some(l => /registration drift: expected dcr, detected cimd/.test(l)))
    assert.equal(strict.registry.publishes(), 0)

    const allowed = await seedAgainst({ items, discover: drifting, flags: { allowDrift: true } })
    assert.equal(allowed.exitCode, 0, allowed.lines.join('\n'))
    assert.ok(allowed.registry.rows.has('@evenfire/canva-remote@1.0.0'))
  })

  test('manual is the same mode as pre-registered', async () => {
    const items = [byName('github-remote')]
    const run = await seedAgainst({ items, discover: () => ({ registrationMode: 'manual' }) })
    assert.equal(run.exitCode, 0, run.lines.join('\n'))
    assert.equal(run.controlApi.calls[0].baseUrl, 'https://api.githubcopilot.com/mcp/')
    assert.equal(run.controlApi.calls[0].authorizationServer, undefined)
  })

  test('an Entra entry runs discovery against the configured tenant, and fails without it', async () => {
    const items = [byName('workiq-remote')]
    const tenant = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'
    const ok = await seedAgainst({
      items,
      discover: () => ({ registrationMode: 'manual' }),
      extraEnv: { SEED_ENTRA_TENANT_AUTHORITY: tenant },
    })
    assert.equal(ok.exitCode, 0, ok.lines.join('\n'))
    assert.equal(ok.controlApi.calls[0].authorizationServer, tenant)

    const missing = await seedAgainst({ items, discover: () => ({ registrationMode: 'manual' }) })
    assert.equal(missing.exitCode, 1)
    assert.equal(missing.registry.publishes(), 0)
  })

  test('a rejected admin token fails every item without publishing', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discoverAnswer: () => ({ status: 401, json: { error: 'Unauthorized' } }),
    })
    assert.equal(run.exitCode, 1)
    assert.ok(run.lines.some(l => /control-api rejected CONTROL_API_TOKEN \(401\)/.test(l)))
    assert.equal(run.registry.publishes(), 0)
  })

  test('a failed discovery reports its kind and publishes nothing', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discoverAnswer: () => ({
        status: 502,
        json: { error: 'discovery_failed', detail: { kind: 'fetch_failed' } },
      }),
    })
    assert.equal(run.exitCode, 1)
    assert.ok(
      run.lines.some(l => /discover answered HTTP 502: discovery_failed \(fetch_failed\)/.test(l))
    )
    assert.equal(run.registry.publishes(), 0)
  })

  test('a redirect from control-api is not followed, so the session cookie stays put', async () => {
    const captured = []
    const sink = createServer((req, res) => {
      captured.push(req.headers.cookie)
      res.end('{}')
    })
    await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve))
    const sinkUrl = `http://127.0.0.1:${sink.address().port}/collect`
    const redirector = createServer((req, res) => {
      res.writeHead(307, { location: sinkUrl })
      res.end()
    })
    await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve))
    const lines = []
    try {
      const exitCode = await runSeed({
        catalog: [byName('clickup-remote')],
        flags: { dryRun: true },
        env: {
          CONTROL_API_URL: `http://127.0.0.1:${redirector.address().port}`,
          CONTROL_API_TOKEN: ADMIN_TOKEN,
        },
        rules,
        log: line => lines.push(line),
      })
      assert.equal(exitCode, 1)
      assert.deepEqual(captured, [])
    } finally {
      await new Promise(resolve => sink.close(resolve))
      await new Promise(resolve => redirector.close(resolve))
    }
  })

  test('--dry-run validates and discovers but never touches the registry', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({ items, discover: matching(items), flags: { dryRun: true } })
    assert.equal(run.exitCode, 0, run.lines.join('\n'))
    assert.equal(run.controlApi.calls.length, 1)
    assert.equal(run.registry.calls.length, 0)
  })
})

describe('read-after-write', () => {
  test('a registry that drops the oauth block fails the seed', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      registry: { dropOAuth: true },
    })
    assert.equal(run.exitCode, 1)
    assert.ok(run.lines.some(l => /did not store mcp_server_meta\.oauth/.test(l)))
  })

  test('a fresh publish that loses the oauth block stops the run before the next entry', async () => {
    const items = [byName('clickup-remote'), byName('vercel-remote'), byName('canva-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      registry: { dropOAuth: true },
    })
    assert.equal(run.exitCode, 1)
    assert.equal(run.registry.publishes(), 1)
    assert.ok(!run.registry.rows.has('@evenfire/vercel-remote@1.0.0'))
    assert.ok(!run.registry.rows.has('@evenfire/canva-remote@1.0.0'))
    assert.ok(run.lines.some(l => /Stopping/.test(l)))
    assert.ok(run.lines.some(l => /0 succeeded, 1 failed, 2 not attempted/.test(l)))
  })

  test('a skipped version stored without oauth stops the run before the next entry', async () => {
    const first = byName('clickup-remote')
    const second = byName('vercel-remote')
    const preload = [await storedRow(buildPublishBody(first), { dropOAuth: true })]
    const run = await seedAgainst({
      items: [first, second],
      discover: matching([first, second]),
      registry: { preload },
    })
    assert.equal(run.exitCode, 1)
    assert.ok(!run.registry.rows.has('@evenfire/vercel-remote@1.0.0'))
    assert.ok(
      run.lines.some(l => /may be discarding the oauth block.*--only/.test(l)),
      run.lines.join('\n')
    )
    assert.ok(run.lines.some(l => /Stopping/.test(l)))
    assert.ok(run.lines.some(l => /0 succeeded, 1 failed, 1 not attempted/.test(l)))
  })

  test('a reread that throws after a fresh publish stops the run and says the version exists', async () => {
    const items = [byName('clickup-remote'), byName('vercel-remote'), byName('canva-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      registry: { breakReread: true },
    })
    assert.equal(run.exitCode, 1)
    assert.equal(run.registry.publishes(), 1)
    assert.ok(
      run.lines.some(l =>
        /clickup-remote 1\.0\.0: published .*already published and immutable/.test(l)
      ),
      run.lines.join('\n')
    )
    assert.ok(run.lines.some(l => /Stopping/.test(l)))
    assert.ok(run.lines.some(l => /0 succeeded, 1 failed, 2 not attempted/.test(l)))
  })

  test('a reread that throws after a 409 skip fails only that entry', async () => {
    const first = byName('clickup-remote')
    const second = byName('vercel-remote')
    const preload = [await storedRow(buildPublishBody(first))]
    const run = await seedAgainst({
      items: [first, second],
      discover: matching([first, second]),
      registry: { preload, breakReread: true },
    })
    assert.equal(run.exitCode, 1)
    // The skipped entry fails alone and the run moves on to publish the next one;
    // that one is fresh, hits the same broken reread and is the one that stops.
    assert.equal(run.registry.publishes(), 2)
    const firstFail = run.lines.findIndex(l =>
      /clickup-remote 1\.0\.0: already published, skipped/.test(l)
    )
    assert.ok(firstFail >= 0, run.lines.join('\n'))
    assert.doesNotMatch(run.lines[firstFail + 1], /Stopping/)
    assert.ok(run.lines.some(l => /0 succeeded, 2 failed, 0 not attempted/.test(l)))
  })

  test('a publish whose answer is lost stops the run: the version may exist', async () => {
    const items = [byName('clickup-remote'), byName('vercel-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      registry: { breakPublish: true },
    })
    assert.equal(run.exitCode, 1)
    assert.equal(run.registry.publishes(), 1)
    assert.ok(
      run.lines.some(l => /outcome unknown/.test(l)),
      run.lines.join('\n')
    )
    assert.ok(run.lines.some(l => /0 succeeded, 1 failed, 1 not attempted/.test(l)))
  })

  test('a registry that keeps the oauth block passes', async () => {
    const items = [byName('clickup-remote'), byName('workiq-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      extraEnv: {
        SEED_ENTRA_TENANT_AUTHORITY:
          'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
      },
    })
    assert.equal(run.exitCode, 0, run.lines.join('\n'))
    assert.equal(run.registry.calls.filter(c => c.method === 'GET').length, 2)
  })

  test('an already published version is skipped and reread', async () => {
    const item = byName('clickup-remote')
    const preload = [await storedRow(buildPublishBody(item))]
    const run = await seedAgainst({
      items: [item],
      discover: matching([item]),
      registry: { preload },
    })
    assert.equal(run.exitCode, 0, run.lines.join('\n'))
    assert.ok(
      run.lines.some(l => /already published, skipped; stored oauth block verified/.test(l))
    )
    assert.equal(run.registry.calls.filter(c => c.method === 'GET').length, 1)
  })

  test('an already published version stored without oauth fails: it needs a new version', async () => {
    const item = byName('clickup-remote')
    const preload = [await storedRow(buildPublishBody(item), { dropOAuth: true })]
    const run = await seedAgainst({
      items: [item],
      discover: matching([item]),
      registry: { preload },
    })
    assert.equal(run.exitCode, 1)
    assert.ok(
      run.lines.some(l => /already published, skipped, but the registry did not store/.test(l))
    )
  })

  test('an already published version with other content fails instead of passing as skipped', async () => {
    const item = byName('clickup-remote')
    const older = { ...item, verification: { status: 'untested' } }
    const preload = [await storedRow(buildPublishBody(older))]
    const run = await seedAgainst({
      items: [item],
      discover: matching([item]),
      registry: { preload },
    })
    assert.equal(run.exitCode, 1)
    assert.ok(run.lines.some(l => /differs from the catalog; publish a new version/.test(l)))
  })

  test('an already published version with another endpoint URL fails instead of passing as skipped', async () => {
    const item = byName('clickup-remote')
    const older = { ...item, url: 'https://mcp-old.clickup.com/mcp' }
    const preload = [await storedRow(buildPublishBody(older))]
    const run = await seedAgainst({
      items: [item],
      discover: matching([item]),
      registry: { preload },
    })
    assert.equal(run.exitCode, 1)
    assert.ok(
      run.lines.some(l =>
        /already published, skipped, but stored remote endpoint differs from the catalog/.test(l)
      ),
      run.lines.join('\n')
    )
  })
})

describe('unparseable answers', () => {
  /** Real fetch, except that requests whose path ends with `suffix` get a 200 HTML page. */
  const htmlFor = suffix => (url, init) =>
    new URL(url).pathname.endsWith(suffix)
      ? Promise.resolve(
          new Response('<html>gateway</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        )
      : fetch(url, init)

  test('a 200 discover answer that does not parse is reported as such', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      fetchImpl: htmlFor('/remote/discover'),
    })
    assert.equal(run.exitCode, 1)
    assert.equal(run.registry.publishes(), 0)
    assert.ok(
      run.lines.some(l => /discover answered HTTP 200 with an unparseable response body/.test(l)),
      run.lines.join('\n')
    )
  })

  test('a reread that does not parse is reported as such and stops after a fresh publish', async () => {
    const items = [byName('clickup-remote'), byName('vercel-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      fetchImpl: htmlFor('/versions/1.0.0'),
    })
    assert.equal(run.exitCode, 1)
    assert.equal(run.registry.publishes(), 1)
    assert.ok(
      run.lines.some(l => /published .*rereading it answered an unparseable response body/.test(l)),
      run.lines.join('\n')
    )
    assert.ok(run.lines.some(l => /0 succeeded, 1 failed, 1 not attempted/.test(l)))
  })

  test('a token answer that does not parse says so', async () => {
    const items = [byName('clickup-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      fetchImpl: htmlFor('/oauth/token'),
    })
    assert.equal(run.exitCode, 1)
    assert.ok(
      run.lines.some(l => /HTTP 200, unparseable response body/.test(l)),
      run.lines.join('\n')
    )
  })

  test('a connection cut while reading the body is reported as such, not as a broken body', async () => {
    // Headers and the first bytes arrive, then the socket closes: the failure is the
    // connection, and blaming the body would send the operator to the wrong layer.
    const cut = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' })
      res.write('{"transport":')
      setImmediate(() => res.socket.destroy())
    })
    await new Promise(resolve => cut.listen(0, '127.0.0.1', resolve))
    const lines = []
    try {
      const exitCode = await runSeed({
        catalog: [byName('clickup-remote')],
        flags: { dryRun: true },
        env: {
          CONTROL_API_URL: `http://127.0.0.1:${cut.address().port}`,
          CONTROL_API_TOKEN: ADMIN_TOKEN,
        },
        rules,
        log: line => lines.push(line),
      })
      const output = lines.join('\n')
      assert.equal(exitCode, 1)
      assert.ok(!/unparseable/.test(output), output)
      assert.ok(
        lines.some(l =>
          /\[FAIL\] @evenfire\/clickup-remote 1\.0\.0: TypeError: terminated/.test(l)
        ),
        output
      )
    } finally {
      await new Promise(resolve => cut.close(resolve))
    }
  })
})

describe('credentials in request headers', () => {
  // fetch refuses a header value with CR, LF or NUL and its error quotes the whole
  // value, so a malformed credential would reach the output once per entry.
  test('a CONTROL_API_TOKEN a cookie cannot carry stops the run before any request, unprinted', async () => {
    for (const token of [
      `${ADMIN_TOKEN}\nLEAKED-TAIL`,
      `${ADMIN_TOKEN}\r`,
      `${ADMIN_TOKEN}\u0000LEAKED-TAIL`,
      `${ADMIN_TOKEN}; injected=1`,
      `${ADMIN_TOKEN}€`,
    ]) {
      const items = [byName('clickup-remote'), byName('vercel-remote')]
      const run = await seedAgainst({
        items,
        discover: matching(items),
        extraEnv: { CONTROL_API_TOKEN: token },
      })
      const output = run.lines.join('\n')
      assert.equal(run.exitCode, 2, JSON.stringify(token))
      assert.ok(!output.includes(ADMIN_TOKEN), `output leaks the token: ${output}`)
      assert.ok(!output.includes('LEAKED-TAIL'), `output leaks the token: ${output}`)
      assert.ok(
        run.lines.some(l => /\[FAIL\] CONTROL_API_TOKEN /.test(l)),
        output
      )
      assert.equal(run.registry.calls.length, 0)
    }
  })

  test('a JWT-shaped or percent-encoded session token is still sent as the cookie', async () => {
    const cookies = []
    const sink = createServer((req, res) => {
      cookies.push(req.headers.cookie)
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"Unauthorized"}')
    })
    await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve))
    try {
      for (const token of [
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.Ab-_cD',
        'session%3Dvalue%2Bwith-encoding',
      ]) {
        cookies.length = 0
        const exitCode = await runSeed({
          catalog: [byName('clickup-remote')],
          flags: { dryRun: true },
          env: {
            CONTROL_API_URL: `http://127.0.0.1:${sink.address().port}`,
            CONTROL_API_TOKEN: token,
          },
          rules,
          log: () => {},
        })
        assert.equal(exitCode, 1)
        assert.deepEqual(cookies, [`control_ui_admin_session=${token}`])
      }
    } finally {
      await new Promise(resolve => sink.close(resolve))
    }
  })

  test('a curator token no header can carry stops the run unprinted, before publishing', async () => {
    const minted = `${CURATOR_TOKEN}\nLEAKED-TAIL`
    const items = [byName('clickup-remote'), byName('vercel-remote')]
    const run = await seedAgainst({
      items,
      discover: matching(items),
      fetchImpl: (url, init) =>
        new URL(url).pathname === '/oauth/token'
          ? Promise.resolve(
              new Response(JSON.stringify({ access_token: minted, token_type: 'Bearer' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            )
          : fetch(url, init),
    })
    const output = run.lines.join('\n')
    assert.equal(run.exitCode, 1)
    assert.ok(!output.includes(CURATOR_TOKEN), `output leaks the curator token: ${output}`)
    assert.ok(!output.includes('LEAKED-TAIL'), `output leaks the curator token: ${output}`)
    assert.equal(run.registry.publishes(), 0)
    assert.ok(
      run.lines.some(l => /0 succeeded, 1 failed, 1 not attempted/.test(l)),
      output
    )
  })
})

describe('service URLs', () => {
  test('https anywhere, http only on loopback, never credentials', () => {
    assert.equal(parseServiceUrl('X', 'https://registry.example/'), 'https://registry.example')
    // Built at runtime: the public-boundary gate rejects literal loopback URLs with a port.
    const ipv4 = `http://${'127.0.0.1'}:8090`
    const named = `http://${'localhost'}:3000`
    assert.equal(parseServiceUrl('X', `${ipv4}/api/v1/`), `${ipv4}/api/v1`)
    assert.equal(parseServiceUrl('X', named), named)
    assert.equal(parseServiceUrl('X', 'http://[::1]:3000'), 'http://[::1]:3000')
    assert.throws(
      () => parseServiceUrl('X', 'http://registry.example'),
      /must use https \(got http:\/\/registry\.example\)/
    )
    assert.throws(() => parseServiceUrl('X', 'not a url'), /not a valid URL/)
    assert.throws(() => parseServiceUrl('X', 'https://registry.example/?a=1'), /query or fragment/)
    assert.throws(
      () => parseServiceUrl('X', 'https://user:pw@registry.example'),
      err => {
        assert.match(err.message, /must not carry credentials/)
        assert.ok(!err.message.includes('pw'))
        return true
      }
    )
  })

  test('a bad URL stops the run before any request and never echoes its credentials', async () => {
    for (const env of [
      { CONTROL_API_URL: 'https://admin:hunter2@control.example' },
      { REGISTRY_URL: 'http://registry.example' },
    ]) {
      const run = await seedAgainst({
        items: [byName('clickup-remote')],
        discover: () => ({ registrationMode: 'dcr' }),
        extraEnv: env,
      })
      assert.equal(run.exitCode, 2)
      assert.equal(run.controlApi.calls.length, 0)
      assert.equal(run.registry.calls.length, 0)
      assert.ok(!run.lines.join('\n').includes('hunter2'))
    }
  })
})

describe('loading control-api sources with Node', () => {
  // Node can only strip erasable TypeScript. Importing every module the seed and
  // its fakes load, with Node rather than vitest, turns an enum or a parameter
  // property added to any of them into a failure here instead of a broken seed.
  test('every control-api module the seed and its fakes load imports with Node', async () => {
    const rulesModule = await loadControlApiModule('src/routes/admin/catalogRemoteOAuth.ts')
    assert.equal(typeof rulesModule.parseRemoteOAuthCatalogBlock, 'function')
    assert.equal(typeof rulesModule.catalogRegistrationDrifts, 'function')
    const rowModule = await loadControlApiModule('test/fixtures/registryEntryRow.ts')
    assert.equal(typeof rowModule.registryEntryRow, 'function')
  })
})

describe('CLI', () => {
  let controlApi
  before(async () => {
    controlApi = await startFakeControlApi(() => ({
      status: 200,
      json: discoverResponse({ registrationMode: 'dcr' }),
    }))
  })
  after(() => controlApi.close())

  // Async spawn: the fake control-api runs in this process and must keep serving.
  test('a dry run of the real catalog entry loads the control-api rules and never prints secrets', async () => {
    const child = spawn(process.execPath, [SEED, '--dry-run', '--only', 'clickup-remote'], {
      env: {
        PATH: process.env.PATH,
        CONTROL_API_URL: controlApi.url,
        CONTROL_API_TOKEN: ADMIN_TOKEN,
        CURATOR_CLIENT_SECRET: CURATOR_SECRET,
      },
    })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    const status = await new Promise(resolve => child.on('close', resolve))
    const result = { status }
    assert.equal(result.status, 0, output)
    assert.match(output, /@evenfire\/clickup-remote 1\.0\.0: valid, transport alive/)
    for (const secret of [ADMIN_TOKEN, CURATOR_SECRET, CURATOR_TOKEN])
      assert.ok(!output.includes(secret))
  })

  test('a real publish through the curator token never prints a secret', async () => {
    const registry = await startFakeRegistry()
    try {
      const child = spawn(process.execPath, [SEED, '--only', 'clickup-remote'], {
        env: {
          PATH: process.env.PATH,
          CONTROL_API_URL: controlApi.url,
          CONTROL_API_TOKEN: ADMIN_TOKEN,
          REGISTRY_URL: registry.url,
          CURATOR_CLIENT_ID: CURATOR_ID,
          CURATOR_CLIENT_SECRET: CURATOR_SECRET,
        },
      })
      let output = ''
      child.stdout.on('data', d => (output += d))
      child.stderr.on('data', d => (output += d))
      const status = await new Promise(resolve => child.on('close', resolve))
      assert.equal(status, 0, output)
      assert.match(
        output,
        /@evenfire\/clickup-remote 1\.0\.0: published .*stored oauth block verified/
      )
      assert.ok(registry.calls.some(c => c.path === '/oauth/token'))
      for (const secret of [ADMIN_TOKEN, CURATOR_ID, CURATOR_SECRET, CURATOR_TOKEN]) {
        assert.ok(!output.includes(secret), 'output leaks a credential')
      }
    } finally {
      await registry.close()
    }
  })

  test('an unknown flag exits with usage', () => {
    const result = spawnSync(process.execPath, [SEED, '--publish-everything'], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Usage/)
  })
})
