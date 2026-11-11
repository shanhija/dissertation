/** What the sim tells a player: E at a crate still only its asker's, how a thing in hand came out of its crate, whose review lies on their next request; and a crate ready in the countdown. */

import { beforeAll, expect, it } from 'vitest'

import { CRATE_OWNER_ONLY, type GameEvent } from '../protocol'
import { initPhysics, type Sim } from './sim'
import { hall, pair, press, steps } from './testkit'
import { STARTERS, compileThing } from './things'

beforeAll(async () => {
  await initPhysics()
})

/** Steps, keeping the events of one type that went out. */
function told<T extends GameEvent['type']>(sim: Sim, n: number, type: T): Extract<GameEvent, { type: T }>[] {
  const out: GameEvent[] = []
  for (let i = 0; i < n; i++) {
    sim.step()
    out.push(...sim.snapshot().events)
  }
  return out.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type)
}

it('E at a crate still only its asker’s says whose it is and for how long; the thing from it keeps who asked, in what words, and the genie', () => {
  const sim = hall()
  const [a, b] = pair(sim, 6)
  const c = sim.dropCrate('a', 'a lamp')!
  sim.fillCrate(c.id, compileThing(STARTERS[0]!), { archive: false, genie: true, curse: null })
  steps(sim, 60 * 3 + 5)
  expect(c.state).toBe('ready')
  sim.teleport(b, [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]])
  steps(sim, 2)
  press(b, 'pick')
  const shut = told(sim, 2, 'notYet')
  expect(shut).toEqual([{ type: 'notYet', who: 'b', owner: 'a', secs: expect.any(Number) }])
  expect(shut[0]!.secs).toBeGreaterThanOrEqual(1)
  expect(shut[0]!.secs).toBeLessThanOrEqual(CRATE_OWNER_ONLY)
  expect(sim.me('b').hands).toEqual([null, null])
  steps(sim, CRATE_OWNER_ONLY * 60)
  press(b, 'pick')
  expect(told(sim, 2, 'notYet')).toEqual([])
  expect(sim.me('b').hands[0]).toEqual({ name: STARTERS[0]!.name, description: STARTERS[0]!.description, budget: STARTERS[0]!.budget, origin: { by: 'a', ask: 'a lamp', genie: true, archive: false } })
  // A thing from no crate came from nowhere in particular.
  sim.newThing(compileThing(STARTERS[1]!), a, a.pos)
  expect(sim.me('a').hands[0]!.origin).toBe(null)
})

it('a review lies on the next request with whose it is', () => {
  const sim = hall()
  const [a] = pair(sim, 6)
  sim.curse(a, 'Every noun becomes the word duck.', 1, 'b')
  expect(sim.me('a').curse).toEqual({ text: 'Every noun becomes the word duck.', by: 'b' })
  expect(sim.takeCurse('a')).toBe('Every noun becomes the word duck.')
  expect(sim.me('a').curse).toBe(null)
})

it('a crate ready before the round is live (in the countdown) is its asker’s alone for its first seconds from when the round goes live', () => {
  const sim = hall()
  sim.live = false
  const [a, b] = pair(sim, 6)
  const c = sim.dropCrate('a', null)!
  sim.fillCrate(c.id, compileThing(STARTERS[0]!), { archive: true })
  steps(sim, 60 * 3 + 5)
  expect(c.state).toBe('ready')
  expect(sim.snapshot().crates[0]!.ownerUntil).toBe(null)
  expect([sim.mayOpen(c, a), sim.mayOpen(c, b)]).toEqual([true, false])
  steps(sim, 120)
  sim.goLive()
  expect(sim.snapshot().crates[0]!.ownerUntil).toBeCloseTo(sim.time + CRATE_OWNER_ONLY, 3)
  steps(sim, CRATE_OWNER_ONLY * 60 - 5)
  expect(sim.mayOpen(c, b)).toBe(false)
  steps(sim, 10)
  expect(sim.mayOpen(c, b)).toBe(true)
})
