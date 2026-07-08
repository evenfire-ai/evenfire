/**
 * Concrete K8sSecretReader implementation using @kubernetes/client-node CoreV1Api.
 *
 * Reads Secrets and ConfigMaps from the cluster for ModelConfigHandler's
 * provider/model → apiKey resolution pipeline.
 * */
import * as k8s from '@kubernetes/client-node'
import { getErrorCode } from '../reconciler/k8sErrors'
import type { K8sSecretReader } from './modelConfigHandler'

export class K8sSecretReaderImpl implements K8sSecretReader {
  constructor(private readonly coreApi: k8s.CoreV1Api) {}

  async readConfigMap(namespace: string, name: string): Promise<Record<string, string> | null> {
    try {
      const cm = await this.coreApi.readNamespacedConfigMap({ name, namespace })
      return cm.data ?? null
    } catch (error: unknown) {
      const code = getErrorCode(error)
      if (code === 404) return null
      throw error
    }
  }

  async readSecret(namespace: string, name: string): Promise<Record<string, string> | null> {
    try {
      const secret = await this.coreApi.readNamespacedSecret({ name, namespace })
      if (!secret.data) return null

      // Decode base64 values — K8s Secrets store data as base64
      const decoded: Record<string, string> = {}
      for (const [key, value] of Object.entries(secret.data)) {
        decoded[key] = Buffer.from(value, 'base64').toString('utf-8')
      }
      return decoded
    } catch (error: unknown) {
      const code = getErrorCode(error)
      if (code === 404) return null
      throw error
    }
  }
}
