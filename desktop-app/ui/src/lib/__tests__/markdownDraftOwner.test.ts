import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  MARKDOWN_DRAFT_MAX_BYTES,
  type MarkdownDraftBinding,
  MarkdownDraftOwner,
  type MarkdownDraftRecordSnapshot,
} from '../markdownDraftOwner'

const binding: MarkdownDraftBinding = {
  principalOwner: 'principal-owner-1',
  scopeKey: 'principal-1/team-a/env-dev',
  tabId: 'preview-tab-1',
  gfsUri: 'gfs://main/resource-1',
}

const owners: MarkdownDraftOwner[] = []

function createOwner(content = 'saved', version = 1): MarkdownDraftOwner {
  const owner = new MarkdownDraftOwner()
  owner.open(binding, { savedSnapshot: { content, version }, sessionGeneration: 1 })
  owners.push(owner)
  const capability = owner.beginCapabilityRefresh(binding)
  if (!capability) throw new Error('capability request was not reserved')
  owner.completeCapabilityRefresh(capability, true)
  return owner
}

function readyState(owner: MarkdownDraftOwner): MarkdownDraftRecordSnapshot {
  const current = owner.get(binding)
  if (!current) throw new Error('record missing')
  return current
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.quit()
})

describe('MarkdownDraftOwner', () => {
  it('keys records by principal, scope, tab, and exact GFS URI', () => {
    const owner = createOwner()
    const sameTabOtherFile = { ...binding, gfsUri: 'gfs://main/resource-2' }
    const otherScope = { ...binding, scopeKey: 'principal-1/team-b/env-dev' }
    const otherPrincipal = { ...binding, principalOwner: 'principal-owner-2' }

    owner.open(sameTabOtherFile, { savedSnapshot: { content: 'other', version: 1 } })
    owner.open(otherScope, { savedSnapshot: { content: 'scope b', version: 1 } })
    owner.open(otherPrincipal, { savedSnapshot: { content: 'other user', version: 1 } })
    expect(owner.get(binding)?.draft).toBe('saved')
    expect(owner.get(sameTabOtherFile)?.draft).toBe('other')
    expect(owner.get(otherScope)?.draft).toBe('scope b')
    expect(owner.get(otherPrincipal)?.draft).toBe('other user')
  })

  it('never exposes another file draft from the same tab', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'secret draft for file A')
    const fileB = { ...binding, gfsUri: 'gfs://main/resource-2' }
    owner.open(fileB, { savedSnapshot: { content: 'saved file B', version: 1 } })
    expect(owner.getVisibleRecord(fileB)?.draft).toBe('saved file B')
    expect(owner.getVisibleRecord(fileB)?.editing).toBe(false)
    expect(owner.getVisibleRecord(binding)?.draft).toBe('secret draft for file A')
  })

  it('hides the prior scope until a verified team scope is published', () => {
    const owner = createOwner()
    expect(owner.getVisibleRecord(binding)?.draft).toBe('saved')
    const transition = owner.beginScopeTransition()
    expect(transition).not.toBeNull()
    expect(owner.hasPendingTransition()).toBe(true)
    expect(owner.getVisibleRecord(binding)).toBeNull()
    expect(owner.commitScopeTransitionRender(transition!)).toBe(true)

    const nextScope = 'principal-1/team-b/env-dev'
    expect(owner.installMainSession(transition!, 2)).toBe(true)
    expect(owner.publishScope(transition!, binding.principalOwner, nextScope, 2)).toBe(true)
    expect(owner.hasPendingTransition()).toBe(false)
    expect(owner.getVisibleRecord(binding)).toBeNull()
    expect(owner.get(binding)?.draft).toBe('saved')
  })

  it('requires the latest stable read and positive current capability before Edit', () => {
    const owner = new MarkdownDraftOwner()
    owners.push(owner)
    owner.open(binding)
    const firstRead = owner.beginStableRead(binding)!
    const oldCapability = owner.beginCapabilityRefresh(binding)!
    expect(owner.beginEdit(binding)).toBe(false)

    const latestCapability = owner.beginCapabilityRefresh(binding)!
    expect(owner.completeCapabilityRefresh(oldCapability, true)).toBe(false)
    expect(owner.completeCapabilityRefresh(latestCapability, true)).toBe(true)
    expect(owner.beginEdit(binding)).toBe(false)
    expect(
      owner.completeStableRead(firstRead, { content: 'coherent', version: 7, stable: true })
    ).toBe(true)
    expect(owner.beginEdit(binding)).toBe(true)
    expect(readyState(owner).draft).toBe('coherent')

    const refresh = owner.beginCapabilityRefresh(binding)!
    expect(owner.beginEdit(binding)).toBe(false)
    expect(owner.completeCapabilityRefresh(refresh, false)).toBe(true)
    expect(owner.beginEdit(binding)).toBe(false)
  })

  it('keeps the submitted Save immutable while later typing stays dirty', () => {
    const owner = createOwner()
    expect(owner.beginEdit(binding)).toBe(true)
    expect(owner.type(binding, 'submitted text')).toBe(true)
    const request = owner.reserveSave(binding)
    expect(request).toMatchObject({ submitted: 'submitted text', expectedSessionGeneration: 1 })
    expect(request).not.toHaveProperty('ifMatch')
    expect(Object.isFrozen(request)).toBe(true)
    expect(owner.reserveSave(binding)).toBeNull()
    expect(owner.type(binding, 'newer draft')).toBe(true)
    expect(owner.completeSave(request!, { kind: 'success', version: 2 })).toBe(true)

    expect(readyState(owner)).toMatchObject({
      savedSnapshot: { content: 'submitted text', version: 2 },
      lastWriteAck: { content: 'submitted text', version: 2 },
      draft: 'newer draft',
      localBaseline: 'submitted text',
      dirty: true,
      editing: true,
      pendingSave: null,
      viewCandidate: null,
    })
  })

  it('uses a verified newer generation for future saves without changing an issued request', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'first draft')
    const issued = owner.reserveSave(binding)!
    expect(issued.expectedSessionGeneration).toBe(1)

    owner.setActiveScope(binding.principalOwner, binding.scopeKey, 2)
    const read = owner.beginStableRead(binding)!
    const capability = owner.beginCapabilityRefresh(binding)!
    owner.completeStableRead(read, { content: 'server v2', version: 2, stable: true })
    owner.completeCapabilityRefresh(capability, true)
    expect(issued.expectedSessionGeneration).toBe(1)
    owner.completeSave(issued, { kind: 'failure' })

    const next = owner.reserveSave(binding)
    expect(next?.expectedSessionGeneration).toBe(2)
  })

  it('does not invalidate current reads when the same authoritative scope is re-published', () => {
    const owner = createOwner()
    const read = owner.beginStableRead(binding)!
    owner.completeStableRead(read, { content: 'saved', version: 1, stable: true })
    const capability = owner.beginCapabilityRefresh(binding)!
    owner.completeCapabilityRefresh(capability, true)

    owner.setActiveScope(binding.principalOwner, binding.scopeKey, 1)

    expect(readyState(owner)).toMatchObject({ readReady: true, capability: 'positive' })
  })

  it('does not regress a newer observed version when an older Save completes', () => {
    const owner = createOwner('v7', 7)
    owner.beginEdit(binding)
    owner.type(binding, 'submitted-v8')
    const request = owner.reserveSave(binding)!
    owner.observeVersion(binding, 9)
    owner.completeSave(request, { kind: 'success', version: 8 })
    expect(readyState(owner)).toMatchObject({
      savedSnapshot: { content: 'v7', version: 7 },
      lastWriteAck: { content: 'submitted-v8', version: 8 },
      observedVersion: 9,
      remoteAhead: true,
      draft: 'submitted-v8',
      dirty: true,
      viewCandidate: null,
    })
  })

  it('retains drafts and releases the close block after definite or ambiguous failure', () => {
    for (const failure of ['failure', 'ambiguous'] as const) {
      const owner = createOwner()
      owner.beginEdit(binding)
      owner.type(binding, `draft-${failure}`)
      const request = owner.reserveSave(binding)!
      expect(owner.requestClose(binding.tabId)).toBe('blocked')
      expect(owner.completeSave(request, { kind: failure })).toBe(true)
      expect(owner.get(binding)).toMatchObject({
        draft: `draft-${failure}`,
        dirty: true,
        editing: true,
        pendingSave: null,
      })
      expect(owner.requestClose(binding.tabId)).toBe('confirm')
    }
  })

  it('pairs bytes with a stable non-regressing version and ignores stale read tokens', () => {
    const owner = createOwner('v7', 7)
    const oldRead = owner.beginStableRead(binding)!
    const newRead = owner.beginStableRead(binding)!
    expect(owner.completeStableRead(oldRead, { content: 'v8', version: 8, stable: true })).toBe(
      false
    )
    expect(owner.completeStableRead(newRead, { content: 'torn', version: 9, stable: false })).toBe(
      true
    )
    expect(readyState(owner)).toMatchObject({
      savedSnapshot: { content: 'v7', version: 7 },
      readReady: true,
    })
    const coherent = owner.beginStableRead(binding)!
    owner.completeStableRead(coherent, { content: 'v9', version: 9, stable: true })
    expect(readyState(owner).savedSnapshot).toEqual({ content: 'v9', version: 9 })
    expect(readyState(owner).draft).toBe('v7')
  })

  it('checks UTF-8 byte size at the synchronous Save reservation boundary', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'é'.repeat(Math.floor(MARKDOWN_DRAFT_MAX_BYTES / 2) + 1))
    expect(readyState(owner).sizeExceeded).toBe(true)
    expect(owner.reserveSave(binding)).toBeNull()
    owner.type(binding, 'é'.repeat(MARKDOWN_DRAFT_MAX_BYTES / 2))
    expect(readyState(owner).sizeExceeded).toBe(false)
    expect(owner.reserveSave(binding)?.submitted).toBe('é'.repeat(MARKDOWN_DRAFT_MAX_BYTES / 2))
  })

  it('blocks close during any scoped Save, then prompts once for retained dirty drafts', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'team a draft')
    const save = owner.reserveSave(binding)!
    const teamB = { ...binding, scopeKey: 'principal-1/team-b/env-dev' }
    owner.open(teamB, { savedSnapshot: { content: 'team b saved', version: 1 } })
    owner.setActiveScope(binding.principalOwner, teamB.scopeKey, 2)
    expect(owner.requestClose(binding.tabId)).toBe('blocked')
    owner.completeSave(save, { kind: 'failure' })
    expect(owner.requestClose(binding.tabId)).toBe('confirm')
    expect(owner.resolveClose(binding.tabId, 'stay')).toBe(true)
    expect(owner.get(binding)?.draft).toBe('team a draft')
    expect(owner.get(teamB)?.draft).toBe('team b saved')
    expect(owner.requestClose(binding.tabId)).toBe('confirm')
    expect(owner.resolveClose(binding.tabId, 'discard')).toBe(true)
    expect(owner.type(teamB, 'stale input')).toBe(false)
    expect(owner.promoteCloseReservation(binding.tabId, 'main-close-permit')).toBe(true)
    expect(owner.commitClose(binding.tabId)).toBe(true)
    expect(owner.get(binding)).toBeNull()
    expect(owner.get(teamB)).toBeNull()
  })

  it('reserves dirty-close acceptance before queued typing or Save can dispatch', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'discard me')
    expect(owner.requestClose(binding.tabId)).toBe('confirm')
    expect(owner.resolveClose(binding.tabId, 'discard')).toBe(true)
    expect(owner.type(binding, 'queued post-close input')).toBe(false)
    expect(owner.reserveSave(binding)).toBeNull()
    expect(owner.promoteCloseReservation(binding.tabId, 'close-permit')).toBe(true)
    expect(owner.commitClose(binding.tabId)).toBe(true)
    expect(owner.get(binding)).toBeNull()
  })

  it('gates same-principal scope re-entry on fresh read and capability without changing owner ID', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'preserved')
    const ownerId = readyState(owner).ownerId
    const transition = owner.beginScopeTransition()!
    expect(owner.commitScopeTransitionRender(transition)).toBe(true)
    expect(owner.getVisibleRecord(binding)).toBeNull()
    expect(owner.type(binding, 'hidden')).toBe(false)
    expect(owner.installMainSession(transition, 2)).toBe(true)
    expect(
      owner.publishScope(transition, binding.principalOwner, 'principal-1/team-b/env-dev', 2)
    ).toBe(true)
    expect(owner.get(binding)?.draft).toBe('preserved')
    expect(owner.getVisibleRecord(binding)).toBeNull()

    const teamB = { ...binding, scopeKey: 'principal-1/team-b/env-dev' }
    owner.open(teamB)
    const teamBRead = owner.beginStableRead(teamB)!
    const teamBCapability = owner.beginCapabilityRefresh(teamB)!
    owner.completeStableRead(teamBRead, { content: 'b saved', version: 1, stable: true })
    owner.completeCapabilityRefresh(teamBCapability, true)
    expect(owner.getVisibleRecord(teamB)?.draft).toBe('b saved')

    const backToA = owner.beginScopeTransition()!
    expect(owner.commitScopeTransitionRender(backToA)).toBe(true)
    expect(owner.installMainSession(backToA, 3)).toBe(true)
    expect(owner.publishScope(backToA, binding.principalOwner, binding.scopeKey, 3)).toBe(true)
    const readA = owner.beginStableRead(binding)!
    const capA = owner.beginCapabilityRefresh(binding)!
    owner.completeStableRead(readA, { content: 'new saved A', version: 2, stable: true })
    expect(owner.get(binding)?.editing).toBe(false)
    owner.completeCapabilityRefresh(capA, true)
    expect(owner.get(binding)).toMatchObject({
      ownerId,
      bindingSessionGeneration: 3,
      draft: 'preserved',
      editing: true,
      dirty: true,
    })
    const reenteredSave = owner.reserveSave(binding)
    expect(reenteredSave).toMatchObject({ expectedSessionGeneration: 3, submitted: 'preserved' })
    expect(reenteredSave).not.toHaveProperty('ifMatch')
  })

  it('uses an auth-neutral barrier before retiring drafts and preserves drafts on same-session recovery', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'dirty')
    const recovery = owner.beginAuthBarrier(binding.principalOwner, 1, true)!
    expect(owner.reserveAuthBarrierFromMain(recovery)).toBe(false)
    expect(owner.commitAuthNeutralSurface(recovery)).toBe(true)
    expect(owner.reserveAuthBarrierFromMain(recovery)).toBe(true)
    expect(owner.retirePrincipalAfterAuthBarrier(recovery)).toBe(false)
    expect(owner.get(binding)?.draft).toBe('dirty')
    expect(owner.acknowledgeAuthNeutralSurface(recovery)).toBe(true)
    expect(owner.getVisibleRecord(binding)).toBeNull()
    expect(owner.retirePrincipalAfterAuthBarrier(recovery)).toBe(true)
    expect(owner.get(binding)).toBeNull()

    const restoreOwner = createOwner()
    restoreOwner.beginEdit(binding)
    restoreOwner.type(binding, 'recoverable')
    const barrier = restoreOwner.beginAuthBarrier(binding.principalOwner, 1, false)!
    restoreOwner.commitAuthNeutralSurface(barrier)
    expect(restoreOwner.requestClose(binding.tabId)).toBe('blocked')
    restoreOwner.acknowledgeAuthNeutralSurface(barrier)
    expect(restoreOwner.restoreAfterAuthBarrier(barrier, 1)).toBe(true)
    expect(restoreOwner.get(binding)).toMatchObject({
      draft: 'recoverable',
      editing: false,
      resumeEditPending: true,
      capability: 'unknown',
      readReady: false,
    })
    const read = restoreOwner.beginStableRead(binding)!
    const capability = restoreOwner.beginCapabilityRefresh(binding)!
    restoreOwner.completeStableRead(read, { content: 'fresh saved', version: 2, stable: true })
    restoreOwner.completeCapabilityRefresh(capability, true)
    expect(restoreOwner.get(binding)).toMatchObject({ draft: 'recoverable', editing: true })
  })

  it('drops every record on quit and synchronously notifies subscribers', () => {
    const owner = createOwner()
    const listener = vi.fn()
    owner.subscribe(listener)
    owner.beginEdit(binding)
    owner.type(binding, 'never persisted')
    expect(listener).toHaveBeenCalled()
    owner.quit()
    expect(owner.get(binding)).toBeNull()
    expect(owner.open(binding)).toBeNull()
  })

  it('ignores read, capability, and Save completions after quit', () => {
    const owner = createOwner()
    owner.beginEdit(binding)
    owner.type(binding, 'submitted before quit')
    const save = owner.reserveSave(binding)!
    const read = owner.beginStableRead(binding)!
    const capability = owner.beginCapabilityRefresh(binding)!
    const listener = vi.fn()
    owner.subscribe(listener)

    owner.quit()
    const notificationsAfterQuit = listener.mock.calls.length
    expect(owner.completeStableRead(read, { content: 'late read', version: 2, stable: true })).toBe(
      false
    )
    expect(owner.completeCapabilityRefresh(capability, true)).toBe(false)
    expect(owner.completeSave(save, { kind: 'success', version: 3 })).toBe(false)
    expect(listener).toHaveBeenCalledTimes(notificationsAfterQuit)
    expect(owner.get(binding)).toBeNull()
    expect(owner.open(binding)).toBeNull()
  })
})

describe('MarkdownDraftOwner generated command oracle', () => {
  it('matches a small independent content contract across generated edit/save/close events', () => {
    type Model = {
      baseline: string
      draft: string
      editing: boolean
      pending: number | null
      closed: boolean
    }
    type Real = { owner: MarkdownDraftOwner }
    const assertEquivalent = (model: Model, owner: MarkdownDraftOwner) => {
      if (model.closed) {
        expect(owner.get(binding)).toBeNull()
        return
      }
      const current = owner.get(binding)
      expect(current).toMatchObject({
        localBaseline: model.baseline,
        draft: model.draft,
        editing: model.editing,
        pendingSave: model.pending === null ? null : { id: model.pending },
        dirty: model.draft !== model.baseline,
      })
    }
    class Edit implements fc.Command<Model, Real> {
      check(m: Readonly<Model>) {
        return !m.closed && !m.editing && m.pending === null
      }
      run(m: Model, r: Real) {
        const allowed = r.owner.beginEdit(binding)
        if (allowed) {
          m.editing = true
          m.draft = m.baseline
        }
        assertEquivalent(m, r.owner)
      }
      toString() {
        return 'Edit'
      }
    }
    class Type implements fc.Command<Model, Real> {
      constructor(private readonly value: string) {}
      check(m: Readonly<Model>) {
        return !m.closed && m.editing
      }
      run(m: Model, r: Real) {
        expect(r.owner.type(binding, this.value)).toBe(true)
        m.draft = this.value
        assertEquivalent(m, r.owner)
      }
      toString() {
        return `Type(${JSON.stringify(this.value)})`
      }
    }
    class Save implements fc.Command<Model, Real> {
      check(m: Readonly<Model>) {
        return !m.closed && m.editing && m.pending === null && m.draft !== m.baseline
      }
      run(m: Model, r: Real) {
        const request = r.owner.reserveSave(binding)
        expect(request?.submitted).toBe(m.draft)
        expect(request).not.toHaveProperty('ifMatch')
        m.pending = request!.id
        const version = (r.owner.get(binding)?.observedVersion ?? 0) + 1
        r.owner.completeSave(request!, { kind: 'success', version })
        r.owner.commitSaveView(request!.id, binding)
        m.pending = null
        m.baseline = m.draft
        m.editing = false
        assertEquivalent(m, r.owner)
      }
      toString() {
        return 'SaveAndResolveSuccess'
      }
    }
    class Discard implements fc.Command<Model, Real> {
      check(m: Readonly<Model>) {
        return !m.closed && m.editing && m.pending === null
      }
      run(m: Model, r: Real) {
        expect(r.owner.discard(binding)).toBe(true)
        m.draft = m.baseline
        m.editing = false
        assertEquivalent(m, r.owner)
      }
      toString() {
        return 'Discard'
      }
    }
    class Close implements fc.Command<Model, Real> {
      check(m: Readonly<Model>) {
        return !m.closed && m.pending === null
      }
      run(m: Model, r: Real) {
        const result = r.owner.requestClose(binding.tabId)
        if (m.draft !== m.baseline) {
          expect(result).toBe('confirm')
          expect(r.owner.resolveClose(binding.tabId, 'stay')).toBe(true)
        } else {
          expect(result).toBe('reserved')
          expect(r.owner.promoteCloseReservation(binding.tabId, 'model-close-permit')).toBe(true)
          expect(r.owner.commitClose(binding.tabId)).toBe(true)
          m.closed = true
        }
        assertEquivalent(m, r.owner)
      }
      toString() {
        return 'CloseOrStay'
      }
    }

    const commands = [
      fc.constant(new Edit()),
      fc.string({ maxLength: 12 }).map(value => new Type(value)),
      fc.constant(new Save()),
      fc.constant(new Discard()),
      fc.constant(new Close()),
    ]
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 35 }), generated => {
        const owner = createOwner()
        const model: Model = {
          baseline: 'saved',
          draft: 'saved',
          editing: false,
          pending: null,
          closed: false,
        }
        fc.modelRun(() => ({ model, real: { owner } }), generated)
        assertEquivalent(model, owner)
      }),
      { numRuns: 150 }
    )
  })

  it('generates same-principal scope round trips with independently ordered read and capability', () => {
    type Model = {
      scope: 'team-a' | 'team-b'
      generation: number
      bindingGeneration: number
      savedContent: string
      baseline: string
      draft: string
      editing: boolean
      resumePending: boolean
      readReady: boolean
      capability: 'positive' | 'unknown'
    }
    type Real = { owner: MarkdownDraftOwner }
    const assertState = (model: Model, owner: MarkdownDraftOwner) => {
      expect(owner.get(binding)).toMatchObject({
        localBaseline: model.baseline,
        draft: model.draft,
        dirty: model.draft !== model.baseline,
        editing: model.editing,
        resumeEditPending: model.resumePending,
        readReady: model.readReady,
        capability: model.capability,
        bindingSessionGeneration: model.bindingGeneration,
      })
    }
    const resumeIfReady = (model: Model) => {
      if (model.resumePending && model.readReady && model.capability === 'positive') {
        model.editing = true
        model.resumePending = false
      }
    }
    class SwitchScope implements fc.Command<Model, Real> {
      check() {
        return true
      }
      run(model: Model, real: Real) {
        const token = real.owner.beginScopeTransition()!
        expect(real.owner.commitScopeTransitionRender(token)).toBe(true)
        const nextScope = model.scope === 'team-a' ? 'team-b' : 'team-a'
        const nextGeneration = model.generation + 1
        expect(real.owner.installMainSession(token, nextGeneration)).toBe(true)
        expect(
          real.owner.publishScope(
            token,
            binding.principalOwner,
            nextScope === 'team-a' ? binding.scopeKey : 'principal-1/team-b/env-dev',
            nextGeneration
          )
        ).toBe(true)
        model.scope = nextScope
        model.generation = nextGeneration
        if (nextScope === 'team-a') model.bindingGeneration = nextGeneration
        model.editing = false
        model.resumePending = model.draft !== model.baseline
        model.readReady = false
        model.capability = 'unknown'
        assertState(model, real.owner)
      }
      toString() {
        return 'SwitchScope'
      }
    }
    class Edit implements fc.Command<Model, Real> {
      check(model: Readonly<Model>) {
        return (
          model.scope === 'team-a' &&
          model.readReady &&
          model.capability === 'positive' &&
          !model.editing
        )
      }
      run(model: Model, real: Real) {
        expect(real.owner.beginEdit(binding)).toBe(true)
        model.baseline = model.savedContent
        model.draft = model.savedContent
        model.editing = true
        model.resumePending = false
        assertState(model, real.owner)
      }
      toString() {
        return 'Edit'
      }
    }
    class Type implements fc.Command<Model, Real> {
      constructor(private readonly value: string) {}
      check(model: Readonly<Model>) {
        return model.scope === 'team-a' && model.editing
      }
      run(model: Model, real: Real) {
        expect(real.owner.type(binding, this.value)).toBe(true)
        model.draft = this.value
        assertState(model, real.owner)
      }
      toString() {
        return `Type(${JSON.stringify(this.value)})`
      }
    }
    class Read implements fc.Command<Model, Real> {
      check(model: Readonly<Model>) {
        return model.scope === 'team-a' && !model.readReady
      }
      run(model: Model, real: Real) {
        const token = real.owner.beginStableRead(binding)!
        expect(
          real.owner.completeStableRead(token, {
            content: 'fresh server content',
            version: model.generation,
            stable: true,
          })
        ).toBe(true)
        model.savedContent = 'fresh server content'
        model.readReady = true
        resumeIfReady(model)
        assertState(model, real.owner)
      }
      toString() {
        return 'FreshRead'
      }
    }
    class Capability implements fc.Command<Model, Real> {
      check(model: Readonly<Model>) {
        return model.scope === 'team-a' && model.capability === 'unknown'
      }
      run(model: Model, real: Real) {
        const token = real.owner.beginCapabilityRefresh(binding)!
        expect(real.owner.completeCapabilityRefresh(token, true)).toBe(true)
        model.capability = 'positive'
        resumeIfReady(model)
        assertState(model, real.owner)
      }
      toString() {
        return 'FreshPositiveCapability'
      }
    }

    const commands = [
      fc.constant(new SwitchScope()),
      fc.constant(new Edit()),
      fc.string({ maxLength: 10 }).map(value => new Type(value)),
      fc.constant(new Read()),
      fc.constant(new Capability()),
    ]
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 30 }), generated => {
        const owner = createOwner()
        const model: Model = {
          scope: 'team-a',
          generation: 1,
          bindingGeneration: 1,
          savedContent: 'saved',
          baseline: 'saved',
          draft: 'saved',
          editing: false,
          resumePending: false,
          readReady: true,
          capability: 'positive',
        }
        fc.modelRun(() => ({ model, real: { owner } }), generated)
        assertState(model, owner)
      }),
      { numRuns: 150 }
    )
  })

  it('uses fc.scheduler to exercise Save completion versus newer typing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const owner = createOwner()
        owner.beginEdit(binding)
        owner.type(binding, 'submitted')
        const request = owner.reserveSave(binding)!
        const model = { baseline: 'saved', draft: 'submitted', editing: true }
        const tasks = [
          scheduler.schedule(Promise.resolve(), 'type-newer').then(() => {
            owner.type(binding, 'newer')
            model.draft = 'newer'
          }),
          scheduler.schedule(Promise.resolve(), 'save-success').then(() => {
            owner.completeSave(request, { kind: 'success', version: 2 })
            model.baseline = 'submitted'
            if (model.draft === 'submitted') model.editing = false
          }),
        ]
        while (scheduler.count() > 0) await scheduler.waitOne()
        await Promise.all(tasks)
        expect(readyState(owner)).toMatchObject({
          savedSnapshot: { content: 'submitted', version: 2 },
          localBaseline: model.baseline,
          draft: model.draft,
          editing: true,
          dirty: true,
          viewCandidate: null,
        })
      }),
      { numRuns: 100 }
    )
  })

  it('schedules a late capability completion against scope publication', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const owner = createOwner()
        owner.beginEdit(binding)
        owner.type(binding, 'scope-bound draft')
        const capability = owner.beginCapabilityRefresh(binding)!
        const tasks = [
          scheduler.schedule(Promise.resolve(), 'publish-team-b').then(() => {
            const transition = owner.beginScopeTransition()!
            expect(owner.commitScopeTransitionRender(transition)).toBe(true)
            expect(owner.installMainSession(transition, 2)).toBe(true)
            expect(
              owner.publishScope(
                transition,
                binding.principalOwner,
                'principal-1/team-b/env-dev',
                2
              )
            ).toBe(true)
          }),
          scheduler.schedule(Promise.resolve(), 'late-old-scope-capability').then(() => {
            owner.completeCapabilityRefresh(capability, true)
          }),
        ]
        while (scheduler.count() > 0) await scheduler.waitOne()
        await Promise.all(tasks)
        expect(owner.get(binding)).toMatchObject({
          draft: 'scope-bound draft',
          dirty: true,
          editing: false,
          capability: 'unknown',
          capabilityPending: false,
        })
        expect(owner.getVisibleRecord(binding)).toBeNull()
      }),
      { numRuns: 100 }
    )
  })
})
