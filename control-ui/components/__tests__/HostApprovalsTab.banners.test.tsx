/**
 * The Approvals tab's two info banners (spec §6.2, §6.7, Task 21b): the
 * inheriting banner and the manifest banner. The manifest fixtures are real
 * apiserver output (test/fixtures/wire, Task 8b). The expected copy is written
 * out here from the spec, not imported from the component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { manifestSignal } from '../../components/HostApprovalsTab/banners'
import type { HostResource } from '../../lib/api'
import {
  approvalSettingsDriver,
  renderApprovalsTab,
  resetApprovalTestState,
  unanswered,
} from '../../test/fixtures/approvalPageHarness'
import { seedHost } from '../../test/fixtures/approvalSection'
import { type HostObject, createFakeControlApi } from '../../test/fixtures/fakeControlApi'

const INHERITING_BANNER =
  'This agent has no approval settings of its own. It uses the cluster default, which this page cannot show. Your first save here replaces it for this agent.'

function manifestBanner(values: string): string {
  return `A deployment manifest also sets these settings. The next deploy puts back: ${values}. Change the manifest too.`
}

// Ruling 47: the banner when the manifest left no values to read, with spec
// §6.7's "set by a manifest (values not shown)" kept verbatim.
const MANIFEST_BANNER_NO_VALUES =
  'A deployment manifest also sets these settings. The next deploy puts them back; they are set by a manifest (values not shown). Change the manifest too.'

const MANIFEST_BANNER_PREFIX = 'A deployment manifest also sets these settings.'

type Wire = HostObject & { _source?: unknown }

function wire(name: string): Wire {
  return JSON.parse(
    readFileSync(resolve(__dirname, `../../test/fixtures/wire/${name}.wire.json`), 'utf8')
  ) as Wire
}

/** The recorded Host, stored as agent `foo` (the tab asks for one name). */
function fooFrom(name: string): HostObject {
  const { _source, ...host } = wire(name)
  void _source
  return { ...host, metadata: { ...host.metadata, name: 'foo' } }
}

function renderStored(host: HostObject) {
  const fake = createFakeControlApi({ hosts: { foo: host }, crd: 'current', versionRule: true })
  const tab = renderApprovalsTab({ fake, host: 'foo' })
  return { fake, tab }
}

function approvalOnly(approval: Record<string, unknown>): HostObject {
  return seedHost('foo', { approval })
}

/** A Host as the tab reads it, with `metadata` as given. */
function hostWith(metadata: Record<string, unknown>): HostResource {
  return { metadata, spec: {} } as HostResource
}

const APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

describe('HostApprovalsTab banners', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => {
    resetApprovalTestState()
    vi.unstubAllGlobals()
  })

  describe('the manifest banner on recorded Hosts (T28)', () => {
    it('T28 a Host applied with kubectl apply shows the manifest banner with its values', async () => {
      const { fake, tab } = renderStored(fooFrom('host-kubectl-applied'))
      await approvalSettingsDriver()

      expect(
        screen.getByText(manifestBanner('Highest mode: Allow all; Policy: Any channel user'))
      ).toBeInTheDocument()
      expect(screen.queryByText(INHERITING_BANNER), 'it has its own block').toBeNull()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('T28 a Host applied server-side shows the manifest banner without values', async () => {
      const { fake, tab } = renderStored(fooFrom('host-server-side-applied'))
      await approvalSettingsDriver()

      expect(screen.getByText(MANIFEST_BANNER_NO_VALUES)).toBeInTheDocument()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a Host edited through the Control UI shows no banner', async () => {
      const { fake, tab } = renderStored(fooFrom('host-control-ui-edited'))
      await approvalSettingsDriver()

      // The page rendered the block (partner), and an Update entry owns it.
      expect(screen.getByText('Allow all')).toBeInTheDocument()
      expect(screen.queryByText(MANIFEST_BANNER_PREFIX, { exact: false })).toBeNull()
      expect(screen.queryByText(INHERITING_BANNER)).toBeNull()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })
  })

  describe('manifestSignal', () => {
    it('reads the values of a client-side apply and none of a server-side apply', () => {
      const kubectl = manifestSignal(fooFrom('host-kubectl-applied') as HostResource)
      expect(kubectl).toEqual({
        managed: true,
        values: { defaultPolicy: 'channel_users', modeCeiling: 'allow_all' },
      })
      const serverSide = manifestSignal(fooFrom('host-server-side-applied') as HostResource)
      expect(serverSide).toEqual({ managed: true, values: null })
      const edited = manifestSignal(fooFrom('host-control-ui-edited') as HostResource)
      expect(edited).toEqual({ managed: false })
    })

    it('drops an annotation that is not JSON, and counts the Apply entry next to it', () => {
      const apply = {
        operation: 'Apply',
        fieldsV1: { 'f:spec': { 'f:approval': {} } },
      }
      expect(
        manifestSignal(hostWith({ annotations: { [APPLIED]: '{"spec": {"approval"' } }))
      ).toEqual({ managed: false })
      expect(
        manifestSignal(
          hostWith({ annotations: { [APPLIED]: '{"spec": {"approval"' }, managedFields: [apply] })
        )
      ).toEqual({ managed: true, values: null })
    })

    it('counts an annotation only when its spec has approval', () => {
      const note = (value: unknown) =>
        hostWith({ annotations: { [APPLIED]: JSON.stringify(value) } })
      expect(manifestSignal(note({ spec: { channels: [] } }))).toEqual({ managed: false })
      expect(manifestSignal(note({ metadata: { approval: {} } }))).toEqual({ managed: false })
      expect(manifestSignal(note({ spec: { approval: {} } }))).toEqual({
        managed: true,
        values: {},
      })
      expect(manifestSignal(note({ spec: { approval: null } }))).toEqual({
        managed: true,
        values: null,
      })
    })

    it('counts an Apply entry only when its fields have f:spec then f:approval', () => {
      const entry = (operation: string, fieldsV1: unknown) =>
        hostWith({ managedFields: [{ operation, fieldsV1 }] })
      const owns = { 'f:spec': { 'f:approval': {} } }
      expect(manifestSignal(entry('Apply', owns))).toEqual({ managed: true, values: null })
      expect(manifestSignal(entry('Update', owns))).toEqual({ managed: false })
      expect(manifestSignal(entry('Apply', { 'f:spec': { 'f:channels': {} } }))).toEqual({
        managed: false,
      })
      expect(manifestSignal(entry('Apply', { 'f:approval': {} }))).toEqual({ managed: false })
      expect(manifestSignal(entry('Apply', { 'f:metadata': { 'f:approval': {} } }))).toEqual({
        managed: false,
      })
      expect(manifestSignal(hostWith({}))).toEqual({ managed: false })
    })
  })

  describe('the values text', () => {
    function withManifest(approval: Record<string, unknown>): HostObject {
      const host = approvalOnly({})
      return {
        ...host,
        metadata: {
          ...host.metadata,
          annotations: { [APPLIED]: JSON.stringify({ spec: { approval } }) },
        },
      }
    }

    it('names counts per channel and never an approver ID', async () => {
      const { tab } = renderStored(
        withManifest({
          modeCeiling: 'auto',
          channels: {
            telegram: { enabled: true, approvers: ['tg-approver-1', 'tg-approver-2'] },
            slack: { enabled: false, allowModeChange: false, approvers: ['U-SECRET-1'] },
          },
          tools: { system_info: true, json_transform: false },
        })
      )
      await approvalSettingsDriver()

      const banner = screen.getByText(MANIFEST_BANNER_PREFIX, { exact: false })
      expect(banner.textContent).toBe(
        manifestBanner(
          'Highest mode: Auto; Telegram: on, mode change on, 2 approvers; Slack: off, mode change off, 1 approver; 2 per-tool overrides'
        )
      )
      expect(banner.textContent).not.toMatch(/tg-approver|U-SECRET/)
      tab.unmount()
    })

    it('cuts a long block so it cannot flood the banner', async () => {
      const { tab } = renderStored(
        withManifest({ modeCeiling: 'manual', shellClassifierModel: 'm'.repeat(600) })
      )
      await approvalSettingsDriver()

      const banner = screen.getByText(MANIFEST_BANNER_PREFIX, { exact: false })
      const text = banner.textContent ?? ''
      const values = text.slice(
        'A deployment manifest also sets these settings. The next deploy puts back: '.length,
        -'. Change the manifest too.'.length
      )
      expect(values.startsWith('Highest mode: Manual; Shell judge: mmmm')).toBe(true)
      expect(values).toHaveLength(200)
      expect(values.endsWith('m…')).toBe(true)
      expect(text.endsWith('. Change the manifest too.')).toBe(true)
      tab.unmount()
    })

    it('says an empty block when the manifest sets none of the settings', async () => {
      const { tab } = renderStored(withManifest({}))
      await approvalSettingsDriver()

      expect(screen.getByText(manifestBanner('an empty approval block'))).toBeInTheDocument()
      tab.unmount()
    })
  })

  describe('the inheriting banner', () => {
    it('the inheriting banner shows for an absent block', async () => {
      const { fake, tab } = renderStored(seedHost('foo'))
      await approvalSettingsDriver()

      expect(screen.getByText(INHERITING_BANNER)).toBeInTheDocument()
      expect(screen.queryByText(MANIFEST_BANNER_PREFIX, { exact: false })).toBeNull()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('does not show for an empty block, which is its own', async () => {
      const { tab } = renderStored(approvalOnly({}))
      await approvalSettingsDriver()

      expect(screen.getByText('Highest mode')).toBeInTheDocument()
      expect(screen.queryByText(INHERITING_BANNER)).toBeNull()
      tab.unmount()
    })

    it('shows above the manifest banner when a manifest recorded a block the Host lost', async () => {
      const kubectl = fooFrom('host-kubectl-applied')
      const { approval, ...spec } = kubectl.spec
      void approval
      const { tab } = renderStored({ ...kubectl, spec })
      await approvalSettingsDriver()

      const inheriting = screen.getByText(INHERITING_BANNER)
      const manifest = screen.getByText(MANIFEST_BANNER_PREFIX, { exact: false })
      expect(
        inheriting.compareDocumentPosition(manifest) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      tab.unmount()
    })
  })
})
