import type { InternalToolDefinition, InternalToolResult } from '../workflow/types'

/**
 * Agent gfs READ tools (spec community.md §Operator surfaces, plan P3-S04).
 * clerum__gfs_list/read/stat/resolve let an agent browse and read the Global
 * File System through gfsc, using its dedicated aud=gfs-controller token. P3 is
 * READ-ONLY — write (clerum__gfs_write) lands in P4. Every result carries the
 * stable `gfsUri` so links survive rename/move.
 */

/** The gfsc read surface, injected so the tools are unit-tested without gfsc. */
export interface GfscReadClient {
  accessible(args: { drive: string; cursor?: string }): Promise<unknown>
  list(args: { drive: string; resourceId: string; cursor?: string }): Promise<unknown>
  read(args: { drive: string; resourceId: string }): Promise<unknown>
  stat(args: { drive: string; resourceId: string }): Promise<unknown>
  resolve(args: { uri: string }): Promise<unknown>
}

function ok(content: unknown): InternalToolResult {
  return { success: true, content: typeof content === 'string' ? content : JSON.stringify(content) }
}
function fail(error: unknown): InternalToolResult {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

const driveResourceParams = {
  type: 'object',
  required: ['drive', 'resourceId'],
  properties: {
    drive: { type: 'string', description: 'gfs drive name (e.g. "main").' },
    resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
  },
} as const

/** The four read tools, bound to a gfsc client. */
export function buildGfsReadTools(client: GfscReadClient): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_accessible',
      description:
        'List GFS resources this agent can access, including effective permissions and stable gfsUri links.',
      parameters: {
        type: 'object',
        required: ['drive'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name (e.g. "main").' },
          cursor: { type: 'string', description: 'Opaque pagination cursor.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(await client.accessible(args as { drive: string; cursor?: string }))
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_list',
      description: 'List the children of a gfs directory. Returns entries with their gfsUri.',
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId'],
        properties: {
          ...driveResourceParams.properties,
          cursor: { type: 'string', description: 'Opaque pagination cursor.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.list(args as { drive: string; resourceId: string; cursor?: string })
          )
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_read',
      description: 'Read a gfs file by drive + resourceId (read-only).',
      parameters: driveResourceParams,
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(await client.read(args as { drive: string; resourceId: string }))
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_stat',
      description: 'Stat a gfs resource (name, kind, version, bytes, gfsUri).',
      parameters: driveResourceParams,
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(await client.stat(args as { drive: string; resourceId: string }))
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_resolve',
      description: 'Resolve a gfs:// URI to its current resource + canonical path.',
      parameters: {
        type: 'object',
        required: ['uri'],
        properties: { uri: { type: 'string', description: 'A gfs:// URI.' } },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(await client.resolve(args as { uri: string }))
        } catch (err) {
          return fail(err)
        }
      },
    },
  ]
}

/** The gfsc write surface (P4) — read + write. */
export interface GfscWriteClient extends GfscReadClient {
  write(args: {
    drive: string
    resourceId: string
    content: string
    ifMatch: number
  }): Promise<unknown>
}

/**
 * Agent gfs WRITE tool (plan P4-S04). clerum__gfs_write replaces a file and
 * REQUIRES If-Match (the resource version) — agent writes are writer-routed
 * conditional writes (P4-S01); the mutation is audited server-side. Destructive
 * bits (delete) stay default-denied for agents.
 */
export function buildGfsWriteTools(client: GfscWriteClient): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_write',
      description:
        'Replace a gfs file. Requires If-Match (the current version) — writer-routed optimistic concurrency.',
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId', 'content', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
          content: { type: 'string', description: 'New file content.' },
          ifMatch: { type: 'number', description: 'The resource version being replaced.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        if (typeof args.ifMatch !== 'number') {
          return fail('clerum__gfs_write requires a numeric If-Match (current version)')
        }
        try {
          return ok(
            await client.write(
              args as { drive: string; resourceId: string; content: string; ifMatch: number }
            )
          )
        } catch (err) {
          return fail(err)
        }
      },
    },
  ]
}
