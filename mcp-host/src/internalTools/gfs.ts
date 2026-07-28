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
// Read failures get the same redaction floor as mutations (see mutationFail):
// only gfsc's HTTP status and a coarse public category may reach the model —
// never the response body, which could carry paths or server internals.
function fail(error: unknown): InternalToolResult {
  return redactedFail('GFS read failed', error)
}
// Locally-authored argument-validation messages carry no server data and must
// reach the model verbatim so the agent can correct its call.
function invalidArgs(message: string): InternalToolResult {
  return { success: false, error: message }
}

const driveResourceParams = {
  type: 'object',
  required: ['drive', 'resourceId'],
  properties: {
    drive: { type: 'string', description: 'gfs drive name (e.g. "main").' },
    resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
  },
} as const

/** The five read tools, bound to a gfsc client. */
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
  createFile(args: {
    drive: string
    parentResourceId: string
    name: string
    content: string
  }): Promise<unknown>
  createFolder(args: { drive: string; parentResourceId: string; name: string }): Promise<unknown>
  rename(args: {
    drive: string
    resourceId: string
    newName: string
    ifMatch: number
  }): Promise<unknown>
  copy(args: {
    drive: string
    sourceResourceId: string
    destinationParentId: string
    newName?: string
    ifMatch: number
  }): Promise<unknown>
}

// Preserve only GFSC's HTTP status and a coarse public category. The server
// keeps the detailed correlated evidence; paths, blob keys, SQL details and
// response bodies must not cross into the model-visible tool result. Keeping
// 403 distinguishable is required for immediate-revocation and isolation
// journeys, while still making every failure safe to display.
function redactedFail(label: string, error: unknown): InternalToolResult {
  const message = error instanceof Error ? error.message : String(error)
  const match = /\bgfsc\s+(\d{3})\b/i.exec(message)
  if (!match) return { success: false, error: label }
  const status = Number(match[1])
  const category =
    status === 400
      ? 'invalid_request'
      : status === 401
        ? 'unauthenticated'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status === 412
                ? 'precondition_failed'
                : status === 413
                  ? 'limit_exceeded'
                  : status >= 500
                    ? 'unavailable'
                    : 'failed'
  return { success: false, error: `${label} (gfsc ${status}: ${category})` }
}

function mutationFail(error: unknown): InternalToolResult {
  return redactedFail('GFS mutation failed', error)
}

function isValidIfMatch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
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
        'Conditionally replace the complete content of an existing gfs file. Requires If-Match (the current version).',
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
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_write requires a non-negative safe-integer If-Match')
        }
        try {
          return ok(
            await client.write(
              args as { drive: string; resourceId: string; content: string; ifMatch: number }
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_create_file',
      description: 'Create one file under an existing gfs folder.',
      parameters: {
        type: 'object',
        required: ['drive', 'parentResourceId', 'name', 'content'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          parentResourceId: { type: 'string', description: 'Destination folder resource id.' },
          name: { type: 'string', description: 'New file name.' },
          content: { type: 'string', description: 'Initial file content.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.createFile(
              args as { drive: string; parentResourceId: string; name: string; content: string }
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_create_folder',
      description: 'Create one folder under an existing gfs folder.',
      parameters: {
        type: 'object',
        required: ['drive', 'parentResourceId', 'name'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          parentResourceId: { type: 'string', description: 'Destination folder resource id.' },
          name: { type: 'string', description: 'New folder name.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.createFolder(
              args as { drive: string; parentResourceId: string; name: string }
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_rename',
      description:
        'Rename one gfs resource without moving it. Requires If-Match (the current resource version).',
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId', 'newName', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          resourceId: { type: 'string', description: 'Resource id to rename.' },
          newName: { type: 'string', description: 'New file or folder name.' },
          ifMatch: { type: 'number', description: 'The observed resource version.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_rename requires a non-negative safe-integer If-Match')
        }
        try {
          return ok(
            await client.rename(
              args as { drive: string; resourceId: string; newName: string; ifMatch: number }
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
  ]
}

/** Recursive copy is advertised only when both read and write scopes exist. */
export function buildGfsCopyTools(client: GfscWriteClient): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_copy',
      description:
        'Copy one gfs file or folder tree into a destination folder. The original remains at the source; Copy never deletes it. Requires the observed source-root If-Match; file content remains server-side.',
      parameters: {
        type: 'object',
        required: ['drive', 'sourceResourceId', 'destinationParentId', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          sourceResourceId: { type: 'string', description: 'Source file or folder resource id.' },
          destinationParentId: { type: 'string', description: 'Destination folder resource id.' },
          newName: { type: 'string', description: 'Optional explicit name for the copied root.' },
          ifMatch: { type: 'number', description: 'The observed source-root version.' },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_copy requires a non-negative safe-integer If-Match')
        }
        try {
          return ok(
            await client.copy(
              args as {
                drive: string
                sourceResourceId: string
                destinationParentId: string
                newName?: string
                ifMatch: number
              }
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
  ]
}
