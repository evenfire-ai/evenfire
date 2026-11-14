import { describe, expect, it } from 'vitest'
import { GFS_HOME_CONFLICT_TEXT, GFS_HOME_PENDING_TEXT } from '@constants/gfsBrowser'
import { callerHomeNotice } from '../callerHome'

const home = (state: string) => ({ state, drive: null, resourceId: null, path: null })

describe('callerHomeNotice', () => {
  it('reports a load error, even over a stored state', () => {
    expect(callerHomeNotice(home('conflict'), 'Home service unavailable')).toEqual({
      kind: 'error',
      text: 'Home service unavailable',
    })
    expect(callerHomeNotice(null, 'Home service unavailable')).toEqual({
      kind: 'error',
      text: 'Home service unavailable',
    })
  })

  it('reports a conflict and a pending home with the sidebar sentences', () => {
    expect(callerHomeNotice(home('conflict'), null)).toEqual({
      kind: 'conflict',
      text: GFS_HOME_CONFLICT_TEXT,
    })
    expect(callerHomeNotice(home('pending'), null)).toEqual({
      kind: 'pending',
      text: GFS_HOME_PENDING_TEXT,
    })
  })

  it.each([['ready'], ['retired']])('says nothing for a %s home', state => {
    expect(callerHomeNotice(home(state), null)).toBeNull()
  })

  it('says nothing without home data or an error', () => {
    expect(callerHomeNotice(null, null)).toBeNull()
  })
})
