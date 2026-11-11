import { afterEach, describe, expect, it, vi } from 'vitest'

import { COUNTDOWN, DESIGN_LIMIT } from '../protocol'
import { once } from './claude'
import { CliDesigners, Picker } from './opus'

vi.mock('./claude', () => ({ Claude: class {}, findClaude: () => null, once: vi.fn() }))

/** A requested thing's crate waits this long for it. */
const CRATE = DESIGN_LIMIT * 1000
const IN_TIME = (DESIGN_LIMIT - 8) * 1000
/** In time for the crate's 30 s, but too late to try the thing and fill the crate. */
const LATE = (DESIGN_LIMIT - 1) * 1000

function picker(): { p: Picker; wait: (ms: number) => void } {
  let t = 0
  return { p: new Picker(() => t), wait: (ms) => (t += ms) }
}

describe('the model picker', () => {
  it('keeps Opus after a design that was slow but in time for its crate, and after one that missed it', () => {
    const { p } = picker()
    p.done('opus', CRATE, DESIGN_LIMIT * 1000 - 2500, false)
    expect(p.pick()).toBe('opus')
    p.done('opus', CRATE, LATE, false)
    expect(p.pick()).toBe('opus')
    p.done('opus', CRATE, IN_TIME, false)
    p.done('opus', CRATE, LATE, false)
    expect(p.pick()).toBe('opus')
  })

  it('passes a model over for 2 minutes when two designs in a row miss their crates', () => {
    const { p, wait } = picker()
    p.done('opus', CRATE, LATE, false)
    p.done('opus', CRATE, LATE, false)
    expect(p.pick()).toBe('sonnet')
    wait(119_000)
    expect(p.pick()).toBe('sonnet')
    wait(2000)
    expect(p.pick()).toBe('opus')
    // The count starts again after the pause.
    p.done('opus', CRATE, LATE, false)
    expect(p.pick()).toBe('opus')
  })

  it('counts nothing no crate waits for toward a streak (a look, a thing brought in the break), slow as it may be, but passes a model over for a failed one', () => {
    const { p } = picker()
    p.done('opus', null, LATE, false)
    p.done('opus', null, LATE, false)
    p.done('opus', null, LATE, false)
    expect(p.pick()).toBe('opus')
    // Nor does a look in time end a streak of things that missed their crates.
    p.done('opus', CRATE, LATE, false)
    p.done('opus', null, IN_TIME, false)
    expect(p.pick()).toBe('opus')
    p.done('opus', CRATE, LATE, false)
    expect(p.pick()).toBe('sonnet')
    p.done('sonnet', null, 5000, true)
    expect(p.pick()).toBe('haiku')
  })

  it('judges each design by its own crate: one brought to a defence has the countdown too', () => {
    const { p } = picker()
    const brought = (COUNTDOWN + DESIGN_LIMIT) * 1000
    p.done('opus', brought, LATE, false)
    p.done('opus', brought, LATE, false)
    expect(p.pick()).toBe('opus')
    p.done('opus', brought, brought - 1000, false)
    p.done('opus', brought, brought - 1000, false)
    expect(p.pick()).toBe('sonnet')
  })

  it('passes a model over at once when a design fails, Sonnet then Haiku taking its place', () => {
    const { p } = picker()
    p.done('opus', CRATE, 5000, true)
    expect(p.pick()).toBe('sonnet')
    p.done('sonnet', CRATE, 5000, true)
    expect(p.pick()).toBe('haiku')
  })
})

describe('the designers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('give Opus every design, however many are in flight at once', async () => {
    vi.mocked(once).mockClear()
    let answer = () => {}
    const answered = new Promise<void>((resolve) => (answer = resolve))
    vi.mocked(once).mockImplementation(async () => {
      await answered
      return { data: {}, ms: 20_000 }
    })
    const designers = new CliDesigners({} as never, () => {})
    const designs = [...Array(8)].map((_, i) => (i % 2 ? designers.wear('a tall hat', 100_000) : designers.thing('a gavel', 100_000, CRATE)))
    expect(designers.next()).toBe('opus')
    answer()
    expect((await Promise.all(designs)).map((a) => a.model)).toEqual(Array(8).fill('opus'))
    expect(vi.mocked(once).mock.calls.map((call) => call[1].model)).toEqual(Array(8).fill('opus'))
  })

  it('count a design late by the whole wait for it, a second try included', async () => {
    vi.useFakeTimers({ now: 0 })
    // Each answer is the second try of two, 20 s each: the CLI's own time says 20 s.
    vi.mocked(once).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 40_000)
      return { data: {}, ms: 20_000 }
    })
    const designers = new CliDesigners({} as never, () => {})
    await designers.thing('a gavel', 100_000, CRATE)
    expect(designers.next()).toBe('opus')
    await designers.thing('a gavel', 100_000, CRATE)
    expect(designers.next()).toBe('sonnet')
  })

  it('leave Opus to the round after two slow outfits, or two slow things brought, in the dressing room', async () => {
    vi.useFakeTimers({ now: 0 })
    vi.mocked(once).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 40_000)
      return { data: {}, ms: 40_000 }
    })
    const designers = new CliDesigners({} as never, () => {})
    await designers.wear('a tall hat', 100_000)
    await designers.wear('a long cape', 100_000)
    await designers.thing('a lantern', 100_000, null)
    await designers.thing('a teapot', 100_000, null)
    expect(designers.next()).toBe('opus')
  })
})
