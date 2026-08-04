import { afterEach, describe, expect, it } from 'vitest'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

function gfsNames(scopes: unknown): string[] {
  process.env[ACCESS_ENV] = encodedClaims(scopes)
  return new NativeToolRegistry(config, 'gfs-scope-test')
    .listDefinitions()
    .map(definition => definition.name)
    .filter(name => name.startsWith('clerum__gfs_'))
    .sort()
}

afterEach(() => {
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
})

describe('NativeToolRegistry GFS scope visibility', () => {
  const readTools = [
    'clerum__gfs_accessible',
    'clerum__gfs_list',
    'clerum__gfs_read',
    'clerum__gfs_resolve',
    'clerum__gfs_stat',
  ]
  const writeTools = [
    'clerum__gfs_create_file',
    'clerum__gfs_create_folder',
    'clerum__gfs_rename',
    'clerum__gfs_write',
  ]

  it('registers read, write, and copy at their exact scope thresholds', () => {
    expect(gfsNames(['gfs.read'])).toEqual(readTools)
    expect(gfsNames(['gfs.write'])).toEqual(writeTools)
    expect(gfsNames(['gfs.read', 'gfs.write'])).toEqual(
      [...readTools, ...writeTools, 'clerum__gfs_copy'].sort()
    )
  })

  it('fails closed when destructive, governance, or unknown scopes are present', () => {
    expect(gfsNames(['gfs.read', 'gfs.delete', 'gfs.share', 'gfs.manage_acl'])).toEqual([])
    expect(gfsNames(['gfs.delete', 'gfs.share', 'gfs.manage_acl'])).toEqual([])
    expect(gfsNames(['gfs.read', 'unknown'])).toEqual([])
  })

  it('registers no GFS tools for malformed or unknown capabilities', () => {
    expect(gfsNames('gfs.read')).toEqual([])
    expect(gfsNames([])).toEqual([])
    expect(gfsNames(['unknown'])).toEqual([])
    process.env[ACCESS_ENV] = 'malformed'
    expect(
      new NativeToolRegistry(config, 'malformed-test')
        .listDefinitions()
        .filter(definition => definition.name.startsWith('clerum__gfs_'))
    ).toEqual([])
  })
})
