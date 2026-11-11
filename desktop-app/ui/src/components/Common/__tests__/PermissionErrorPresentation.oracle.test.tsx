// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import fc from 'fast-check'
import { PermissionErrorDialog } from '@components/Common'
import type { PermissionErrorItem } from '../PermissionErrorDialog/types'
import {
  acknowledgePermissionErrors,
  isPermissionErrorAcknowledged,
} from '../permissionErrorAcknowledgement'

afterEach(cleanup)

type Model = {
  generation: number
  acknowledged: Set<number>
  dismissed: boolean
}

type Real = {
  query: { state: { fetchStatus: string } }
  generation: number
  dismissed: boolean
  rerender: () => void
}

function item(real: Real): PermissionErrorItem {
  return {
    id: `resource:${real.generation}`,
    message: 'Could not verify permissions for report.txt.',
    errorUpdateCount: real.generation,
    queryIdentity: real.query,
    retry: () => {
      real.query.state.fetchStatus = 'fetching'
    },
  }
}

function projectedErrors(real: Real): PermissionErrorItem[] {
  const current = item(real)
  return real.dismissed || isPermissionErrorAcknowledged(current) ? [] : [current]
}

class RetryCurrentFailure implements fc.Command<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return !model.dismissed && !model.acknowledged.has(model.generation)
  }

  run(model: Model, real: Real): void {
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    model.acknowledged.add(model.generation)
    real.rerender()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  }

  toString(): string {
    return 'retry the current failed permission query'
  }
}

class DismissCurrentFailure implements fc.Command<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return !model.dismissed && !model.acknowledged.has(model.generation)
  }

  run(model: Model, real: Real): void {
    fireEvent.keyDown(document, { key: 'Escape' })
    model.acknowledged.add(model.generation)
    model.dismissed = true
    real.rerender()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  }

  toString(): string {
    return 'dismiss the current permission failure'
  }
}

class ResolveAsNewFailure implements fc.Command<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.dismissed || model.acknowledged.has(model.generation)
  }

  run(model: Model, real: Real): void {
    model.generation += 1
    model.acknowledged.delete(model.generation)
    model.dismissed = false
    real.generation = model.generation
    real.dismissed = false
    real.query.state.fetchStatus = 'idle'
    real.rerender()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  }

  toString(): string {
    return 'settle a later permission request with a new error generation'
  }
}

describe('permission error acknowledgement oracle', () => {
  it('matches the independent generation model through generated UI events', () => {
    fc.assert(
      fc.property(
        fc.commands(
          [
            fc.constant(new RetryCurrentFailure()),
            fc.constant(new DismissCurrentFailure()),
            fc.constant(new ResolveAsNewFailure()),
          ],
          { maxCommands: 18 }
        ),
        commands => {
          const model: Model = { generation: 1, acknowledged: new Set(), dismissed: false }
          const real: Real = {
            query: { state: { fetchStatus: 'idle' } },
            generation: 1,
            dismissed: false,
            rerender: () => undefined,
          }
          const view = render(
            <PermissionErrorDialog
              errors={projectedErrors(real)}
              onDismiss={() => {
                real.dismissed = true
              }}
            />
          )
          real.rerender = () =>
            view.rerender(
              <PermissionErrorDialog
                errors={projectedErrors(real)}
                onDismiss={() => {
                  real.dismissed = true
                }}
              />
            )
          expect(screen.getByRole('alertdialog')).toBeTruthy()
          fc.modelRun(() => ({ model, real }), commands)
          expect(projectedErrors(real).length).toBe(
            model.dismissed || model.acknowledged.has(model.generation) ? 0 : 1
          )
          cleanup()
        }
      ),
      { numRuns: 25 }
    )
  })

  it('does not let acknowledging one query generation hide its later failure', () => {
    const queryIdentity = {}
    const first = { id: 'resource:1', message: 'failed', queryIdentity, errorUpdateCount: 1 }
    const next = { ...first, id: 'resource:2', errorUpdateCount: 2 }
    expect(isPermissionErrorAcknowledged(first)).toBe(false)
    acknowledgePermissionErrors([first])
    expect(isPermissionErrorAcknowledged(first)).toBe(true)
    expect(isPermissionErrorAcknowledged(next)).toBe(false)
  })
})
