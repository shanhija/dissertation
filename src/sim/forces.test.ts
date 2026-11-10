import { beforeAll, describe, expect, it } from 'vitest'

import { HOLD_MAX, HOLD_REST, START_CRED, type GameEvent } from '../protocol'
import { initPhysics, len, sub, type Sim } from './sim'
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

describe('sights', () => {
  it('a model shown goes out once with its animation, steered changes merged into one per step, and at most 60 a thing', () => {
    const sim = hall()
    const [a] = pair(sim)
    const shower = thing(
      'shower',
      `const ring = w.model('ring', (m) => m.torus(1, 0.1, { glow: true }))
let s = null
let n = 0
return {
  use() { s = w.show(ring, { follow: me, at: [0, 0, 1], face: [1, 0, 0], scale: 0.5, grow: [4, 4, 1], vel: [0, 0, 2], spin: [0, 0, 3], secs: 2, fade: 0.5, light: 'gold' }) },
  alt() {
    if (n++ === 0) { s.set({ at: [0, 0, 3] }); s.set({ opacity: 0.4 }); s.pose('x', [1, 0, 0]) }
    else for (let i = 0; i < 70; i++) w.show(ring, { at: [0, 1, 0] })
  },
  tick() { if (w.show('nothing') !== null) w.text([0, 0, 0], 'shown a model never made') },
}`,
    )
    const t = sim.newThing(compileThing(shower), a, a.pos)
    press(a, 'use')
    const first = record(sim, 2).filter((e) => e.type === 'show')
    expect(first).toHaveLength(1)
    const show = first[0] as Extract<GameEvent, { type: 'show' }>
    expect(show).toMatchObject({ model: 'thing:shower:0', at: [0, 0, 1], scale: [0.5, 0.5, 0.5], grow: [4, 4, 1], vel: [0, 0, 2], spin: [0, 0, 3], secs: 2, fade: 0.5, light: '#e2b33c', follow: { kind: 'thing', id: t.id } })
    // face [1, 0, 0]: its +z turned to +x, a quarter turn about y.
    const [x, y, z, w] = show.q
    expect([x, z]).toEqual([0, 0])
    expect(Math.abs(y)).toBeCloseTo(Math.SQRT1_2, 2)
    expect(w).toBeCloseTo(Math.SQRT1_2, 2)
    press(a, 'alt')
    const reshows = record(sim, 1).filter((e) => e.type === 'reshow' && e.id === show.id)
    expect(reshows).toEqual([{ type: 'reshow', id: show.id, at: [0, 0, 3], opacity: 0.4, poses: { x: [1, 0, 0] } }])
    // 71 shown, 60 kept: the first eleven went, the steered one among them.
    press(a, 'alt')
    const events = record(sim, 1)
    expect(events.filter((e) => e.type === 'show')).toHaveLength(70)
    expect(events.filter((e) => e.type === 'reshow' && e.gone)).toHaveLength(11)
    expect([...sim.sights.values()].filter((s) => s.owner === t.id)).toHaveLength(60)
    expect(events.some((e) => e.type === 'text')).toBe(false)
    // Each is let go when its time is up.
    steps(sim, 70)
    expect(sim.sights.size).toBe(0)
  })
})

describe('blasts', () => {
  it('throw doctors near the middle flat and those further off less, spare the holder, and are stopped by the arena', () => {
    const sim = hall()
    const [a, b] = pair(sim, 9)
    const c = sim.addDoctor('c', 'C', false)
    const d = sim.addDoctor('d', 'D', false)
    // c in the open, d behind the step at the stage's foot, both about four metres from the blast.
    sim.teleport(b, [0, 0.05, 10.2])
    sim.teleport(c, [3.6, 0.05, 10.5])
    sim.teleport(d, [0, 1.05, 14])
    sim.teleport(a, [0, 0.05, 9.5])
    steps(sim, 20)
    const bomb = thing('bomb', `return { use() { const hit = w.blast([0, 0.1, 10.5], 6, 24); w.text([0, 0, 0], hit.map((h) => h.doctor.id + ':' + h.strength.toFixed(1)).join(' ')) } }`)
    sim.newThing(compileThing(bomb), a, a.pos)
    const before = { c: [...c.pos], d: [...d.pos], a: [...a.pos] }
    press(a, 'use')
    const text = record(sim, 1).find((e) => e.type === 'text') as Extract<GameEvent, { type: 'text' }>
    expect(text.text).toMatch(/^b:0\.9 c:0\.4$/)
    steps(sim, 20)
    // b, at the middle, is knocked flat; c is pushed away (+x); d and a do not move.
    expect(b.rag).not.toBe(null)
    expect(c.rag).toBe(null)
    expect(c.pos[0] - before.c[0]!).toBeGreaterThan(0.5)
    expect(len(sub(d.pos, before.d as [number, number, number]))).toBeLessThan(0.05)
    expect(len(sub(a.pos, before.a as [number, number, number]))).toBeLessThan(0.05)
    expect(b.cred).toBe(START_CRED)
  })

  it('light bodies fly further than heavy ones', () => {
    const sim = hall()
    const [a] = pair(sim)
    const bomb = thing(
      'bomb',
      `let light = null, heavy = null
return {
  use() { light = w.spawn({ shape: 'ball', size: 0.3, mass: 2, at: [6, 0.5, 0] }); heavy = w.spawn({ shape: 'ball', size: 0.3, mass: 400, at: [-6, 0.5, 0] }) },
  alt() { w.blast([0, 0.5, 0], 8, 10) },
  tick() { if (light && light.vel()[0] > 1) w.text([0, 0, 0], 'light ' + Math.round(light.vel()[0]) + ' heavy ' + Math.round(-heavy.vel()[0])) },
}`,
    )
    sim.newThing(compileThing(bomb), a, [0, 0, -3])
    press(a, 'use')
    steps(sim, 30)
    press(a, 'alt')
    const text = record(sim, 3).find((e) => e.type === 'text') as Extract<GameEvent, { type: 'text' }>
    const [, lightV, , heavyV] = text.text.split(' ').map(Number)
    expect(lightV).toBeGreaterThan(heavyV! * 4)
    expect(heavyV).toBeGreaterThan(0)
  })
})

describe('fields', () => {
  it('pull a doctor in, swirl them round, count as a hold and let them go after HOLD_MAX', () => {
    const sim = hall()
    const [a, b] = pair(sim, 6)
    const well = thing('well', `return { use() { w.field({ at: [0, 1, 9], radius: 8, pull: 60, swirl: 20, secs: 20 }) } }`)
    sim.newThing(compileThing(well), a, a.pos)
    sim.teleport(b, [0, 0.05, 5])
    press(a, 'use')
    steps(sim, 30)
    // Drawn toward z 9, and sideways by the swirl; the holder, inside it too, is spared.
    expect(b.pos[2]).toBeGreaterThan(6)
    expect(Math.abs(b.pos[0])).toBeGreaterThan(0.1)
    expect(Math.hypot(a.pos[0], a.pos[2])).toBeLessThan(0.05)
    expect(sim.held(b)).toBe(true)
    // Held too long, they shake it off and the field lets them be for a while.
    steps(sim, HOLD_MAX * 60)
    expect(sim.held(b)).toBe(false)
    const at = [...b.pos]
    b.input = { ...b.input, yaw: Math.PI, move: [0, 1] }
    steps(sim, Math.floor(HOLD_REST * 60) - 10)
    expect(b.pos[2]).toBeLessThan(at[2]! - 3)
  })

  it('lift a loose body and blow it along', () => {
    const sim = hall()
    const [a] = pair(sim)
    const fan = thing(
      'fan',
      `let ball = null
return { use() { ball = w.spawn({ shape: 'ball', size: 0.4, at: [5, 0.3, 0], life: 10 }); w.field({ at: [5, 1, 0], radius: 4, lift: 30, wind: [6, 0, 0], secs: 2 }) },
  tick() { if (ball && w.time > 1.4 && w.time < 1.45) w.text(ball.pos(), 'ball') } }`,
    )
    sim.newThing(compileThing(fan), a, a.pos)
    press(a, 'use')
    steps(sim, 50)
    const ball = [...sim.bodies.values()][0]!
    const p = ball.rb.translation()
    expect(p.y).toBeGreaterThan(1.5)
    expect(p.x).toBeGreaterThan(5.5)
  })
})

describe('ties', () => {
  it('a rope keeps a doctor within its length, reels them in, and slips off when held too long', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    const lasso = thing(
      'lasso',
      `let rope = null
return { use() { const o = w.others()[0]; rope = w.tie(o, [0, 1.15, 3], { length: 2 }) }, alt() { rope.setLength(0.3) } }`,
    )
    sim.newThing(compileThing(lasso), a, a.pos)
    press(a, 'use')
    steps(sim, 2)
    expect(sim.snapshot().ties).toEqual([{ id: expect.any(String), a: { kind: 'doctor', id: 'b' }, b: { kind: 'point', p: [0, 1.15, 3] }, length: 2, spring: false, color: '#c9b48a', width: 0.035 }])
    // b walks away (+z) and is stopped at the rope's end.
    b.input = { ...b.input, yaw: 0, move: [0, 1] }
    steps(sim, 90)
    expect(b.pos[2]).toBeGreaterThan(4.3)
    expect(b.pos[2]).toBeLessThan(5.4)
    b.input = { ...b.input, move: [0, 0] }
    press(a, 'alt')
    steps(sim, 60)
    expect(Math.hypot(b.pos[0], b.pos[2] - 3)).toBeLessThan(0.9)
    // Straining at it, they slip it within HOLD_MAX, and the rope is gone.
    b.input = { ...b.input, move: [0, 1] }
    steps(sim, HOLD_MAX * 60 + 20)
    expect(sim.ties.length).toBe(0)
    steps(sim, 40)
    expect(b.pos[2]).toBeGreaterThan(6)
  })

  it('a spring hangs a body below a point and it settles near its length', () => {
    const sim = hall()
    const [a] = pair(sim)
    const yo = thing(
      'yo',
      `return { use() { const b = w.spawn({ shape: 'ball', size: 0.3, mass: 1, at: [4, 5, 0], life: 20 }); w.tie([4, 5, 0], b, { length: 1.5, spring: 0.6, secs: 20 }) } }`,
    )
    sim.newThing(compileThing(yo), a, a.pos)
    press(a, 'use')
    steps(sim, 300)
    const p = [...sim.bodies.values()][0]!.rb.translation()
    // Hanging a little more than its length below (gravity stretches it), not on the floor.
    expect(5 - p.y).toBeGreaterThan(1.5)
    expect(5 - p.y).toBeLessThan(2.4)
    expect(Math.abs(p.x - 4)).toBeLessThan(0.2)
  })

  it('a doctor tied to a heavy body drags it, and two doctors tied share the pull', () => {
    const sim = hall()
    const [a, b] = pair(sim, 2)
    const leash = thing('leash', `return { use() { w.tie(me, w.others()[0], { length: 2.5, secs: 20 }) } }`)
    sim.newThing(compileThing(leash), a, a.pos)
    press(a, 'use')
    steps(sim, 2)
    // b runs off along +z: a, at the other end of the rope (in hand), is towed after.
    b.input = { ...b.input, yaw: 0, move: [0, 1] }
    steps(sim, 60)
    expect(a.pos[2]).toBeGreaterThan(1)
    expect(b.pos[2] - a.pos[2]).toBeLessThan(3.3)
  })
})

describe('knocked flat on purpose, stuck and struck', () => {
  it('topple throws a doctor as a ragdoll, but not again just after they get up', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    const trip = thing('trip', `return { use() { w.topple(w.others()[0], [0, 6, 4]) } }`)
    sim.newThing(compileThing(trip), a, a.pos)
    press(a, 'use')
    steps(sim, 3)
    expect(b.rag).not.toBe(null)
    for (let i = 0; i < 400 && b.rag; i++) sim.step()
    expect(b.rag).toBe(null)
    press(a, 'use')
    steps(sim, 3)
    expect(b.rag).toBe(null)
  })

  it('a body stuck to a doctor goes with them and does not get in their way', () => {
    const sim = hall()
    const [a, b] = pair(sim, 5)
    const sticky = thing(
      'sticky',
      `return { use() { const at = me.aim(); w.spawn({ shape: 'ball', size: 0.25, at: at.from, vel: [0, 0, 25], gravity: 0, life: 15, hit(t, body) { if (t.doctor) { body.stick(t); w.text(t.point, 'stuck') } } }) } }`,
    )
    sim.newThing(compileThing(sticky), a, a.pos)
    press(a, 'use')
    const stuck = record(sim, 30).some((e) => e.type === 'text' && e.text === 'stuck')
    expect(stuck).toBe(true)
    const ball = [...sim.bodies.values()][0]!
    const off = sub([ball.rb.translation().x, ball.rb.translation().y, ball.rb.translation().z], b.pos)
    // b walks off sideways and turns round; the ball goes along, as far from their feet.
    b.input = { ...b.input, yaw: Math.PI / 2, move: [0, 1] }
    steps(sim, 60)
    expect(b.pos[0]).toBeGreaterThan(4)
    const t = ball.rb.translation()
    expect(Math.abs(len(sub([t.x, t.y, t.z], b.pos)) - len(off))).toBeLessThan(0.1)
  })

  it('a heavy body hitting a doctor knocks them by its momentum; a light one hardly moves them', () => {
    const sim = hall()
    const [a, b] = pair(sim, 6)
    const shot = thing('shot', `return { use() { w.spawn({ shape: 'ball', size: 0.6, mass: 300, at: [0, 1, 2], vel: [0, 0, 16], gravity: 0 }) }, alt() { w.spawn({ shape: 'ball', size: 0.2, mass: 0.3, at: [0, 1, 2], vel: [0, 0, 16], gravity: 0 }) } }`)
    sim.newThing(compileThing(shot), a, a.pos)
    press(a, 'alt')
    steps(sim, 25)
    expect(b.rag).toBe(null)
    expect(Math.hypot(b.push[0], b.push[2])).toBeLessThan(0.5)
    press(a, 'use')
    steps(sim, 25)
    expect(b.rag).not.toBe(null)
    // Momentum moves; it does not take credibility (only code does).
    expect(b.cred).toBe(START_CRED)
  })
})

describe('the view covered', () => {
  it('blinds a doctor in a colour, as a hold that is shaken off', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    const flash = thing('flash', `return { use() { w.affect(w.others()[0], { blind: 1, tint: 'white' }, 12) } }`)
    sim.newThing(compileThing(flash), a, a.pos)
    press(a, 'use')
    steps(sim, 2)
    expect(sim.snapshot().doctors.find((d) => d.id === 'b')!.fx).toMatchObject({ blind: 1, tint: '#f4f1ea', held: true })
    steps(sim, HOLD_MAX * 60)
    expect(sim.snapshot().doctors.find((d) => d.id === 'b')!.fx).toBe(null)
    void b
  })
})
