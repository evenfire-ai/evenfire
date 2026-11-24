/**
 * Producer fixture — the approval part of the Host CRD schema, as the
 * apiserver sees it, for the current chart and for the v0.12.1 release.
 *
 * A fake control-api uses it to model apiserver pruning (fields a schema does
 * not declare are dropped) and defaulting (`default:` values fill in on
 * present objects). The wire files are generated from
 * charts/clerum-crds/crds/host.yaml (current) and
 * `git show v0.12.1:charts/clerum-crds/crds/host.yaml` (v0.12.1); `_source`
 * records each origin. JSON is used because control-api has no `yaml` package.
 *
 * Imported by control-ui and control-api tests through a relative path, so it
 * takes no npm package imports: Node builtins only.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HostCrdApprovalVersion = 'current' | 'v0.12.1'

export type HostCrdApprovalSchema = {
  version: HostCrdApprovalVersion
  approvalProperties: Record<string, unknown>
  channelNames: string[]
  allowModeChangeDefaults: Record<string, boolean>
  _source: { command: string; sha256: string }
}

type SchemaNode = {
  properties?: Record<string, SchemaNode>
}

const WIRE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'wire')

export function loadHostCrdApprovalSchema(version: HostCrdApprovalVersion): HostCrdApprovalSchema {
  return JSON.parse(
    readFileSync(resolve(WIRE_DIR, `host-crd-approval.${version}.json`), 'utf8')
  ) as HostCrdApprovalSchema
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pruneNode(value: unknown, node: SchemaNode | undefined): unknown {
  if (!node?.properties || !isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const childNode = node.properties[key]
    if (childNode) out[key] = pruneNode(child, childNode)
  }
  return out
}

/** Drops every key the schema does not declare, recursing through declared objects. */
export function pruneApprovalBlock(
  block: Record<string, unknown>,
  schema: HostCrdApprovalSchema
): Record<string, unknown> {
  return pruneNode(block, {
    properties: schema.approvalProperties as Record<string, SchemaNode>,
  }) as Record<string, unknown>
}

/** Fills `allowModeChange` on channel blocks that are present; never creates a channel block. */
export function defaultApprovalBlock(
  block: Record<string, unknown>,
  schema: HostCrdApprovalSchema
): Record<string, unknown> {
  if (!isRecord(block.channels)) return { ...block }
  const channels: Record<string, unknown> = {}
  for (const [name, channel] of Object.entries(block.channels)) {
    const fallback = schema.allowModeChangeDefaults[name]
    channels[name] =
      isRecord(channel) && fallback !== undefined && channel.allowModeChange === undefined
        ? { ...channel, allowModeChange: fallback }
        : channel
  }
  return { ...block, channels }
}
