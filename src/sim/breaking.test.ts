import { beforeAll, describe, expect, it } from 'vitest'

import type { GameEvent } from '../protocol'
import { thingApi } from './api'
import { buildArena, checkArena } from './arena'
import { RUBBLE } from './breaking'
import { compile } from './sandbox'
import { Sim, initPhysics } from './sim'
import { steps } from './testkit'
import { STARTERS, compileThing, type ThingDesign } from './things'

beforeAll(async () => {
  await initPhysics()
})

const thing = (id: string, code: string): ThingDesign => ({ ...STARTERS[0]!, id, code })

/** A sim with an arena of the code given (a floor 40 m across comes first), and a doctor holding a thing of the code given at the first spawn point. */
function arena(code: string, thingCode: string) {
  const sim = new Sim(() => 0.5)
  sim.apiFor = thingApi
  buildArena(sim, { id: 'breakables', name: 'Breakables', build: compile('arena', `a.box([40, 1, 40], { at: [0, -0.5, 0] })\n${code}`) })
  sim.live = true
  const d = sim.addDoctor('a', 'A', false)
  steps(sim, 5)
  const t = sim.newThing(compileThing(thing('tool', thingCode)), d, d.pos)
  return { sim, d, t }
}

/** Steps, keeping every event that went out. */
function record(sim: Sim, n: number): GameEvent[] {
  const out: GameEvent[] = []
  for (let i = 0; i < n; i++) {
    sim.step()
    out.push(...sim.snapshot().events)
  }
  return out
}

const rubble = (sim: Sim) => [...sim.bodies.values()].filter((b) => b.owner === RUBBLE)

describe('breakable pieces', () => {
  it('take their strength from what they are made of and how big they are, unless given', () => {
    const { sim } = arena(
      `a.breakable(() => a.box([2, 2, 0.05], { at: [0, 1, 5], material: 'glass' }))
a.breakable(() => a.box([1, 1, 1], { at: [3, 0.5, 5], material: 'planks' }))
a.breakable(() => a.box([4, 3, 0.3], { at: [8, 1.5, 5], material: 'stone' }))
a.breakable(() => a.box([1, 1, 1], { at: [-3, 0.5, 5], material: 'metal' }), { strength: 50 })
a.breakable(() => {})
a.spawn([0, 0, -6])`,
      `return {}`,
    )
    const strength = [...sim.arena!.pieces.values()].map((p) => Math.round(p.strength))
    // Glass about 50, a crate 800, a stone wall about 7000; the metal one as given; the empty one is nothing.
    expect(strength).toEqual([51, 800, 7047, 50])
    expect(sim.arena!.view.solids.slice(1).map((s) => s.piece)).toEqual(['k0', 'k1', 'k2', 'k3'])
    expect(sim.arena!.view.solids[0]!.piece).toBe(null)
  })

  it('a hard blow breaks a pane: gone from the world and the drawing, in rubble that is gone in a few seconds, and arena code hears of it', () => {
    const { sim, d } = arena(
      `const pane = a.breakable(() => {
  a.box([2, 2, 0.05], { at: [0, 1, 5], material: 'glass', color: '#cfe8f0' })
  a.decor((m) => m.box(0.3, 0.3, 0.3, {}), { at: [0, 2.15, 5] })
})
let told = false
a.every(() => { if (!told && pane.broken()) { told = true; w.text([0, 0, 0], 'broke ' + pane.id, 'red') } })
a.spawn([0, 0, 0])`,
      `return { use() { w.spawn({ shape: 'ball', size: 0.3, mass: 5, at: [0, 1, 3], vel: [0, 0, 20], gravity: 0 }) } }`,
    )
    expect(sim.clear([0, 1, 4], [0, 1, 6])).toBe(false)
    sim.callThing(sim.inHand(d, 0)!, 'use')
    const events = record(sim, 20)
    expect(events.find((e) => e.type === 'break')).toMatchObject({ piece: 'k0', material: 'glass', color: '#cfe8f0' })
    expect(events.find((e) => e.type === 'text')).toMatchObject({ text: 'broke k0' })
    expect(sim.arena!.view.broken).toEqual(['k0'])
    expect(sim.clear([0, 1, 4], [0, 1, 6])).toBe(true)
    // The pane in lumps of glass, the box on it flying off whole.
    const lumps = rubble(sim)
    expect(lumps.filter((b) => b.prim?.material === 'glass').length).toBeGreaterThan(3)
    expect(lumps.filter((b) => b.model !== null).map((b) => b.model)).toEqual(['arena:breakables:decor0'])
    steps(sim, 9 * 60)
    expect(rubble(sim)).toHaveLength(0)
  })

  it('a light blow leaves no mark on a stone wall; heavy ones add up until it breaks', () => {
    const { sim, d } = arena(
      `a.breakable(() => a.box([4, 3, 0.3], { at: [0, 1.5, 5], material: 'stone' }))
a.spawn([0, 0, 0])`,
      `let n = 0
return { use() { w.spawn({ shape: 'ball', size: 0.4, mass: n++ === 0 ? 0.5 : 20, at: [0, 1.5, 3], vel: [0, 0, 20], gravity: 0, life: 0.3 }) } }`,
    )
    const wall = sim.arena!.pieces.get('k0')!
    const t = sim.inHand(d, 0)!
    sim.callThing(t, 'use')
    steps(sim, 20)
    expect(wall.damage).toBe(0)
    sim.callThing(t, 'use')
    const marked = record(sim, 20)
    expect(wall.damage).toBeGreaterThan(3000)
    expect(wall.broken).toBe(false)
    expect(marked.some((e) => e.type === 'sound' && e.sound === 'crunch')).toBe(true)
    sim.callThing(t, 'use')
    steps(sim, 20)
    expect(wall.broken).toBe(true)
  })

  it('a blast breaks what it reaches, not what the arena shelters nor what is out of its reach', () => {
    const { sim, d } = arena(
      `a.breakable(() => a.box([1, 1, 1], { at: [3, 0.5, 0], material: 'planks' }))
a.box([0.5, 3, 4], { at: [-2.5, 1.5, 0] })
a.breakable(() => a.box([1, 1, 1], { at: [-4, 0.5, 0], material: 'planks' }))
a.breakable(() => a.box([1, 1, 1], { at: [0, 0.5, 9], material: 'planks' }))
a.spawn([0, 0, -8])`,
      `return { use() { w.blast([0, 0.5, 0], 6, 20) } }`,
    )
    sim.callThing(sim.inHand(d, 0)!, 'use')
    steps(sim, 2)
    expect([...sim.arena!.pieces.values()].map((p) => p.broken)).toEqual([true, false, false])
  })

  it('a doctor walking into a crate does nothing to it; one knocked flat into it breaks it', () => {
    const { sim, d } = arena(
      `a.breakable(() => a.box([1, 1, 1], { at: [0, 0.5, 3], material: 'planks' }))
a.spawn([0, 0, 0])`,
      `return {}`,
    )
    const crate = sim.arena!.pieces.get('k0')!
    d.input = { ...d.input, yaw: 0, move: [0, 1] }
    steps(sim, 120)
    expect(d.pos[2]).toBeGreaterThan(1.8)
    expect(crate.damage).toBe(0)
    d.input = { ...d.input, move: [0, 0] }
    sim.teleport(d, [0, 0.05, -1])
    steps(sim, 5)
    sim.topple(d, [0, 3, 14])
    steps(sim, 30)
    expect(crate.broken).toBe(true)
  })

  it('a breakable piece standing on one that breaks falls whole, one lump a solid, with no crash of its own', () => {
    const { sim, d } = arena(
      `a.breakable(() => a.box([1, 1, 1], { at: [0, 0.5, 4], material: 'planks' }))
a.breakable(() => a.cylinder(0.3, 0.6, { at: [0, 1.3, 4], material: 'glass' }))
a.breakable(() => a.box([1, 1, 1], { at: [3, 1.5, 4], material: 'planks' }))
a.spawn([0, 0, 0])`,
      `return { use() { w.spawn({ shape: 'ball', size: 0.3, mass: 20, at: [0, 0.4, 2.5], vel: [0, 0, 20], gravity: 0, life: 0.3 }) } }`,
    )
    sim.callThing(sim.inHand(d, 0)!, 'use')
    const breaks = record(sim, 10).filter((e) => e.type === 'break')
    expect(breaks.map((e) => [e.piece, e.fell])).toEqual([
      ['k0', false],
      ['k1', true],
    ])
    const glass = rubble(sim).filter((b) => b.prim?.material === 'glass')
    expect(glass.map((b) => [b.shape, b.prim!.shape, b.size])).toEqual([['cylinder', 'cylinder', [0.6, 0.6, 0.6]]])
    // It drops where it stood.
    steps(sim, 30)
    expect(glass[0]!.rb.translation().y).toBeLessThan(1)
    expect(Math.abs(glass[0]!.rb.translation().z - 4)).toBeLessThan(0.6)
  })

  it('the arena check refuses a spawn point on a breakable floor, and lamps, portraits and movers are built outside a breakable piece', () => {
    const problems = checkArena({
      id: 'brittle',
      name: 'Brittle',
      build: compile('arena', `a.breakable(() => a.box([40, 1, 40], { at: [0, -0.5, 0], material: 'glass' }))\nfor (let i = 0; i < 8; i++) a.spawn([i * 3 - 12, 0, 0])`),
    })
    expect(problems.filter((p) => p.includes('breakable'))).toHaveLength(8)
    for (const inside of ['a.light({ at: [0, 2, 0] })', 'a.portrait({ at: [0, 2, 0] })', 'a.mover(() => {}, () => ({ at: [0, 0, 0] }))', 'a.breakable(() => a.box([1, 1, 1], {}))']) {
      const sim = new Sim(() => 0.5)
      expect(() => buildArena(sim, { id: 'x', name: 'X', build: compile('arena', `a.box([40, 1, 40], { at: [0, -0.5, 0] })\na.breakable(() => { ${inside} })\na.spawn([0, 0, 0])`) }), inside).toThrow(/inside a\.breakable/)
      sim.free()
    }
  })
})
