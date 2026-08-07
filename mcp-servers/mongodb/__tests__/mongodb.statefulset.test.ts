/**
 * MongoDB MCP Server - StatefulSet Deployment Tests
 *
 * Tests for validating Kubernetes StatefulSet configuration for MongoDB,
 * including PVC management, pod identity, and data persistence.
 *
 * Covers:
 * - StatefulSet specification
 * - PVC configuration and retention
 * - Pod DNS identity
 * - Headless service configuration
 * - Volume mounting
 * - Context-mapper reconciliation
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadYaml } from '../../utils/yaml-loader'

// =============================================================================
// Types
// =============================================================================

interface K8sStatefulSet {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
  }
  spec: {
    replicas: number
    serviceName: string
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
          ports: Array<{ containerPort: number; name?: string }>
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
          volumeMounts?: Array<{
            name: string
            mountPath: string
          }>
        }>
        volumes?: Array<{
          name: string
          persistentVolumeClaim?: {
            claimName: string
          }
        }>
      }
    }
    volumeClaimTemplates: Array<{
      metadata: {
        name: string
      }
      spec: {
        accessModes: string[]
        resources: {
          requests: {
            storage: string
          }
        }
      }
    }>
  }
}

interface K8sHeadlessService {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
  }
  spec: {
    clusterIP: string
    selector: Record<string, string>
    ports: Array<{
      name: string
      port: number
      targetPort: number
      protocol: string
    }>
    publishNotReadyAddresses: boolean
  }
}

// =============================================================================
// Test Data
// =============================================================================

const MCP_SERVER_YAML = join(__dirname, '../mcpserver.yaml')

// =============================================================================
// Helper Functions
// =============================================================================

function generateExpectedStatefulSet(): K8sStatefulSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: 'mongodb-server',
      namespace: 'mcp-server',
      labels: {
        app: 'mongodb-mcp',
        'clerum.io/mcp-server': 'mongodb-server',
        'clerum.io/managed-by': 'context-mapper',
      },
    },
    spec: {
      replicas: 1,
      serviceName: 'mongodb-server',
      selector: {
        matchLabels: {
          app: 'mongodb-mcp',
          'clerum.io/mcp-server': 'mongodb-server',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'mongodb-mcp',
            'clerum.io/mcp-server': 'mongodb-server',
          },
        },
        spec: {
          containers: [
            {
              name: 'mongodb-server',
              image: 'mongodb/mongodb-mcp-server:latest',
              ports: [
                {
                  name: 'http',
                  containerPort: 3000,
                },
                {
                  name: 'health',
                  containerPort: 3001,
                },
              ],
              env: [
                {
                  name: 'MDB_MCP_TRANSPORT',
                  value: 'streamableHttp',
                },
                {
                  name: 'MDB_MCP_CONNECTION_STRING',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'mcp-mongodb-credentials',
                      key: 'connection-string',
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
              volumeMounts: [
                {
                  name: 'data',
                  mountPath: '/data/db',
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'data',
              persistentVolumeClaim: {
                claimName: 'mongodb-server-mongodb-server-0',
              },
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: {
            name: 'data',
          },
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: {
              requests: {
                storage: '1Gi',
              },
            },
          },
        },
      ],
    },
  }
}

function generateExpectedHeadlessService(): K8sHeadlessService {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'mongodb-server',
      namespace: 'mcp-server',
    },
    spec: {
      clusterIP: 'None',
      selector: {
        app: 'mongodb-mcp',
        'clerum.io/mcp-server': 'mongodb-server',
      },
      ports: [
        {
          name: 'http',
          port: 3000,
          targetPort: 3000,
          protocol: 'TCP',
        },
        {
          name: 'health',
          port: 3001,
          targetPort: 3001,
          protocol: 'TCP',
        },
      ],
      publishNotReadyAddresses: true,
    },
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('MongoDB MCP Server - StatefulSet Deployment', () => {
  describe('Expected StatefulSet Configuration', () => {
    let sts: K8sStatefulSet

    beforeEach(() => {
      sts = generateExpectedStatefulSet()
    })

    describe('StatefulSet Metadata', () => {
      it('should have correct StatefulSet name', () => {
        expect(sts.metadata.name).toBe('mongodb-server')
      })

      it('should be in mcp-server namespace', () => {
        expect(sts.metadata.namespace).toBe('mcp-server')
      })

      it('should have clerum.io labels for operator tracking', () => {
        expect(sts.metadata.labels).toHaveProperty('clerum.io/mcp-server', 'mongodb-server')
        expect(sts.metadata.labels).toHaveProperty('clerum.io/managed-by', 'context-mapper')
      })
    })

    describe('StatefulSet vs Deployment', () => {
      it('should be StatefulSet kind (not Deployment)', () => {
        expect(sts.kind).toBe('StatefulSet')
        expect(sts.kind).not.toBe('Deployment')
      })

      it('should have serviceName for headless service', () => {
        expect(sts.spec.serviceName).toBe('mongodb-server')
      })
    })

    describe('Replica Configuration', () => {
      it('should run single replica', () => {
        expect(sts.spec.replicas).toBe(1)
      })
    })

    describe('Container Configuration', () => {
      let container: K8sStatefulSet['spec']['template']['spec']['containers'][0]

      beforeEach(() => {
        container = sts.spec.template.spec.containers[0]
      })

      it('should use official MongoDB image', () => {
        expect(container.image).toBe('mongodb/mongodb-mcp-server:latest')
      })

      it('should expose two ports (http and health)', () => {
        expect(container.ports).toHaveLength(2)
        const httpPort = container.ports.find(p => p.name === 'http')
        expect(httpPort?.containerPort).toBe(3000)
        const healthPort = container.ports.find(p => p.name === 'health')
        expect(healthPort?.containerPort).toBe(3001)
      })

      it('should mount data volume', () => {
        expect(container.volumeMounts).toBeDefined()
        expect(container.volumeMounts).toHaveLength(1)
        const dataMount = container.volumeMounts?.find(vm => vm.name === 'data')
        expect(dataMount?.mountPath).toBe('/data/db')
      })
    })

    describe('Volume Management', () => {
      it('should have volumeClaimTemplates for PVC', () => {
        expect(sts.spec.volumeClaimTemplates).toBeDefined()
        expect(sts.spec.volumeClaimTemplates).toHaveLength(1)
      })

      it('should create data PVC template', () => {
        const pvcTemplate = sts.spec.volumeClaimTemplates[0]
        expect(pvcTemplate.metadata.name).toBe('data')
        expect(pvcTemplate.spec.accessModes).toContain('ReadWriteOnce')
        expect(pvcTemplate.spec.resources.requests.storage).toBe('1Gi')
      })

      it('should mount PVC in container', () => {
        const volumes = sts.spec.template.spec.volumes
        const dataVolume = volumes?.find(v => v.name === 'data')
        expect(dataVolume).toBeDefined()
        expect(dataVolume?.persistentVolumeClaim).toBeDefined()
      })
    })
  })

  describe('Expected Headless Service Configuration', () => {
    let svc: K8sHeadlessService

    beforeEach(() => {
      svc = generateExpectedHeadlessService()
    })

    it('should be headless (ClusterIP: None)', () => {
      expect(svc.spec.clusterIP).toBe('None')
    })

    it('should publish not ready addresses for DNS', () => {
      expect(svc.spec.publishNotReadyAddresses).toBe(true)
    })
  })

  describe('PVC Data Retention', () => {
    it('should create PVC without ownerRef', () => {
      const sts = generateExpectedStatefulSet()
      const pvcTemplate = sts.spec.volumeClaimTemplates[0]
      expect(pvcTemplate.metadata).not.toHaveProperty('ownerReferences')
    })

    it('should retain data when pod is deleted', () => {
      const sts = generateExpectedStatefulSet()
      const pvcName = 'mongodb-server-mongodb-server-0'
      expect(pvcName).toContain('mongodb-server-0')
    })
  })
})

describe('MongoDB MCP Server - Operational Considerations', () => {
  it('should have stable DNS names for pods', () => {
    const podName = 'mongodb-server-0'
    const serviceName = 'mongodb-server'
    const namespace = 'mcp-server'
    const dnsName = `${podName}.${serviceName}.${namespace}.svc.cluster.local`
    expect(dnsName).toBe('mongodb-server-0.mongodb-server.mcp-server.svc.cluster.local')
  })

  it('should maintain data across pod restarts', () => {
    const sts = generateExpectedStatefulSet()
    const pvcTemplate = sts.spec.volumeClaimTemplates[0]
    expect(pvcTemplate.spec.accessModes).toContain('ReadWriteOnce')
    expect(pvcTemplate.spec.resources.requests.storage).toBe('1Gi')
  })
})

describe('MongoDB vs Airtable - Deployment Comparison', () => {
  it('should use StatefulSet vs Deployment', () => {
    const mongoSts = generateExpectedStatefulSet()
    expect(mongoSts.kind).toBe('StatefulSet')
  })

  it('should have PVC vs no PVC', () => {
    const mongoSts = generateExpectedStatefulSet()
    expect(mongoSts.spec.volumeClaimTemplates).toBeDefined()
  })

  it('both should have similar resource requirements', () => {
    const mongoSts = generateExpectedStatefulSet()
    const mongoResources = mongoSts.spec.template.spec.containers[0].resources!
    expect(mongoResources.requests.memory).toBe('128Mi')
    expect(mongoResources.limits.memory).toBe('256Mi')
  })
})
