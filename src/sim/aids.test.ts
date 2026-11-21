/**
 * What the first party asked for (2026-11-14), on the sim's side: withdrawing with K, crates left
 * too long going, the committee's crates anyone may open, and a thing's uses cut to what its trial
 * measured a use to take.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CRATE_GONE, CRATE_OWNER_ONLY, FALL_DAMAGE, LIFE_HARM, START_CRED, USES, WITHDRAW, type GameEvent } from '../protocol'
import { Sim, initPhysics } from './sim'
import { hall, pair, press, steps } from './testkit'
import { STARTERS, compileThing, trialThing, usesFor, type ThingDesign } from './things'

beforeAll(async () => {
  await initPhysics()
})

const thing = (id: string, code: string, uses = 30): ThingDesign => ({ ...STARTERS[0]!, id, code, uses })

/** Steps, keeping every event that went out. */
function record(sim: Sim, n: number): GameEvent[] {
  const out: GameEvent[] = []
  for (let i = 0; i < n; i++) {
    sim.step()
    out.push(...sim.snapshot().events)
  }
  return out
}

describe('withdrawing with K', () => {
  it('puts a doctor back at a spawn point after WITHDRAW s held, for FALL_DAMAGE credited to the last blow; a hit starts it again, and letting go stops it', () => {
    const sim = hall()
    const [a, b] = pair(sim, 4)
    sim.teleport(a, [6, 0.05, 6])
    steps(sim, 5)
    const from = [...a.pos]
    a.input = { ...a.input, withdraw: true }
    steps(sim, (WITHDRAW - 1) * 60)
    expect(sim.me('a').withdraw).toBeCloseTo((WITHDRAW - 1) / WITHDRAW, 1)
    // A blow starts it again, and is put down to whoever struck.
    sim.harm(a, 4, { attacker: 'b', thing: null, fists: null, what: 'a test' })
    expect(sim.me('a').withdraw).toBe(0)
    steps(sim, (WITHDRAW - 0.5) * 60)
    expect(Math.hypot(a.pos[0] - from[0], a.pos[2] - from[2])).toBeLessThan(0.5)
    const events = record(sim, 40)
    const hits = events.filter((e) => e.type === 'hit' && e.what === 'withdrawing')
    expect(hits).toEqual([expect.objectContaining({ victim: 'a', amount: FALL_DAMAGE, by: 'b', what: 'withdrawing' })])
    expect(a.cred).toBe(START_CRED - 4 - FALL_DAMAGE)
    expect(sim.arena!.spawns.some((s) => Math.hypot(s.p[0] - a.pos[0], s.p[2] - a.pos[2]) < 0.5)).toBe(true)
    // Let go part way, nothing happens.
    steps(sim, 30)
    b.input = { ...b.input, withdraw: true }
    steps(sim, 60)
    b.input = { ...b.input, withdraw: false }
    steps(sim, WITHDRAW * 60)
    expect(b.cred).toBe(START_CRED)
  })

  it('does nothing before the round is live', () => {
    const sim = hall()
    const [a] = pair(sim, 4)
    sim.live = false
    a.input = { ...a.input, withdraw: true }
    steps(sim, (WITHDRAW + 1) * 60)
    expect(a.cred).toBe(START_CRED)
    expect(sim.me('a').withdraw).toBe(0)
  })
})

describe('crates', () => {
  const kind = () => compileThing(STARTERS[0]!)

  it('left unopened CRATE_GONE s after they were ready are gone, their things with them', () => {
    const sim = hall()
    pair(sim, 4)
    const c = sim.dropCrate('a', 'a lamp')!
    sim.fillCrate(c.id, kind(), { archive: true })
    steps(sim, 60 * 3 + 5)
    expect(c.state).toBe('ready')
    steps(sim, (CRATE_GONE - 1) * 60)
    expect(sim.crates.has(c.id)).toBe(true)
    steps(sim, 70)
    expect(sim.crates.has(c.id)).toBe(false)
    expect(sim.snapshot().crates).toEqual([])
  })

  it('of the committee come in near a spawn point and are anyone’s at once in a live round, never in the countdown', () => {
    const sim = hall()
    const [, b] = pair(sim, 4)
    sim.live = false
    const c = sim.dropCommitteeCrate()!
    expect(c.owner).toBe(null)
    expect(sim.arena!.spawns.some((s) => Math.hypot(s.p[0] - c.p[0], s.p[2] - c.p[2]) < 7.5)).toBe(true)
    sim.fillCrate(c.id, kind(), { archive: true })
    steps(sim, 60 * 3 + 5)
    expect(c.state).toBe('ready')
    expect(sim.mayOpen(c, b)).toBe(false)
    sim.goLive()
    expect(sim.mayOpen(c, b)).toBe(true)
    expect(sim.snapshot().crates[0]).toMatchObject({ owner: null, ownerUntil: expect.closeTo(sim.time, 3) })
    sim.teleport(b, [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]])
    steps(sim, 2)
    press(b, 'pick')
    const opened = record(sim, 2).filter((e) => e.type === 'opened')
    expect(opened).toEqual([expect.objectContaining({ by: 'b', owner: null, archive: true })])
    expect(sim.me('b').hands[0]!.origin).toMatchObject({ by: null })
    expect(CRATE_OWNER_ONLY).toBeGreaterThan(0)
  })
})

describe('uses, as the trial measures a use', () => {
  it('cut a thing that tries to take much each use, from several doctors, so all its uses take at most LIFE_HARM', () => {
    // Each use: 10 at everyone else.
    const all = trialThing(compileThing(thing('all', `let last = -10\nreturn { use() { if (w.time - last < 0.3) return; last = w.time; for (const d of w.others()) w.hurt(d, 10) } }`)))
    expect(all.problems).toEqual([])
    expect(all.perUse).toBeCloseTo(20, 0)
    expect(usesFor(30, all.perUse)).toBe(USES[0])
    // Each use: 2 at the nearest.
    const light = trialThing(compileThing(thing('light', `let last = -10\nreturn { use() { if (w.time - last < 0.3) return; last = w.time; const d = w.others()[0]; w.hurt(d, 2) } }`)))
    expect(light.perUse).toBeCloseTo(2, 0)
    expect(usesFor(20, light.perUse)).toBe(20)
    expect(usesFor(40, light.perUse)).toBe(Math.floor(LIFE_HARM / light.perUse!))
    // Taking nothing measures nothing, and keeps the designer's count.
    const quiet = trialThing(compileThing(thing('quiet', `return { use() { w.text(me.pos(), 'hm', '#ffffff') } }`)))
    expect(quiet.perUse).toBe(null)
    expect(usesFor(12, quiet.perUse)).toBe(12)
  })

  it('count a held stream by the second: what it tries in one doctor’s second at most PER_SECOND_CAP', () => {
    const hose = trialThing(compileThing(thing('hose', `return { hold() { const d = w.others()[0]; w.hurt(d, 1) } }`)))
    expect(hose.perUse).not.toBe(null)
    expect(hose.perUse!).toBeLessThanOrEqual(20 + 1e-6)
  })
})
