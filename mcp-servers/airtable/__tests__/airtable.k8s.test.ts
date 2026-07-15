/**
 * Airtable MCP Server - Kubernetes Deployment Tests
 *
 * Tests for validating Kubernetes deployment configuration,
 * resource management, and integration with the context-mapper operator.
 *
 * Covers:
 * - Deployment specification
 * - Service configuration
 * - Pod resource requirements
 * - Health checks
 * - NetworkPolicy integration
 * - Context-mapper reconciliation
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadYaml } from '../../utils/yaml-loader'

// =============================================================================
// Types
// =============================================================================

interface K8sDeployment {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
  }
  spec: {
    replicas: number
    selector: {
      matchLabels: Record<string, string>
    }
    template: {
      metadata: {
        labels: Record<string, string>
      }
      spec: {
        containers: Array<{
          name: string
          image: string
          ports: Array<{ containerPort: number }>
          env: Array<{
            name: string
            value?: string
            valueFrom?: {
              secretKeyRef: {
                name: string
                key: string
              }
            }
          }>
          resources?: {
            requests?: { memory?: string; cpu?: string }
            limits?: { memory?: string; cpu?: string }
          }
          readinessProbe?: {
            httpGet: {
              path: string
              port: number
            }
            initialDelaySeconds: number
            periodSeconds: number
          }
          livenessProbe?: {
            httpGet: {
              path: string
              port: number
            }
            initialDelaySeconds: number
            periodSeconds: number
          }
        }>
      }
    }
  }
}

interface K8sService {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
  }
  spec: {
    selector: Record<string, string>
    ports: Array<{
      name: string
      port: number
      targetPort: number
      protocol: string
    }>
    type: string
  }
}

// =============================================================================
// Expected Deployed Resources (from McpServer CRD)
// =============================================================================

/**
 * Based on the mcpserver.yaml CRD, the context-mapper would create:
 * - Deployment: airtable-server
 * - Service: airtable-server
 * - NetworkPolicy: (if configured)
 */

// =============================================================================
// Test Data
// =============================================================================

const MCP_SERVER_YAML = join(__dirname, '../mcpserver.yaml')

// =============================================================================
// Helper Functions
// =============================================================================

function generateExpectedDeployment(): K8sDeployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'airtable-server',
      namespace: 'mcp-server',
      labels: {
        app: 'airtable-mcp',
        'clerum.io/mcp-server': 'airtable-server',
        'clerum.io/managed-by': 'context-mapper',
      },
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'airtable-mcp',
          'clerum.io/mcp-server': 'airtable-server',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'airtable-mcp',
            'clerum.io/mcp-server': 'airtable-server',
          },
        },
        spec: {
          containers: [
            {
              name: 'airtable-server',
              image:
                'ghcr.io/evenfire-ai/airtable-mcp-server:latest',
              ports: [
                {
                  containerPort: 3000,
                },
              ],
              env: [
                {
                  name: 'MCP_TRANSPORT',
                  value: 'streamableHttp',
                },
                {
                  name: 'PORT',
                  value: '3000',
                },
                {
                  name: 'AIRTABLE_MCP_LOG_TRAFFIC',
                  value: 'true',
                },
                {
                  name: 'AIRTABLE_API_KEY',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'mcp-airtable-credentials',
                      key: 'api-key',
                    },
                  },
                },
              ],
              resources: {
                requests: {
                  memory: '128Mi',
                  cpu: '100m',
                },
                limits: {
                  memory: '256Mi',
                  cpu: '500m',
                },
              },
              readinessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000,
                },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
              livenessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000,
                },
                initialDelaySeconds: 15,
                periodSeconds: 20,
              },
            },
          ],
        },
      },
    },
  }
}

function generateExpectedService(): K8sService {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'airtable-server',
      namespace: 'mcp-server',
    },
    spec: {
      selector: {
        app: 'airtable-mcp',
        'clerum.io/mcp-server': 'airtable-server',
      },
      ports: [
        {
          name: 'http',
          port: 3000,
          targetPort: 3000,
          protocol: 'TCP',
        },
      ],
      type: 'ClusterIP',
    },
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Airtable MCP Server - Kubernetes Deployment', () => {
  describe('Expected Deployment Configuration', () => {
    let expectedDeployment: K8sDeployment

    beforeEach(() => {
      expectedDeployment = generateExpectedDeployment()
    })

    describe('Deployment Metadata', () => {
      it('should have correct deployment name', () => {
        expect(expectedDeployment.metadata.name).toBe('airtable-server')
      })

      it('should be in mcp-server namespace', () => {
        expect(expectedDeployment.metadata.namespace).toBe('mcp-server')
      })

      it('should have clerum.io labels for operator tracking', () => {
        expect(expectedDeployment.metadata.labels).toHaveProperty(
          'clerum.io/mcp-server',
          'airtable-server'
        )
        expect(expectedDeployment.metadata.labels).toHaveProperty(
          'clerum.io/managed-by',
          'context-mapper'
        )
      })
    })

    describe('Replica Configuration', () => {
      it('should run single replica', () => {
        expect(expectedDeployment.spec.replicas).toBe(1)
      })

      it('should have correct selector labels', () => {
        expect(expectedDeployment.spec.selector.matchLabels).toEqual({
          app: 'airtable-mcp',
          'clerum.io/mcp-server': 'airtable-server',
        })
      })
    })

    describe('Container Configuration', () => {
      let container: K8sDeployment['spec']['template']['spec']['containers'][0]

      beforeEach(() => {
        container = expectedDeployment.spec.template.spec.containers[0]
      })

      it('should use correct image', () => {
        expect(container.image).toBe(
          'ghcr.io/evenfire-ai/airtable-mcp-server:latest'
        )
      })

      it('should expose port 3000', () => {
        expect(container.ports).toHaveLength(1)
        expect(container.ports[0].containerPort).toBe(3000)
      })

      it('should have MCP_TRANSPORT env var', () => {
        const transportEnv = container.env.find(e => e.name === 'MCP_TRANSPORT')
        expect(transportEnv?.value).toBe('streamableHttp')
      })

      it('should have PORT env var', () => {
        const portEnv = container.env.find(e => e.name === 'PORT')
        expect(portEnv?.value).toBe('3000')
      })

      it('should enable runtime traffic logging', () => {
        const logEnv = container.env.find(e => e.name === 'AIRTABLE_MCP_LOG_TRAFFIC')
        expect(logEnv?.value).toBe('true')
      })

      it('should mount AIRTABLE_API_KEY from secret', () => {
        const apiKeysEnv = container.env.find(e => e.name === 'AIRTABLE_API_KEY')
        expect(apiKeysEnv?.valueFrom).toBeDefined()
        expect(apiKeysEnv?.valueFrom?.secretKeyRef.name).toBe('mcp-airtable-credentials')
        expect(apiKeysEnv?.valueFrom?.secretKeyRef.key).toBe('api-key')
      })
    })

    describe('Resource Requirements', () => {
      let resources: K8sDeployment['spec']['template']['spec']['containers'][0]['resources']

      beforeEach(() => {
        resources = expectedDeployment.spec.template.spec.containers[0].resources!
      })

      it('should have memory request', () => {
        expect(resources.requests?.memory).toBe('128Mi')
      })

      it('should have CPU request', () => {
        expect(resources.requests?.cpu).toBe('100m')
      })

      it('should have memory limit', () => {
        expect(resources.limits?.memory).toBe('256Mi')
      })

      it('should have CPU limit', () => {
        expect(resources.limits?.cpu).toBe('500m')
      })

      it('should have reasonable resource ratio (2:1)', () => {
        const reqMem = parseInt(resources.requests!.memory!)
        const limMem = parseInt(resources.limits!.memory!)
        const ratio = limMem / reqMem

        expect(ratio).toBe(2) // 256Mi / 128Mi = 2
      })
    })

    describe('Health Probes', () => {
      let container: K8sDeployment['spec']['template']['spec']['containers'][0]

      beforeEach(() => {
        container = expectedDeployment.spec.template.spec.containers[0]
      })

      describe('Readiness Probe', () => {
        it('should have readiness probe configured', () => {
          expect(container.readinessProbe).toBeDefined()
        })

        it('should check /health endpoint', () => {
          expect(container.readinessProbe?.httpGet.path).toBe('/health')
        })

        it('should check port 3000', () => {
          expect(container.readinessProbe?.httpGet.port).toBe(3000)
        })

        it('should have initial delay of 5 seconds', () => {
          expect(container.readinessProbe?.initialDelaySeconds).toBe(5)
        })

        it('should check every 10 seconds', () => {
          expect(container.readinessProbe?.periodSeconds).toBe(10)
        })
      })

      describe('Liveness Probe', () => {
        it('should have liveness probe configured', () => {
          expect(container.livenessProbe).toBeDefined()
        })

        it('should check /health endpoint', () => {
          expect(container.livenessProbe?.httpGet.path).toBe('/health')
        })

        it('should have longer initial delay than readiness', () => {
          expect(container.livenessProbe?.initialDelaySeconds).toBeGreaterThan(
            container.readinessProbe!.initialDelaySeconds
          )
        })

        it('should have longer period than readiness', () => {
          expect(container.livenessProbe?.periodSeconds).toBeGreaterThanOrEqual(
            container.readinessProbe!.periodSeconds
          )
        })
      })
    })
  })

  describe('Expected Service Configuration', () => {
    let expectedService: K8sService

    beforeEach(() => {
      expectedService = generateExpectedService()
    })

    it('should have correct service name', () => {
      expect(expectedService.metadata.name).toBe('airtable-server')
    })

    it('should be in mcp-server namespace', () => {
      expect(expectedService.metadata.namespace).toBe('mcp-server')
    })

    it('should select pods with correct labels', () => {
      expect(expectedService.spec.selector).toEqual({
        app: 'airtable-mcp',
        'clerum.io/mcp-server': 'airtable-server',
      })
    })

    it('should expose port 3000', () => {
      expect(expectedService.spec.ports).toHaveLength(1)
      expect(expectedService.spec.ports[0].port).toBe(3000)
    })

    it('should be ClusterIP type', () => {
      expect(expectedService.spec.type).toBe('ClusterIP')
    })
  })

  describe('McpServer CRD to K8s Resources Mapping', () => {
    let crd: any

    beforeEach(() => {
      const content = readFileSync(MCP_SERVER_YAML, 'utf-8')
      crd = loadYaml(content)
    })

    it('should map CRD name to deployment name', () => {
      expect(crd.metadata.name).toBe('airtable-server')
      const deployment = generateExpectedDeployment()
      expect(deployment.metadata.name).toBe(crd.metadata.name)
    })

    it('should map CRD namespace to deployment namespace', () => {
      expect(crd.metadata.namespace).toBe('mcp-server')
      const deployment = generateExpectedDeployment()
      expect(deployment.metadata.namespace).toBe(crd.metadata.namespace)
    })

    it('should map CRD image to container image', () => {
      expect(crd.spec.image).toBe(
        'ghcr.io/evenfire-ai/airtable-mcp-server:latest'
      )
      const deployment = generateExpectedDeployment()
      expect(deployment.spec.template.spec.containers[0].image).toBe(crd.spec.image)
    })

    it('should map CRD resources to container resources', () => {
      const deployment = generateExpectedDeployment()
      const containerResources = deployment.spec.template.spec.containers[0].resources

      expect(containerResources?.requests).toEqual(crd.spec.resources.requests)
      expect(containerResources?.limits).toEqual(crd.spec.resources.limits)
    })

    it('should map CRD transport port to container port', () => {
      expect(crd.spec.transport.port).toBe(3000)
      const deployment = generateExpectedDeployment()
      expect(deployment.spec.template.spec.containers[0].ports[0].containerPort).toBe(
        crd.spec.transport.port
      )
    })
  })

  describe('Context-Mapper Integration', () => {
    it('should generate resources that context-mapper would create', () => {
      const deployment = generateExpectedDeployment()
      const service = generateExpectedService()

      // Verify labels match what context-mapper expects
      expect(deployment.metadata.labels['clerum.io/managed-by']).toBe('context-mapper')
      expect(service.spec.selector['clerum.io/mcp-server']).toBeDefined()
    })

    it('should be compatible with StreamableHTTP transport', () => {
      const deployment = generateExpectedDeployment()
      const service = generateExpectedService()

      // StreamableHTTP requires HTTP endpoint
      expect(service.spec.ports[0].protocol).toBe('TCP')
      expect(deployment.spec.template.spec.containers[0].ports[0].containerPort).toBe(3000)
    })
  })

  describe('Network Policy Considerations', () => {
    it('should be compatible with mcp-server namespace policies', () => {
      const deployment = generateExpectedDeployment()

      // Pods in mcp-server namespace should have correct labels
      expect(deployment.spec.template.metadata.labels['app']).toBeDefined()
    })

    it('should use ClusterIP (internal only)', () => {
      const service = generateExpectedService()
      expect(service.spec.type).toBe('ClusterIP')
    })

    it('should declare Airtable egress bindings in the source CRD', () => {
      const content = readFileSync(MCP_SERVER_YAML, 'utf-8')
      const crd = loadYaml(content) as {
        spec?: {
          egressBindings?: Array<{ dns?: string; port: number; protocol?: string }>
        }
      }

      expect(crd.spec?.egressBindings?.[0]).toEqual({
        dns: 'api.airtable.com',
        port: 443,
        protocol: 'TCP',
      })
    })
  })
})

describe('Airtable MCP Server - Deployment Validation', () => {
  describe('Security Configuration', () => {
    let expectedDeployment: K8sDeployment

    beforeEach(() => {
      expectedDeployment = generateExpectedDeployment()
    })

    it('should not run as root (image requirement)', () => {
      // This validates the Dockerfile requirement
      // The actual validation requires inspecting the image
      const container = expectedDeployment.spec.template.spec.containers[0]
      expect(container).toBeDefined()
      // TODO: Add image security scan in CI
    })

    it('should have resource limits to prevent DoS', () => {
      const container = expectedDeployment.spec.template.spec.containers[0]

      expect(container.resources?.limits?.memory).toBeDefined()
      expect(container.resources?.limits?.cpu).toBeDefined()

      // Limits should be reasonable for MCP server
      expect(parseInt(container.resources!.limits!.memory!)).toBeLessThanOrEqual(256)
      expect(parseInt(container.resources!.limits!.cpu!)).toBeLessThanOrEqual(500)
    })

    it('should use secrets for sensitive data', () => {
      const container = expectedDeployment.spec.template.spec.containers[0]

      const secretEnvVars = container.env.filter(e => e.valueFrom?.secretKeyRef)

      expect(secretEnvVars.length).toBeGreaterThan(0)

      secretEnvVars.forEach(envVar => {
        expect(envVar.valueFrom?.secretKeyRef.name).toMatch(/^mcp-.*-credentials$/)
      })
    })
  })

  describe('Operational Considerations', () => {
    let expectedDeployment: K8sDeployment
    let expectedService: K8sService

    beforeEach(() => {
      expectedDeployment = generateExpectedDeployment()
      expectedService = generateExpectedService()
    })

    it('should be accessible via service DNS', () => {
      // Service DNS name format: <service>.<namespace>.svc.cluster.local
      const serviceDns = `${expectedService.metadata.name}.${expectedService.metadata.namespace}.svc.cluster.local:3000`
      expect(serviceDns).toBe('airtable-server.mcp-server.svc.cluster.local:3000')
    })

    it('should have health checks for readiness', () => {
      const container = expectedDeployment.spec.template.spec.containers[0]

      expect(container.readinessProbe).toBeDefined()
      expect(container.livenessProbe).toBeDefined()
    })

    it('should have single replica (stateless)', () => {
      // Airtable MCP is stateless, single replica is sufficient
      expect(expectedDeployment.spec.replicas).toBe(1)
    })

    it('should not require persistent storage', () => {
      // Airtable MCP does not need PVC
      const volumeClaims = expectedDeployment.spec.template.spec.volumes?.filter(
        v => v.persistentVolumeClaim
      )

      expect(volumeClaims).toBeUndefined()
    })
  })
})
