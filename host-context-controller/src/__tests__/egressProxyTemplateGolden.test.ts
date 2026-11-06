import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MockAppsApi,
  MockCoreApi,
  MockCustomApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import {
  AUTH_HEADER_ENV_REF_RE,
  McpServerReconciler,
  countFixedTemplateReferences,
} from '../reconciler'
import { McpServerCRD } from '../types'

/**
 * Golden tests for the rendered egress-proxy NGINX template.
 *
 * Three deterministic remote shapes (plain, query-header, oauth) pin the
 * exact bytes the renderer emits, the fixed env references (classified
 * positionally by countFixedTemplateReferences, the same spans the
 * preflight uses), and the env of the single egress-proxy container. A
 * new fixed reference therefore fails here instead of reaching a rendered
 * template unnoticed.
 *
 * Regenerate the golden files after an intentional template change with,
 * from host-context-controller/:
 *
 *   UPDATE_EGRESS_PROXY_TEMPLATE_GOLDEN=1 npx vitest run src/__tests__/egressProxyTemplateGolden.test.ts
 *
 * Regeneration rewrites only the byte-compare fixtures. The
 * fixed-reference and Deployment assertions still compare against the
 * literals in this file, so regenerating cannot bless a new fixed
 * reference or a new container env name.
 */

vi.mock('../config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    egressProxyImage: 'clerum/nginx-egress-proxy:0.1.0',
    stdioBridgeImage: 'clerum/stdio-bridge:0.1.0',
    stdioBridgeResources: {
      requests: { memory: '32Mi', cpu: '50m' },
      limits: { memory: '128Mi', cpu: '200m' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
    allowedPluginImagePrefixes: ['registry.evenfire.ai/', 'clerum/'],
    enforcePluginImageAllowlist: false,
  },
}))

const GOLDEN_DIR = join(__dirname, 'fixtures', 'egress-proxy-template')

function buildReconciler(
  appsApi: MockAppsApi,
  coreApi: MockCoreApi,
  customApi: MockCustomApi
): McpServerReconciler {
  return new McpServerReconciler({} as k8s.KubeConfig, {
    assumeInventoryAuthorityWhenUnconfigured: true,
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    customApi: asCustomApi(customApi),
  })
}

function goldenServer(
  remote: McpServerCRD['spec']['remote'],
  auth?: McpServerCRD['spec']['auth']
): McpServerCRD {
  return {
    name: 'golden-remote',
    namespace: 'mcp-server',
    uid: 'golden-uid-0001',
    spec: {
      image: 'clerum/nginx-egress-proxy:0.1.0',
      transport: { type: 'streamableHttp', port: 3000 },
      managed: true,
      enabled: true,
      env: [
        { name: 'API_KEY', value: 'render-only' },
        { name: 'UPSTREAM_TOKEN', value: 'render-only' },
      ],
      remote,
      ...(auth ? { auth } : {}),
    },
  }
}

interface GoldenShape {
  label: string
  file: string
  server: McpServerCRD
  expectedFixedRefs: Record<string, number>
  contextWitnesses: string[]
}

const SHAPES: GoldenShape[] = [
  {
    label: 'plain',
    file: 'plain.default.conf.template',
    server: goldenServer({ baseUrl: 'https://upstream.example/mcp' }),
    expectedFixedRefs: {
      NGINX_LOCAL_RESOLVERS: 1,
      proxy_add_x_forwarded_for: 1,
      remote_addr: 1,
      scheme: 1,
    },
    contextWitnesses: ['proxy_pass https://remote_upstream/mcp;'],
  },
  {
    label: 'query-header',
    file: 'query-header.default.conf.template',
    server: goldenServer({
      baseUrl: 'https://upstream.example/mcp?apikey=${API_KEY}',
      authHeaders: [{ header: 'Authorization', valueTemplate: 'Bearer ${UPSTREAM_TOKEN}' }],
    }),
    expectedFixedRefs: {
      NGINX_LOCAL_RESOLVERS: 1,
      proxy_add_x_forwarded_for: 1,
      remote_addr: 1,
      scheme: 1,
    },
    contextWitnesses: ['?apikey=${API_KEY};', '"Bearer ${UPSTREAM_TOKEN}"'],
  },
  {
    label: 'oauth',
    file: 'oauth.default.conf.template',
    server: goldenServer(
      {
        baseUrl: 'https://upstream.example/mcp?apikey=${API_KEY}',
        authHeaders: [{ header: 'X-Api-Key', valueTemplate: '${UPSTREAM_TOKEN}' }],
      },
      { type: 'oauth' }
    ),
    expectedFixedRefs: {
      NGINX_LOCAL_RESOLVERS: 1,
      http_authorization: 1,
      proxy_add_x_forwarded_for: 1,
      remote_addr: 1,
      scheme: 1,
    },
    contextWitnesses: [
      '?apikey=${API_KEY};',
      'proxy_set_header Authorization $http_authorization;',
    ],
  },
]

function countOccurrences(text: string, pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of text.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? ''
    if (name === '') continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

function firstDifferingLine(rendered: string, golden: string): number {
  const renderedLines = rendered.split('\n')
  const goldenLines = golden.split('\n')
  const total = Math.max(renderedLines.length, goldenLines.length)
  for (let index = 0; index < total; index += 1) {
    if (renderedLines[index] !== goldenLines[index]) return index + 1
  }
  return total
}

describe('egress-proxy template golden', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let customApi: MockCustomApi
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    reconciler = buildReconciler(appsApi, coreApi, customApi)
  })

  for (const shape of SHAPES) {
    describe(shape.label, () => {
      it('matches the golden template byte for byte', () => {
        const rendered = (reconciler as any).renderNginxTemplate(shape.server)
        const template: string = rendered.configMap.data['default.conf.template']
        const goldenPath = join(GOLDEN_DIR, shape.file)

        if (process.env.UPDATE_EGRESS_PROXY_TEMPLATE_GOLDEN === '1') {
          mkdirSync(dirname(goldenPath), { recursive: true })
          writeFileSync(goldenPath, template)
        }

        const golden = readFileSync(goldenPath, 'utf8')
        // Life witness: the golden is a real render, not an empty fixture.
        expect(golden.length).toBeGreaterThan(0)
        expect(golden).toContain('proxy_pass https://remote_upstream')
        if (template !== golden) {
          throw new Error(
            `rendered template differs from golden ${shape.file} at line ${firstDifferingLine(template, golden)}`
          )
        }
      })

      it('keeps exactly the expected fixed references', () => {
        const rendered = (reconciler as any).renderNginxTemplate(shape.server)
        const template: string = rendered.configMap.data['default.conf.template']

        // Life and context witnesses: the render ran and each dynamic
        // reference sits in the position the positional spans assume.
        const templateOccurrences = countOccurrences(template, AUTH_HEADER_ENV_REF_RE)
        let templateTotal = 0
        for (const count of templateOccurrences.values()) templateTotal += count
        expect(templateTotal).toBeGreaterThan(0)
        for (const witness of shape.contextWitnesses) {
          expect(template).toContain(witness)
        }

        const fixedRefs: Record<string, number> = {}
        for (const [name, fixed] of countFixedTemplateReferences(
          template,
          rendered.parsedSearch,
          rendered.authHeaders
        )) {
          if (fixed !== 0) fixedRefs[name] = fixed
        }
        expect(fixedRefs).toEqual(shape.expectedFixedRefs)
      })

      it('pins the egress-proxy Deployment container env', () => {
        const deployment = (reconciler as any).buildDeployment(shape.server)
        const containers = deployment.spec.template.spec.containers

        // Life witness for the envFrom absence below.
        expect(containers).toHaveLength(1)
        expect(containers[0].name).toBe('egress-proxy')
        expect((containers[0].env ?? []).map((entry: any) => entry.name)).toEqual([
          'API_KEY',
          'UPSTREAM_TOKEN',
          'NGINX_ENTRYPOINT_LOCAL_RESOLVERS',
          'NGINX_ENVSUBST_FILTER',
        ])
        expect(containers[0].envFrom).toBeUndefined()
      })
    })
  }
})
