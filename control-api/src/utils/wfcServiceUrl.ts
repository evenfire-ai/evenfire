import { createHash } from 'node:crypto'
import { config } from '../config.js'

export function sharedFileSystemHash(name: string, namespace: string): string {
  return createHash('sha256').update(`${namespace}/${name}`).digest('hex').slice(0, 10)
}

export function wfcServiceUrl(name: string, namespace: string): string {
  return config.wfcServiceUrlTemplate.replace('{hash}', sharedFileSystemHash(name, namespace))
}
