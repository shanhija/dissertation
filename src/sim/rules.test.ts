/** The rules of play: bare hands under a budget, one control rule, falls put down to whoever caused them, what the referee says, and whose a crate is. */

import { beforeAll, describe, expect, it } from 'vitest'

import { BUDGET_WINDOW, CRATE_OWNER_ONLY, FALL_DAMAGE, FISTS_BUDGET, HOLD_MAX, SHOVE_DAMAGE, START_CRED, type GameEvent } from '../protocol'
import { thingApi } from './api'
import { buildArena } from './arena'
import { Bot } from './bots'
import { LECTURE_HALL } from './hall'
import { compile } from './sandbox'
import { Sim, initPhysics, type Doctor } from './sim'
import { hall, pair, press, steps } from './testkit'
import { STARTERS, compileThing, type ThingDesign } from './things'

beforeAll(async () => {
  await initPhysics()
})

const thing = (id: string, code: string): ThingDesign => ({ ...STARTERS[0]!, id, code })

/** Steps, keeping every event that went out. */
function record(sim: Sim, n: number): GameEvent[] {
  const out: GameEvent[] = []
  for (let i = 0; i < n; i++) {
    sim.step()
    out.push(...sim.snapshot().events)
  }
  return out
}

const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type)

/** A random number source that is not the same number every time. */
function seeded(seed: number): () => number {
  let s = seed
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

/**
 * A platform 12 m square at floor level, with a lower one 8 m down to its east (+x) and nothing
 * to its west: a fall to the east lands, one to the west goes out of the arena.
 */
function ledges(): Sim {
  const sim = new Sim(() => 0.5)
  sim.apiFor = thingApi
  buildArena(sim, {
    id: 'ledges',
    name: 'Ledges',
    build: compile(
      'arena',
      `a.box([12, 1, 12], { at: [0, -0.5, 0] })
a.box([20, 1, 12], { at: [16, -8.5, 0] })
for (let i = 0; i < 4; i++) a.spawn([i - 2, 0, -4])`,
    ),
  })
  sim.live = true
  return sim
}

/** A doctor standing at a point, facing along yaw, their momentum gone. */
function place(sim: Sim, d: Doctor, at: [number, number, number], yaw: number): void {
  sim.teleport(d, at)
  d.walk = [0, 0, 0]
  d.push = [0, 0, 0]
  d.input = { ...d.input, yaw, move: [0, 0] }
}

describe('bare hands', () => {
  it('shove under a budget like a thing: at most FISTS_BUDGET from one doctor in any BUDGET_WINDOW, still pushing, keyed by who shoves whom', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1.2)
    const c = sim.addDoctor('c', 'C', false)
    place(sim, c, [3, 0.05, 1.2], -Math.PI / 2)
    const events: GameEvent[] = []
    const shove = (by: Doctor, at: Doctor) => {
      place(sim, at, [by.pos[0] + Math.sin(by.yaw) * 1.2, 0.05, by.pos[2] + Math.cos(by.yaw) * 1.2], 0)
      sim.step()
      const before = [...at.pos]
      press(by, 'use')
      events.push(...record(sim, 40))
      return Math.hypot(at.pos[0] - before[0]!, at.pos[2] - before[2]!)
    }
    const start = sim.time
    for (let i = 0; i < 4; i++) shove(a, b)
    expect(b.cred).toBe(START_CRED - FISTS_BUDGET)
    // Spent on b: the fifth takes nothing and says so, and still throws b back.
    const moved = shove(a, b)
    expect(b.cred).toBe(START_CRED - FISTS_BUDGET)
    expect(moved).toBeGreaterThan(1.5)
    const spent = of(events, 'spent')
    expect(spent).toHaveLength(1)
    expect(spent[0]).toMatchObject({ victim: 'b', by: 'a', thing: 'bare hands' })
    expect(spent[0]!.back).toBeGreaterThan(BUDGET_WINDOW - 4)
    expect(spent[0]!.back).toBeLessThanOrEqual(BUDGET_WINDOW)
    expect(of(events, 'hit').every((e) => e.what === 'a shove' && e.by === 'a')).toBe(true)
    // Another's hands have a budget of their own on b, and a's are not spent on c.
    a.yaw = a.input.yaw = Math.PI / 2
    shove(c, b)
    expect(b.cred).toBe(START_CRED - FISTS_BUDGET - SHOVE_DAMAGE)
    shove(a, c)
    expect(c.cred).toBe(START_CRED - SHOVE_DAMAGE)
    // Past the window, a's first shoves on b have lapsed and its hands take from b again.
    steps(sim, Math.ceil((start + BUDGET_WINDOW + 0.5 - sim.time) * 60))
    a.input = { ...a.input, yaw: 0 }
    steps(sim, 1)
    const cred = b.cred
    shove(a, b)
    expect(b.cred).toBe(cred - SHOVE_DAMAGE)
  })
})

describe('the control rule', () => {
  /** The share of 30 s a doctor spends held or lying knocked flat while another uses a thing on them every half second. */
  function heldShare(code: string, hand: 'use' | 'alt'): number {
    const sim = hall()
    const [a, b] = pair(sim, 4)
    sim.newThing(compileThing(thing('control', code)), a, a.pos)
    let held = 0
    const n = 30 * 60
    for (let i = 0; i < n; i++) {
      if (i % 30 === 0) press(a, hand)
      sim.step()
      if (sim.held(b)) held++
    }
    return held / n
  }

  it('lets no thing keep a doctor held, or knocked flat, more than about half the time', () => {
    const holds = heldShare(`return { use() { for (const d of w.others()) w.affect(d, { speed: 0, jump: 0, hands: false }, 10) } }`, 'use')
    const flat = heldShare(`return { alt() { for (const d of w.others()) w.topple(d, [2, 10, 0]) } }`, 'alt')
    expect(holds).toBeGreaterThan(0.4)
    expect(holds).toBeLessThan(0.56)
    expect(flat).toBeGreaterThan(0.3)
    expect(flat).toBeLessThan(0.56)
  })

  it('counts lying flat toward the hold, never stands a flying ragdoll up, and frees them for as long again once up', () => {
    const sim = hall()
    const [a, b] = pair(sim, 4)
    const both = thing('both', `return { use() { for (const d of w.others()) w.affect(d, { speed: 0, jump: 0, hands: false }, 10) }, alt() { for (const d of w.others()) w.topple(d, [0, 22, 0]) } }`)
    sim.newThing(compileThing(both), a, a.pos)
    press(a, 'use')
    steps(sim, Math.round((HOLD_MAX - 0.6) * 60))
    expect(sim.held(b)).toBe(true)
    // Thrown up while held: the hold runs out in mid-air, and they fly on.
    press(a, 'alt')
    steps(sim, 2)
    expect(b.rag).not.toBe(null)
    let shookAt = -1
    for (let i = 0; i < 60 && shookAt < 0; i++) {
      sim.step()
      if (b.freeUntil > sim.time) shookAt = sim.time
    }
    expect(shookAt).toBeGreaterThan(0)
    expect(b.rag).not.toBe(null)
    expect(b.rag!.pelvis()[1]).toBeGreaterThan(3)
    expect(b.freeUntil).toBeCloseTo(shookAt + HOLD_MAX, 3)
    expect(b.flopFree).toBeGreaterThanOrEqual(shookAt + HOLD_MAX - 1e-9)
    expect(b.effects.some((e) => e.speed === 0)).toBe(false)
    // Down and up again: lying on after shaking free does not count, and the free time starts as they get up.
    for (let i = 0; i < 5 * 60 && b.rag; i++) sim.step()
    expect(b.rag).toBe(null)
    expect(sim.time).toBeLessThan(shookAt + HOLD_MAX - 0.5)
    expect(b.heldFor).toBe(0)
    expect(b.freeUntil).toBeCloseTo(sim.time + HOLD_MAX, 3)
    expect(b.flopFree).toBeGreaterThanOrEqual(b.freeUntil)
    // While free, a topple only pushes and a hold does not take.
    press(a, 'alt')
    press(a, 'use')
    steps(sim, 3)
    expect(b.rag).toBe(null)
    expect(sim.held(b)).toBe(false)
  })

  it('calls a doctor lying knocked flat held, to made code that asks as to the rule', () => {
    const sim = hall()
    const [a, b] = pair(sim, 4)
    const asks = thing('asks', `return { use() { for (const d of w.others()) w.topple(d, [0, 3, 0]) }, alt() { for (const d of w.others()) if (w.held(d)) w.hurt(d, 5) } }`)
    sim.newThing(compileThing(asks), a, a.pos)
    press(a, 'alt')
    steps(sim, 2)
    expect(sim.held(b)).toBe(false)
    expect(b.cred).toBe(START_CRED)
    press(a, 'use')
    steps(sim, 2)
    expect(b.rag).not.toBe(null)
    expect(sim.held(b)).toBe(true)
    press(a, 'alt')
    steps(sim, 2)
    expect(b.cred).toBe(START_CRED - 5)
    // Up again, they are not.
    for (let i = 0; i < 5 * 60 && b.rag; i++) sim.step()
    expect(b.rag).toBe(null)
    expect(sim.held(b)).toBe(false)
  })

  it('rests a doctor teleported up out of a knockdown as one who got up: a topple and a teleport together floor them at most every 1.5 s', () => {
    const sim = hall()
    const [a, b] = pair(sim, 4)
    const trip = thing('trip', `return { use() { for (const d of w.others()) { w.topple(d, [0, 3, 0]); w.teleport(d, d.pos) } } }`)
    sim.newThing(compileThing(trip), a, a.pos)
    let floored = 0
    let since = b.ragSince
    for (let i = 0; i < 10 * 60; i++) {
      if (i % 15 === 0) press(a, 'use')
      sim.step()
      if (b.ragSince !== since) {
        floored++
        since = b.ragSince
      }
    }
    expect(floored).toBeGreaterThan(3)
    expect(floored).toBeLessThanOrEqual(7)
  })

  it('lets a blast reach a doctor shaken free, pushing them without knocking them flat', () => {
    const sim = hall()
    const [a, b] = pair(sim, 4)
    const bomb = thing('bomb', `return { use() { for (const d of w.others()) w.affect(d, { speed: 0, jump: 0 }, 10) }, alt() { for (const r of w.blast([0, 0.5, 0], 8, 30)) w.hurt(r.doctor, 5) } }`)
    sim.newThing(compileThing(bomb), a, a.pos)
    press(a, 'use')
    for (let i = 0; i < (HOLD_MAX + 1) * 60 && b.freeUntil <= sim.time; i++) sim.step()
    expect(b.freeUntil).toBeGreaterThan(sim.time + HOLD_MAX - 0.1)
    const at = [...b.pos]
    press(a, 'alt')
    steps(sim, 30)
    expect(b.pos[2] - at[2]!).toBeGreaterThan(2)
    expect(b.rag).toBe(null)
    expect(b.cred).toBe(START_CRED - 5)
  })
})

describe('falls', () => {
  const pusher = (v: string) => thing('pusher', `return { use() { for (const d of w.others()) w.push(d, ${v}) }, alt() { for (const d of w.others()) w.hurt(d, 10) } }`)

  it('a hard landing after a push is the pusher’s, charged to the thing that pushed', () => {
    const sim = ledges()
    const a = sim.addDoctor('a', 'A', false)
    const b = sim.addDoctor('b', 'B', false)
    place(sim, a, [-3, 0.05, 0], Math.PI / 2)
    place(sim, b, [5, 0.05, 0], -Math.PI / 2)
    steps(sim, 20)
    const t = sim.newThing(compileThing(pusher('[8, 2, 0]')), a, a.pos)
    press(a, 'use')
    const events = record(sim, 120)
    const fall = of(events, 'hit').find((e) => e.victim === 'b')!
    expect(fall).toMatchObject({ by: 'a', what: 'a fall' })
    expect(fall.amount).toBeGreaterThan(5)
    expect(sim.dealt(t, 'b')).toBe(fall.amount)
  })

  it('a landing after the thing has spent its budget takes nothing, and says it is spent', () => {
    const sim = ledges()
    const a = sim.addDoctor('a', 'A', false)
    const b = sim.addDoctor('b', 'B', false)
    place(sim, a, [-3, 0.05, 0], Math.PI / 2)
    place(sim, b, [5, 0.05, 0], -Math.PI / 2)
    steps(sim, 20)
    const t = sim.newThing(compileThing(pusher('[8, 2, 0]')), a, a.pos)
    press(a, 'alt')
    steps(sim, 70)
    sim.snapshot()
    expect(b.cred).toBe(START_CRED - 10)
    press(a, 'use')
    const events = record(sim, 120)
    expect(b.pos[1]).toBeLessThan(-7)
    expect(b.cred).toBe(START_CRED - 10)
    expect(of(events, 'hit')).toHaveLength(0)
    expect(of(events, 'spent')).toMatchObject([{ victim: 'b', by: 'a', thing: t.kind.name }])
  })

  it('a fall out of the arena costs FALL_DAMAGE, credited to whoever knocked them off within 5 s, outside any budget', () => {
    const sim = ledges()
    const a = sim.addDoctor('a', 'A', false)
    const b = sim.addDoctor('b', 'B', false)
    place(sim, a, [-2, 0.05, 0], -Math.PI / 2)
    place(sim, b, [-5, 0.05, 0], Math.PI / 2)
    steps(sim, 20)
    const t = sim.newThing(compileThing(pusher('[-9, 2, 0]')), a, a.pos)
    press(a, 'alt')
    steps(sim, 70)
    press(a, 'use')
    const events = record(sim, 150)
    expect(of(events, 'hit').filter((e) => e.victim === 'b').at(-1)).toMatchObject({ by: 'a', what: 'a fall from the arena', amount: FALL_DAMAGE })
    expect(b.cred).toBe(START_CRED - 10 - FALL_DAMAGE)
    expect(sim.dealt(t, 'b')).toBe(10)
    expect(b.lastBlow).toBe(null)
  })

  it('a fall out costs its FALL_DAMAGE, credited, though its doer took all a second allows just before', () => {
    const sim = ledges()
    const a = sim.addDoctor('a', 'A', false)
    const b = sim.addDoctor('b', 'B', false)
    place(sim, a, [-2, 0.05, 0], -Math.PI / 2)
    place(sim, b, [-5, 0.05, 0], Math.PI / 2)
    steps(sim, 20)
    sim.newThing(compileThing({ ...thing('twice', `return { use() { for (const d of w.others()) { w.hurt(d, 10, { push: 0 }); w.hurt(d, 10, { push: 0 }) } } }`), budget: 20 }), a, a.pos)
    press(a, 'use')
    steps(sim, 2)
    sim.snapshot()
    expect(b.cred).toBe(START_CRED - 2 * 10)
    // Out of the arena within the same second.
    sim.teleport(b, [-8, sim.arena!.floor - 1, 0])
    const events = record(sim, 3)
    expect(of(events, 'hit')).toEqual([expect.objectContaining({ victim: 'b', by: 'a', what: 'a fall from the arena', amount: FALL_DAMAGE })])
    expect(b.cred).toBe(START_CRED - 2 * 10 - FALL_DAMAGE)
  })

  it('a shove off the edge is the shover’s, and a fall long after any blow is nobody’s', () => {
    const sim = ledges()
    const a = sim.addDoctor('a', 'A', false)
    const b = sim.addDoctor('b', 'B', false)
    place(sim, a, [-4, 0.05, 0], -Math.PI / 2)
    place(sim, b, [-5.1, 0.05, 0], Math.PI / 2)
    steps(sim, 5)
    press(a, 'use')
    const events = record(sim, 150)
    const out = of(events, 'hit').filter((e) => e.victim === 'b')
    expect(out.map((e) => [e.by, e.what, e.amount])).toEqual([
      ['a', 'a shove', SHOVE_DAMAGE],
      ['a', 'a fall from the arena', FALL_DAMAGE],
    ])
    // Walking off alone, 6 s after a's last blow: the arena's.
    place(sim, b, [-4, 0.05, 0], -Math.PI / 2)
    press(a, 'use')
    steps(sim, 6 * 60)
    b.input = { ...b.input, move: [0, 1] }
    const later = record(sim, 200)
    expect(of(later, 'hit').filter((e) => e.victim === 'b').at(-1)).toMatchObject({ by: null, what: 'a fall from the arena' })
  })
})

describe('the referee', () => {
  it('says what hit, and that a thing is spent once per thing and doctor every 2 s; a cap says nothing', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    const pen = sim.newThing(compileThing(STARTERS[0]!), a, a.pos)
    const src = { attacker: 'a', thing: pen, fists: null, what: pen.kind.name }
    sim.harm(b, 10, src)
    // The per-second cap cuts the next to nothing: no word.
    sim.harm(b, 10, { attacker: 'a', thing: null, fists: null, what: 'x' })
    sim.harm(b, 5, { attacker: 'a', thing: null, fists: null, what: 'x' })
    // The pen is spent on b too, but the cap cuts this first: still no word.
    sim.harm(b, 5, src)
    let events = sim.snapshot().events
    expect(of(events, 'hit').map((e) => [e.by, e.what, e.amount])).toEqual([
      ['a', pen.kind.name, 10],
      ['a', 'x', 10],
    ])
    expect(of(events, 'spent')).toHaveLength(0)
    steps(sim, 70)
    sim.harm(b, 5, src)
    sim.harm(b, 5, src)
    steps(sim, 60)
    sim.harm(b, 5, src)
    events = record(sim, 1)
    steps(sim, 70)
    sim.harm(b, 5, src)
    events.push(...sim.snapshot().events)
    const spent = of(events, 'spent')
    expect(spent).toHaveLength(2)
    expect(spent[0]).toMatchObject({ victim: 'b', by: 'a', thing: pen.kind.name })
    // Back when the first 10 lapses, 20 s after it was taken.
    expect(spent[0]!.back).toBeCloseTo(BUDGET_WINDOW - 70 / 60, 0)
    expect(spent[1]!.back).toBeCloseTo(BUDGET_WINDOW - 200 / 60, 0)
    expect(b.cred).toBe(START_CRED - 20)
  })

  it('a curse says who laid it', () => {
    const sim = hall()
    const [a] = pair(sim)
    const quack = thing('quack', `return { use() { for (const d of w.others()) w.curse(d, 'Every noun becomes duck.') } }`)
    sim.newThing(compileThing(quack), a, a.pos)
    press(a, 'use')
    const events = record(sim, 2)
    expect(of(events, 'curse')).toEqual([{ type: 'curse', victim: 'b', text: 'Every noun becomes duck.', by: 'a' }])
    sim.curse(a, 'Rhyme.', 1, null)
    expect(of(sim.snapshot().events, 'curse')[0]!.by).toBe(null)
  })
})

describe('crates', () => {
  const kind = () => compileThing(STARTERS[0]!)

  it('open only for the asker for their first CRATE_OWNER_ONLY seconds ready, then for anyone; another passes over it to what else is near', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1)
    const c = sim.dropCrate('a', 'a sword that sings')!
    steps(sim, 60 * 3 + 5)
    expect(c.state).toBe('waiting')
    place(sim, a, [c.p[0] + 6, 0.05, c.p[2]], 0)
    place(sim, b, [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]], -Math.PI / 2)
    const loose = sim.newThing(kind(), null, [c.p[0] + 1.2, c.p[1], c.p[2] + 0.8])
    steps(sim, 30)
    sim.fillCrate(c.id, kind(), { archive: false, genie: true, curse: 'Speak only in rhyme.' })
    expect(c.state).toBe('ready')
    expect(sim.snapshot().crates[0]).toMatchObject({ ask: 'a sword that sings', archive: false, ownerUntil: expect.closeTo(c.readyAt! + CRATE_OWNER_ONLY, 3) })
    // Not yet b's: E takes the loose thing instead.
    press(b, 'pick')
    steps(sim, 2)
    expect(sim.crates.size).toBe(1)
    expect(b.hands[0]).toBe(loose.id)
    steps(sim, (CRATE_OWNER_ONLY - 0.2) * 60)
    press(b, 'pick')
    steps(sim, 2)
    expect(sim.crates.size).toBe(1)
    steps(sim, 20)
    press(b, 'pick')
    const events = record(sim, 2)
    expect(sim.crates.size).toBe(0)
    expect(of(events, 'opened')).toEqual([
      { type: 'opened', crate: c.id, by: 'b', owner: 'a', thing: STARTERS[0]!.name, ask: 'a sword that sings', genie: true, archive: false, curse: 'Speak only in rhyme.' },
    ])
  })

  it('open for their asker at once, ready on arrival, and say when they came from the archive', () => {
    const sim = hall()
    const [a] = pair(sim, 6)
    const c = sim.dropCrate('a', null)!
    sim.fillCrate(c.id, kind(), { archive: true })
    expect(sim.snapshot().crates[0]).toMatchObject({ ask: null, archive: true, ownerUntil: null, state: 'arriving' })
    steps(sim, 60 * 3 + 5)
    expect(c.state).toBe('ready')
    expect(c.readyAt).toBeGreaterThan(2.9)
    place(sim, a, [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]], -Math.PI / 2)
    steps(sim, 2)
    press(a, 'pick')
    const events = record(sim, 2)
    expect(of(events, 'opened')).toMatchObject([{ by: 'a', owner: 'a', ask: null, genie: false, archive: true, curse: null }])
  })

  it('keep the asker’s words cut to 60 characters', () => {
    const sim = hall()
    pair(sim, 6)
    const long = 'a brass telescope that sees through walls and also tells the time in Latin, loudly'
    const c = sim.dropCrate('a', `  ${long}  `)!
    expect(c.ask).toHaveLength(60)
    expect(c.ask).toBe(`${long.slice(0, 59)}…`)
    expect(sim.snapshot().crates[0]!.ask).toBe(c.ask)
    // Characters, not halves of one: an emoji at the cut stays whole.
    sim.crates.clear()
    expect(sim.dropCrate('a', `${'a'.repeat(58)}🦆🦆🦆`)!.ask).toBe(`${'a'.repeat(58)}🦆…`)
  })

  it('are left to their asker by bots for the first seconds, then taken', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1)
    const bot = new Bot('b', () => 0.5)
    const c = sim.dropCrate('a', null)!
    steps(sim, 60 * 3 + 5)
    place(sim, a, [c.p[0] + 12, 0.05, c.p[2]], 0)
    place(sim, b, [c.p[0] + 1, c.p[1] - 0.45, c.p[2]], -Math.PI / 2)
    sim.fillCrate(c.id, kind(), { archive: true })
    let openedAt = -1
    for (let i = 0; i < 6 * 60 && openedAt < 0; i++) {
      sim.setInput('b', bot.think(sim))
      sim.step()
      if (sim.crates.size === 0) openedAt = sim.time
    }
    expect(openedAt).toBeGreaterThanOrEqual(c.readyAt! + CRATE_OWNER_ONLY)
    expect(openedAt).toBeLessThan(c.readyAt! + CRATE_OWNER_ONLY + 1)
    expect(b.hands[0]).not.toBe(null)
  })

  it('come in where the asker looks', () => {
    let inView = 0
    let all = 0
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim(seeded(seed * 7919))
      sim.apiFor = thingApi
      buildArena(sim, LECTURE_HALL)
      const d = sim.addDoctor('a', 'A', false)
      for (const s of sim.arena!.spawns) {
        for (const turn of [0, 2]) {
          place(sim, d, [s.p[0], s.p[1] + 0.05, s.p[2]], s.yaw + turn)
          d.yaw = d.input.yaw
          steps(sim, 2)
          for (let k = 0; k < 4; k++) {
            const c = sim.dropCrate('a', null)!
            const off = Math.atan2(c.p[0] - d.pos[0], c.p[2] - d.pos[2]) - d.yaw
            if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) <= (50 * Math.PI) / 180 + 1e-6) inView++
            all++
            sim.world.removeRigidBody(c.body)
            sim.crates.clear()
          }
        }
      }
      sim.free()
    }
    expect(all).toBeGreaterThan(100)
    expect(inView / all).toBeGreaterThan(0.95)
  })
})
