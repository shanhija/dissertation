import { beforeAll, describe, expect, it } from 'vitest'

import { BUDGET_WINDOW, HIT_CAP, HOLD_MAX, HOLD_REST, PER_SECOND_CAP, START_CRED } from '../protocol'
import { thingApi } from './api'
import { buildArena, checkArena } from './arena'
import { LECTURE_HALL } from './hall'
import { MadeCodeError, call, compile } from './sandbox'
import { FLOP, Sim, initPhysics, len, sub } from './sim'
import { holdDown, hall, pair, press, steps } from './testkit'
import { STARTERS, compileThing, trialThing, type ThingDesign } from './things'

beforeAll(async () => {
  await initPhysics()
})

describe('doctors', () => {
  it('stand on the floor, walk where they face and jump', () => {
    const sim = hall()
    const [a] = pair(sim, 8)
    expect(a.grounded).toBe(true)
    expect(a.pos[1]).toBeCloseTo(0, 1)
    a.input = { ...a.input, move: [0, 1] }
    steps(sim, 30)
    expect(a.pos[2]).toBeGreaterThan(2)
    a.input = { ...a.input, move: [0, 0] }
    press(a, 'jump')
    steps(sim, 12)
    expect(a.pos[1]).toBeGreaterThan(0.8)
    steps(sim, 60)
    expect(a.grounded).toBe(true)
  })

  it('walk up steep stairs, met squarely or at a slant, without jumping', () => {
    for (const yaw of [0, 0.35]) {
      const sim = new Sim(() => 0.5)
      sim.apiFor = thingApi
      buildArena(sim, {
        id: 'stairs',
        name: 'Stairs',
        build: compile('arena', `a.box([30, 1, 30], { at: [0, -0.5, 0] })
for (let i = 0; i < 8; i++) a.box([4, 0.42 * (i + 1), 0.35], { at: [0, 0.21 * (i + 1), 2 + i * 0.35] })
a.box([4, 3.36, 4], { at: [0, 1.68, 6.63] })
a.spawn([0, 0, -2])`),
      })
      const d = sim.addDoctor('a', 'A', false)
      sim.teleport(d, [yaw ? -1.4 : 0, 0.05, -1])
      d.input = { ...d.input, yaw, move: [0, 1] }
      // Up the eight steps within 2.5 s (it walks on off the landing after).
      let highest = 0
      for (let i = 0; i < 150; i++) {
        sim.step()
        highest = Math.max(highest, d.pos[1])
      }
      expect(highest, `yaw ${yaw}`).toBeGreaterThan(3.3)
      sim.free()
    }
  })

  it('shove: a push and three credibility', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1.2)
    const before = b.pos[2]
    press(a, 'use')
    steps(sim, 20)
    expect(b.cred).toBe(START_CRED - 3)
    expect(b.pos[2]).toBeGreaterThan(before + 0.5)
  })

  it('falling out of the arena costs ten and puts the doctor back at a spawn', () => {
    const sim = hall()
    const [a] = pair(sim)
    sim.teleport(a, [0, -40, 0])
    steps(sim, 2)
    expect(a.cred).toBe(START_CRED - 10)
    expect(a.pos[1]).toBeGreaterThan(-1)
  })
})

describe('movers', () => {
  it('carry a doctor round on a turntable and push one out of the way of a sweeping arm', () => {
    const sim = new Sim(() => 0.5)
    sim.apiFor = thingApi
    buildArena(sim, {
      id: 'movers',
      name: 'Movers',
      build: compile(
        'arena',
        `a.box([60, 1, 60], { at: [0, -0.5, 0] })
a.mover(() => a.cylinder(4, 0.4, { at: [0, 0.2, 0] }), (t) => ({ at: [10, 0, 0], rot: [0, t, 0] }))
a.mover(() => a.box([6, 1.5, 0.4], { at: [3, 0.75, 0] }), (t) => ({ at: [-10, 0, 0], rot: [0, t * 2, 0] }))
for (let i = 0; i < 8; i++) a.spawn([i * 3 - 12, 0, 20])`,
      ),
    })
    sim.live = true
    const rider = sim.addDoctor('rider', 'Rider', false)
    const swept = sim.addDoctor('swept', 'Swept', false)
    sim.teleport(rider, [12.5, 0.45, 0])
    sim.teleport(swept, [-6, 0.05, 0.3])
    steps(sim, 30)
    const start = [...rider.pos]
    steps(sim, 90)
    // On the turntable: carried round with it, still standing on it.
    expect(Math.hypot(rider.pos[0] - start[0]!, rider.pos[2] - start[2]!)).toBeGreaterThan(1.5)
    expect(Math.hypot(rider.pos[0] - 10, rider.pos[2])).toBeLessThan(4)
    // In the arm's way: pushed off, not passed through.
    expect(Math.hypot(swept.pos[0] + 6, swept.pos[2] - 0.3)).toBeGreaterThan(1)
  })
})

describe('the rules of harm', () => {
  it('caps a hit, a second and a thing', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    expect(sim.harm(b, 50, { attacker: 'a', thing: null, what: 'x' })).toBe(HIT_CAP)
    expect(sim.harm(b, 50, { attacker: 'a', thing: null, what: 'x' })).toBe(PER_SECOND_CAP - HIT_CAP)
    expect(sim.harm(b, 5, { attacker: 'a', thing: null, what: 'x' })).toBe(0)
    // Another attacker has a second of its own.
    expect(sim.harm(b, 5, { attacker: null, thing: null, what: 'the arena' })).toBe(5)
    steps(sim, 70)
    const pen = sim.newThing(compileThing(STARTERS[0]!), a, a.pos)
    expect(sim.harm(b, 9, { attacker: 'a', thing: pen, what: 'pen' })).toBe(9)
    steps(sim, 70)
    // The pen's budget is 10 from each player in any 20 s; then it takes again.
    expect(sim.harm(b, 9, { attacker: 'a', thing: pen, what: 'pen' })).toBe(1)
    // 18 s after the first strike nothing yet; past 20 s the first strike's 9 is free again.
    steps(sim, (BUDGET_WINDOW - 3) * 60)
    expect(sim.harm(b, 9, { attacker: 'a', thing: pen, what: 'pen' })).toBe(0)
    steps(sim, 3 * 60)
    expect(sim.harm(b, 9, { attacker: 'a', thing: pen, what: 'pen' })).toBe(9)
  })

  it('a doctor at zero is out and drops what they held', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    sim.newThing(compileThing(STARTERS[0]!), b, b.pos)
    for (let i = 0; i < 12; i++) {
      sim.harm(b, 10, { attacker: 'a', thing: null, what: 'x' })
      steps(sim, 61)
    }
    expect(b.alive).toBe(false)
    expect(b.hands).toEqual([null, null])
    expect([...sim.things.values()][0]!.holder).toBe(null)
    expect(sim.snapshot().events.some((e) => e.type === 'out' && e.victim === 'b')).toBe(true)
    void a
  })
})

describe('things', () => {
  it('the starter things compile and go through the trial without an error', () => {
    for (const d of STARTERS) expect(trialThing(compileThing(d)), d.id).toEqual([])
  })

  it('the red pen strikes the doctor it is aimed at', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    sim.newThing(compileThing(STARTERS[0]!), a, a.pos)
    a.input = { ...a.input, pitch: -0.05 }
    press(a, 'use')
    steps(sim, 5)
    expect(b.cred).toBe(START_CRED - 5)
  })

  it('the thesis launcher hits a doctor in its path', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    sim.newThing(compileThing(STARTERS[1]!), a, a.pos)
    a.input = { ...a.input, pitch: -0.12 }
    press(a, 'use')
    steps(sim, 40)
    expect(b.cred).toBe(START_CRED - 10)
  })

  it('a thrown thing hits too', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    sim.newThing(compileThing(STARTERS[0]!), a, a.pos)
    a.input = { ...a.input, pitch: -0.1 }
    press(a, 'throw')
    steps(sim, 30)
    expect(b.cred).toBe(START_CRED - 6)
  })

  it('code that breaks fizzles away instead of stopping the round', () => {
    const sim = hall()
    const [a] = pair(sim)
    const broken: ThingDesign = { ...STARTERS[0]!, id: 'broken', code: 'return { tick() { undefinedThing.x = 1 } }' }
    expect(() => compileThing(broken)).toThrow(MadeCodeError)
    const throwing: ThingDesign = { ...STARTERS[0]!, id: 'throwing', code: 'return { tick() { const o = null; o.x = 1 } }' }
    sim.newThing(compileThing(throwing), a, a.pos)
    steps(sim, 10)
    expect(a.hands).toEqual([null, null])
    expect(sim.snapshot().events.some((e) => e.type === 'fizzle')).toBe(true)
  })
})

describe('two hands', () => {
  const marker = (id: string): ThingDesign => ({ ...STARTERS[0]!, id, code: `return { use() { w.text([0, 0, 0], '${id} use') }, hold() { w.text([0, 0, 0], '${id} hold') }, alt() { w.text([0, 0, 0], '${id} other') } }` })
  const said = (sim: Sim, n: number) => {
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      sim.step()
      for (const e of sim.snapshot().events) if (e.type === 'text' && !out.includes(e.text)) out.push(e.text)
    }
    return out
  }

  it('each button works the hand on its side, shift-click is the other use, each hand throws on its own, and an empty hand shoves', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1.2)
    sim.newThing(compileThing(marker('lefty')), a, a.pos)
    sim.newThing(compileThing(marker('righty')), a, a.pos)
    expect(a.hands.map((id) => (id ? sim.things.get(id)!.kind.id : null))).toEqual(['lefty', 'righty'])
    // The two are held apart, each at its own side.
    expect(len(sub(sim.thingPos(sim.inHand(a, 0)!), sim.thingPos(sim.inHand(a, 1)!)))).toBeCloseTo(0.56, 2)
    press(a, 'use', 1)
    expect(said(sim, 2)).toEqual(['righty use'])
    press(a, 'use', 0)
    holdDown(a, true, 0)
    expect(said(sim, 3)).toEqual(['lefty use', 'lefty hold'])
    holdDown(a, false, 0)
    press(a, 'alt', 1)
    expect(said(sim, 2)).toEqual(['righty other'])
    // Q throws the left hand's (away from b); the right hand keeps its own.
    a.input = { ...a.input, yaw: Math.PI }
    press(a, 'throw', 0)
    steps(sim, 2)
    a.input = { ...a.input, yaw: 0 }
    steps(sim, 30)
    expect(a.hands[0]).toBe(null)
    expect(sim.inHand(a, 1)!.kind.id).toBe('righty')
    // The empty left hand shoves.
    press(a, 'use', 0)
    steps(sim, 2)
    expect(b.cred).toBe(START_CRED - 3)
    // Picked up again it goes to the empty left hand; a third, with both full, takes the left hand's place.
    sim.newThing(compileThing(marker('third')), a, a.pos)
    expect(sim.inHand(a, 0)!.kind.id).toBe('third')
    sim.newThing(compileThing(marker('fourth')), a, a.pos)
    expect(a.hands.map((id) => (id ? sim.things.get(id)!.kind.id : null))).toEqual(['fourth', 'righty'])
    expect([...sim.things.values()].find((t) => t.kind.id === 'third')!.holder).toBe(null)
    // F throws the right hand's.
    press(a, 'throw', 1)
    steps(sim, 2)
    expect(a.hands[1]).toBe(null)
    expect(sim.snapshot().doctors.find((d) => d.id === 'a')!.hands).toEqual([a.hands[0], null])
  })
})

describe('disguises and riding', () => {
  it('a thing can draw its holder as itself, and a ridden thing goes under the feet', () => {
    const sim = hall()
    const [a] = pair(sim)
    const box: ThingDesign = { ...STARTERS[0]!, id: 'box', code: 'return { picked() { me.disguise() }, alt() { me.disguise(false) } }' }
    sim.newThing(compileThing(box), a, a.pos)
    steps(sim, 2)
    expect(sim.snapshot().doctors.find((d) => d.id === 'a')!.disguise).toBe('thing:box')
    press(a, 'alt')
    steps(sim, 2)
    expect(sim.snapshot().doctors.find((d) => d.id === 'a')!.disguise).toBe(null)
    sim.newThing(compileThing(STARTERS[2]!), a, a.pos)
    steps(sim, 2)
    const snap = sim.snapshot()
    expect(snap.doctors.find((d) => d.id === 'a')!.riding).toBe(snap.things.find((t) => t.kind === STARTERS[2]!.id)!.id)
    // The ridden thing went into the right hand (the box is in the left), and is drawn under the feet.
    expect(snap.things.find((t) => t.kind === STARTERS[2]!.id)!.p).toEqual(snap.doctors.find((d) => d.id === 'a')!.p)
  })
})

describe('holds and how effects show', () => {
  const binder: ThingDesign = {
    ...STARTERS[0]!,
    id: 'binder',
    code: `const wrap = w.model('wrap', (m) => m.torus(0.5, 0.04, { at: [0, 1, 0], rot: [Math.PI / 2, 0, 0] }))
return { use() { for (const d of w.others()) w.affect(d, { speed: 0, jump: 0, hands: false, shake: 1, glow: 'cyan', wear: wrap }, 10) } }`,
  }

  it('a hold keeps a doctor where they stand with their hands bound, shows on them, and is shaken off after a while', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    sim.newThing(compileThing(binder), a, a.pos)
    sim.newThing(compileThing(STARTERS[0]!), b, b.pos)
    press(a, 'use')
    steps(sim, 2)
    const fx = sim.snapshot().doctors.find((d) => d.id === 'b')!.fx!
    expect(fx).toEqual({ shake: 1, glow: '#3ac8d6', blind: 0, tint: null, wear: ['thing:binder:0'], held: true })
    // Walking, jumping and using do nothing.
    const at = [...b.pos]
    b.input = { ...b.input, move: [0, 1] }
    press(b, 'jump')
    press(b, 'use')
    steps(sim, 60)
    expect(Math.hypot(b.pos[0] - at[0], b.pos[2] - at[2])).toBeLessThan(0.05)
    expect(b.pos[1]).toBeCloseTo(at[1]!, 1)
    expect(a.cred).toBe(START_CRED)
    // At HOLD_MAX the hold ends; a new one does not take for HOLD_REST.
    steps(sim, (HOLD_MAX - 1) * 60 + 5)
    expect(sim.snapshot().doctors.find((d) => d.id === 'b')!.fx).toBe(null)
    press(a, 'use')
    steps(sim, 30)
    expect(Math.hypot(b.pos[0] - at[0], b.pos[2] - at[2])).toBeGreaterThan(1)
    steps(sim, HOLD_REST * 60)
    press(a, 'use')
    steps(sim, 2)
    expect(sim.snapshot().doctors.find((d) => d.id === 'b')!.fx?.held).toBe(true)
  })

  it('hands bound while the click is held let go of the thing once', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    sim.newThing(compileThing(binder), a, a.pos)
    const counter: ThingDesign = { ...STARTERS[0]!, id: 'counter', code: `let n = 0\nreturn { hold() { n++ }, release() { w.text([0, 0, 0], 'let go after ' + (n > 0 ? 'holding' : 'nothing')) } }` }
    sim.newThing(compileThing(counter), b, b.pos)
    b.input = { ...b.input, hands: [true, false] }
    press(b, 'use')
    steps(sim, 10)
    press(a, 'use')
    const texts: string[] = []
    for (let i = 0; i < 30; i++) {
      sim.step()
      for (const e of sim.snapshot().events) if (e.type === 'text') texts.push(e.text)
    }
    expect(texts).toEqual(['let go after holding'])
  })

  it('bodies grow as drawn and as they collide, point where they fly, and carry their poses and trail', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    const maker: ThingDesign = {
      ...STARTERS[0]!,
      id: 'maker',
      code: `let ball = null
let dart = null
const hits = []
const fin = w.model('fin', (m) => { m.box(0.1, 0.1, 0.6); m.part('tail', { at: [0, 0, -0.3] }, () => m.box(0.3, 0.02, 0.1)) })
return {
  use() {
    ball = w.spawn({ shape: 'ball', size: 0.2, at: [0, 1, 1.8], gravity: 0, solid: false, life: 10, hit(t) { if (t.doctor) hits.push(t.doctor.id) } })
    dart = w.spawn({ model: fin, at: [3, 3, 0], vel: [8, 6, 0], face: true, trail: 'grey', life: 10 })
    dart.pose('tail', [0, 0, 1])
  },
  alt() { ball.resize(12) },
  tick() { me.resize(hits.length ? 2 : 1) },
}`,
    }
    const t = sim.newThing(compileThing(maker), a, a.pos)
    press(a, 'use')
    steps(sim, 10)
    expect(t.scale).toBe(1)
    press(a, 'alt')
    steps(sim, 5)
    expect(t.scale).toBe(2)
    const snap = sim.snapshot()
    const ball = snap.bodies.find((x) => x.prim)!
    // Resizing stops at ten times.
    expect(ball.scale).toBe(10)
    const dart = snap.bodies.find((x) => x.model)!
    expect(dart.trail).toBe('#8a8f98')
    expect(dart.poses).toEqual({ tail: [0, 0, 1] })
    // Its +z along its flight: up and to +x.
    const body = [...sim.bodies.values()].find((x) => x.model)!
    const v = body.rb.linvel()
    const q = body.rb.rotation()
    const z = [2 * (q.x * q.z + q.w * q.y), 2 * (q.y * q.z - q.w * q.x), 1 - 2 * (q.x * q.x + q.y * q.y)]
    const l = Math.hypot(v.x, v.y, v.z)
    expect(z[0]! * (v.x / l) + z[1]! * (v.y / l) + z[2]! * (v.z / l)).toBeGreaterThan(0.99)
    void b
  })

  it('a hit is told its own body, how it came in and how old it is, and the body goes on until removed', () => {
    const sim = hall()
    const [a, b] = pair(sim, 6)
    const shooter: ThingDesign = {
      ...STARTERS[0]!,
      id: 'shooter',
      code: `return { use() {
  const at = me.aim()
  w.spawn({ shape: 'ball', size: 0.3, at: at.from, vel: [at.dir[0] * 30, at.dir[1] * 30, at.dir[2] * 30], gravity: 0, life: 4,
    hit(t, body) { if (t.doctor) { w.text(t.point, [t.vel.map(Math.round).join(','), body.age() > 0.1 ? 'old' : 'young'].join(' ')); w.hurt(t.doctor, 2); body.remove() } } })
} }`,
    }
    sim.newThing(compileThing(shooter), a, a.pos)
    a.input = { ...a.input, pitch: -0.08 }
    press(a, 'use')
    const texts: string[] = []
    for (let i = 0; i < 40; i++) {
      sim.step()
      for (const e of sim.snapshot().events) if (e.type === 'text') texts.push(e.text)
    }
    // Straight down the line at 30 m/s before it touched, 6 m in 0.2 s; one hit, then gone.
    expect(texts).toEqual(['0,-2,30 old'])
    expect(b.cred).toBe(START_CRED - 2)
    expect(sim.bodies.size).toBe(0)
  })

  it('clouds, shakes and crackling beams go out clamped', () => {
    const sim = hall()
    const [a] = pair(sim)
    const shower: ThingDesign = {
      ...STARTERS[0]!,
      id: 'shower',
      code: `return { use() { w.puff([0, 1, 0], { color: 'orange', size: 40, glow: true }); w.shake([0, 1, 0], 3); w.beam([0, 1, 0], [0, 1, 5], { jag: 0.7 }); w.burst([0, 1, 0], { glow: true }) } }`,
    }
    sim.newThing(compileThing(shower), a, a.pos)
    press(a, 'use')
    steps(sim, 1)
    const events = sim.snapshot().events
    expect(events).toContainEqual({ type: 'puff', at: [0, 1, 0], color: '#ee8a2a', size: 16, secs: 1, rise: 0, glow: true })
    expect(events).toContainEqual({ type: 'shake', at: [0, 1, 0], strength: 1 })
    expect(events.find((e) => e.type === 'beam')).toMatchObject({ jag: 0.7 })
    expect(events.find((e) => e.type === 'burst')).toMatchObject({ glow: true })
  })
})

describe('knocked flat', () => {
  /** The bend of a hinge between two parts, about x, + swinging the child back (as the drawn joints). */
  const bend = (parent: { rotation(): { x: number; y: number; z: number; w: number } }, child: typeof parent) => {
    const a = parent.rotation()
    const b = child.rotation()
    // a⁻¹ b, then the angle about x.
    const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y
    const w = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z
    return 2 * Math.atan2(x, w)
  }

  it('a big knock makes a ragdoll that drops what it held, lands, bends only the right ways, and gets up', () => {
    const sim = hall()
    const [a] = pair(sim, 6)
    sim.newThing(compileThing(STARTERS[0]!), a, a.pos)
    // Sideways, onto open floor (ahead lies the stage's step).
    sim.knock(a, [FLOP, 8, 0])
    expect(a.rag).not.toBe(null)
    expect(a.hands).toEqual([null, null])
    expect(sim.snapshot().doctors.find((d) => d.id === 'a')!.rag!.q).toHaveLength(11)
    a.input = { ...a.input, move: [0, 1] }
    let lowest = Infinity
    let worst = 0
    let steps = 0
    while (a.rag && steps < 300) {
      sim.step()
      steps++
      lowest = Math.min(lowest, a.rag?.pelvis()[1] ?? lowest)
      const parts = a.rag?.parts
      if (!parts) break
      // Knees (thigh to shin) and elbows (upper to fore) inside their limits.
      for (const [p, c, lo, hi] of [[7, 8, 0, 2.4], [9, 10, 0, 2.4], [3, 4, -2.5, 0], [5, 6, -2.5, 0]] as const) {
        const t = bend(parts[p]!, parts[c]!)
        worst = Math.max(worst, lo - t, t - hi)
      }
    }
    // The joints are solved softly: a hard landing may push one past its stop for a moment, never the wrong way round.
    expect(worst).toBeLessThan(0.6)
    // It flew and came down on the floor, then got up within 3.5 s, standing where it lay.
    expect(lowest).toBeLessThan(0.45)
    expect(a.rag).toBe(null)
    expect(steps).toBeLessThan(3.6 * 60)
    expect(a.pos[0]).toBeGreaterThan(1.5)
    const at = a.pos[2]
    steps = 0
    while (steps++ < 60) sim.step()
    expect(a.pos[2]).toBeGreaterThan(at + 2)
  })

  it('a shove only pushes', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1.2)
    press(a, 'use')
    steps(sim, 3)
    expect(b.rag).toBe(null)
    expect(b.pos[2]).toBeGreaterThan(1.2)
  })

  it('a body that hits the doctor lying there finds them', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    sim.knock(b, [0, 6, 14])
    steps(sim, 40)
    const lying = b.rag!.pelvis()
    const thrower: ThingDesign = { ...STARTERS[0]!, id: 'thrower', code: `return { use() { w.spawn({ shape: 'ball', size: 0.3, at: [${lying[0]}, ${lying[1] + 1.5}, ${lying[2]}], vel: [0, -12, 0], hit(t) { if (t.doctor) w.text(t.point, t.doctor.id) } }) } }` }
    sim.newThing(compileThing(thrower), a, a.pos)
    press(a, 'use')
    const hits: string[] = []
    for (let i = 0; i < 30; i++) {
      sim.step()
      for (const e of sim.snapshot().events) if (e.type === 'text') hits.push(e.text)
    }
    expect(hits).toContain('b')
  })

  it('a knock while down throws the ragdoll again', () => {
    const sim = hall()
    const [, b] = pair(sim, 3)
    sim.knock(b, [0, 6, 14])
    steps(sim, 40)
    const before = b.rag!.pelvis()
    sim.knock(b, [0, 10, 0])
    steps(sim, 10)
    expect(b.rag!.pelvis()[1]).toBeGreaterThan(before[1] + 0.5)
  })

  it('a dismissed doctor falls as a ragdoll, lies a while, then sinks away', () => {
    const sim = hall()
    const [a, b] = pair(sim, 3)
    b.cred = 5
    sim.harm(b, 10, { attacker: 'a', thing: null, what: 'x' })
    expect(b.alive).toBe(false)
    expect(b.rag).not.toBe(null)
    steps(sim, 60 * 5)
    expect(b.rag).not.toBe(null)
    steps(sim, 60 * 4)
    expect(b.rag).toBe(null)
    expect(sim.snapshot().doctors.find((d) => d.id === 'b')!.rag).toBe(null)
    void a
  })
})

describe('crates', () => {
  it('come in near the asker, wait for the design and open for whoever is first', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1)
    const c = sim.dropCrate('a')!
    expect(c.state).toBe('arriving')
    // Coming in, it is only a sight: nobody can open it yet.
    steps(sim, 60)
    sim.fillCrate(c.id, compileThing(STARTERS[0]!))
    sim.teleport(b, [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]])
    steps(sim, 2)
    press(b, 'pick')
    steps(sim, 2)
    expect(sim.crates.size).toBe(1)
    expect(c.state).toBe('arriving')
    steps(sim, 60 * 3)
    expect(c.state).toBe('ready')
    void a
  })

  it('come in on floor the asker can walk to: under a roof, never on it, nor on top of a building', () => {
    let seed = 7
    const sim = new Sim(() => (seed = (seed * 16807) % 2147483647) / 2147483647)
    sim.apiFor = thingApi
    buildArena(sim, {
      id: 'room',
      name: 'Room',
      build: compile(
        'arena',
        `a.box([30, 1, 30], { at: [0, -0.5, 0], material: 'planks' })
a.box([30, 0.5, 30], { at: [0, 4.25, 0], material: 'plaster' })
for (const s of [-1, 1]) { a.box([0.5, 4, 30], { at: [s * 15, 2, 0], material: 'plaster' }); a.box([30, 4, 0.5], { at: [0, 2, s * 15], material: 'plaster' }) }
a.box([3, 3, 30], { at: [-4.5, 1.5, 0], material: 'brick' })
a.light({ at: [0, 3, 0], power: 0.5, range: 10 })
for (let i = 0; i < 8; i++) a.spawn([i - 4, 0, 10])`,
      ),
    })
    sim.live = true
    const d = sim.addDoctor('a', 'A', false)
    sim.teleport(d, [-1.5, 0.05, 0])
    steps(sim, 10)
    const xs: number[] = []
    for (let i = 0; i < 12; i++) {
      const c = sim.dropCrate('a')!
      expect(c.p[1]).toBeCloseTo(0.47, 1)
      expect(c.p[0]).toBeGreaterThan(-3 + 0.44)
      expect(Math.hypot(c.p[0] - d.pos[0], c.p[2] - d.pos[2])).toBeGreaterThan(1.2)
      xs.push(c.p[0])
      steps(sim, 60 * 3 + 5)
      expect(c.state).toBe('waiting')
      sim.crates.clear()
    }
    // Not always the same spot.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1)
  })

  it('wait for the design and open for whoever is first', () => {
    const sim = hall()
    const [a, b] = pair(sim, 1)
    const c = sim.dropCrate('a')!
    steps(sim, 60 * 8)
    expect(c.state).toBe('waiting')
    const dist = Math.hypot(c.p[0] - a.pos[0], c.p[2] - a.pos[2])
    expect(dist).toBeGreaterThan(1.5)
    expect(dist).toBeLessThan(6)
    sim.fillCrate(c.id, compileThing(STARTERS[0]!))
    expect(c.state).toBe('ready')
    sim.teleport(b, [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]])
    steps(sim, 2)
    press(b, 'pick')
    steps(sim, 2)
    expect(sim.crates.size).toBe(0)
    expect(b.hands[0]).not.toBe(null)
  })
})

describe('falls', () => {
  it('a long fall costs credibility on landing, a jump or a short drop nothing', () => {
    const sim = hall()
    const [a, b] = pair(sim, 8)
    press(a, 'jump')
    steps(sim, 90)
    expect(a.cred).toBe(START_CRED)
    sim.teleport(a, [a.pos[0], 3, a.pos[2]])
    steps(sim, 90)
    expect(a.cred).toBe(START_CRED)
    sim.teleport(b, [b.pos[0], 5, b.pos[2]])
    steps(sim, 90)
    expect(b.cred).toBeLessThan(START_CRED - 2)
    expect(b.cred).toBeGreaterThan(START_CRED - 6)
    // From high up, the most one hit may take.
    const before = b.cred
    steps(sim, 60)
    sim.teleport(b, [b.pos[0], 12, b.pos[2]])
    steps(sim, 120)
    expect(before - b.cred).toBe(HIT_CAP)
  })
})

describe('arenas', () => {
  it('the lecture hall passes its checks', () => {
    expect(checkArena(LECTURE_HALL)).toEqual([])
  })

  it('a solid shaped piece is stood on as drawn; a decoration is not there to stand on', () => {
    const sim = new Sim(() => 0.5)
    sim.apiFor = thingApi
    buildArena(sim, {
      id: 'shapes',
      name: 'Shapes',
      build: compile(
        'arena',
        `a.box([40, 1, 40], { at: [0, -0.5, 0], material: 'planks' })
a.solid((m) => m.lathe([[3, 0], [2.5, 2], [0.001, 2.2]], {}), { at: [-8, 0, 0], material: 'marble' })
a.decor((m) => m.box(4, 2, 4, {}), { at: [8, 1, 0], material: 'wood' })
a.light({ at: [0, 5, 0], power: 0.5, range: 10 })
for (let i = 0; i < 8; i++) a.spawn([i * 3 - 12, 0, 12])`,
      ),
    })
    sim.step()
    expect(sim.groundBelow([-7.7, 5, 0.3], 10)!.y).toBeCloseTo(2.17, 1)
    expect(sim.groundBelow([8, 5, 0], 10)!.y).toBeCloseTo(0, 1)
    const view = sim.arena!.view
    expect(view.solids[0]!.material).toBe('planks')
    expect(view.decor.map((d) => [d.material, d.solid])).toEqual([
      ['marble', true],
      ['wood', false],
    ])
    expect(view.lights).toHaveLength(1)
  })

  it('an empty decoration is nothing to draw, not a fault', () => {
    const problems = checkArena({
      id: 'empty-decor',
      name: 'Empty decor',
      build: compile('arena', `a.box([40, 1, 40], { at: [0, -0.5, 0] })\na.decor(function (m) {}, { at: [0, 0, 0] })\nfor (let i = 0; i < 8; i++) a.spawn([i * 3 - 12, 0, 10])`),
    })
    expect(problems).toEqual([])
  })

  it('hangs the doctors\' portraits: the next along unless a rank is given, sizes and ranks kept in bounds', () => {
    const sim = new Sim(() => 0.5)
    buildArena(sim, {
      id: 'gallery',
      name: 'Gallery',
      build: compile('arena', `a.box([40, 1, 40], { at: [0, -0.5, 0] })
a.portrait({ at: [0, 3, -10] })
a.portrait({ at: [2, 3, -10], rot: [0, 1, 0], size: 40 })
a.portrait({ at: [4, 3, -10], rank: 99, size: 0 })
a.portrait({ rank: 1 })
a.spawn([0, 0, 0])`),
    })
    expect(sim.arena!.view.portraits).toEqual([
      { at: [0, 3, -10], rot: [0, 0, 0], size: 1.2, rank: 0, mover: null },
      { at: [2, 3, -10], rot: [0, 1, 0], size: 6, rank: 1, mover: null },
      { at: [4, 3, -10], rot: [0, 0, 0], size: 0.3, rank: 7, mover: null },
    ])
    sim.free()
    const hall = new Sim(() => 0.5)
    buildArena(hall, LECTURE_HALL)
    expect(hall.arena!.view.portraits.map((p) => p.rank)).toEqual([0, 1, 2, 3, 4, 5, 6])
    hall.free()
  })

  it('an arena that hurts at a spawn point is refused', () => {
    const problems = checkArena({
      id: 'bad',
      name: 'Bad',
      build: compile(
        'arena',
        `a.box([20, 1, 20], { at: [0, -0.5, 0] })
for (let i = 0; i < 8; i++) a.spawn([i * 2 - 8, 0, 0])
a.zone({ at: [0, 1, 0], size: [20, 2, 4] }, { stay(d) { w.hurt(d, 5) } })`,
      ),
    })
    expect(problems.some((p) => p.includes('lost credibility'))).toBe(true)
  })
})

describe('the sandbox', () => {
  it('refuses names outside the game and stops loops that never end', () => {
    expect(() => compile('thing', 'return process.exit()')).toThrow(/process/)
    expect(() => compile('thing', 'const f = (() => 1).constructor')).toThrow(/constructor/)
    const spin = compile('thing', 'while (true) {}')
    const r = call(spin, null, {}, {})
    expect(r.ok).toBe(false)
  })
})
