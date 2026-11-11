/**
 * Bots, for trying the game alone. A bot reads the sim the way a player reads the screen and
 * answers with an Input: it goes for a crate or a loose thing when its hands are empty (and for a
 * near one when one hand is; beside a crate not yet open to it, it waits), else for the nearest
 * doctor, on a way of its own (at a slant, round them, now and then nearly straight in or a step
 * back), aims with a little wobble and a spread drawn at each use (so it misses, the more the
 * farther off), uses what it holds when the target is in sight (with the hand whose thing may
 * still take from that doctor), shoves when close, jumps when stuck or when the target is above,
 * and keeps off edges.
 */

import { NO_INPUT, type Hand, type Input, type Vec3 } from '../protocol'
import { EYE, aimOf, len, sub, type Doctor, type Sim } from './sim'

const SIGHT = 28
/**
 * How far off a bot's aim is at each use or throw at its foe, one standard deviation each way
 * (radians). Before it, a bot's wobble missed nobody within 6 m.
 */
const SPREAD = 0.07

export class Bot {
  private presses: Input['presses'] = { ...NO_INPUT.presses, use: [0, 0], other: [0, 0], throw: [0, 0] }
  private nextUse = 0
  private nextThrow = 0
  private holdUntil = 0
  /** The hand it holds down, while it does. */
  private holding: Hand = 0
  /** The angle off the straight line to its foe it walks at (0 straight at them, ±π/2 round them, past that away), and until when. */
  private way = 0
  private wayUntil = 0
  /** How far off its aim is, in yaw and pitch: drawn anew at each use or throw at its foe. */
  private off: [number, number] = [0, 0]
  private stuckSince = 0
  private lastPos: Vec3 = [0, 0, 0]
  private target: string | null = null
  private retarget = 0
  private detour: Vec3 | null = null
  private detourUntil = 0

  constructor(
    readonly id: string,
    private readonly random: () => number,
  ) {}

  think(sim: Sim): Input {
    const d = sim.doctors.get(this.id)
    if (!d || !d.alive || !sim.live) return { ...NO_INPUT, yaw: d?.yaw ?? 0, presses: this.presses }
    const t = sim.time
    const press = (k: 'pick' | 'jump') => {
      this.presses = { ...this.presses, [k]: this.presses[k] + 1 }
    }
    const pressHand = (k: 'use' | 'other' | 'throw', h: Hand) => {
      const n: [number, number] = [...this.presses[k]]
      n[h]++
      this.presses = { ...this.presses, [k]: n }
    }
    const drawAim = () => {
      const r = SPREAD * Math.sqrt(-2 * Math.log(1 - this.random()))
      const a = this.random() * Math.PI * 2
      this.off = [r * Math.cos(a), r * Math.sin(a)]
    }

    // What to go for: a crate or a loose thing with empty hands, else a doctor.
    let goal: Vec3 | null = null
    let goalIsPickup = false
    /** The goal is a crate not yet open to it: it stands beside it rather than walk into it. */
    let waitsBy = false
    const empty = d.hands[0] === null && d.hands[1] === null
    if (empty || d.hands[0] === null || d.hands[1] === null) {
      // Empty-handed it looks far; with one hand full, only near.
      let best = empty ? 22 : 8
      // One not ready, or not yet open to it (its asker's first seconds), it waits by.
      for (const c of sim.crates.values()) {
        if (c.state === 'arriving') continue
        const dist = len(sub(c.p, d.pos))
        if (dist < best) {
          best = dist
          goal = c.p
          goalIsPickup = sim.mayOpen(c, d)
          waitsBy = !goalIsPickup
        }
      }
      for (const th of sim.things.values()) {
        if (th.holder || !th.body) continue
        const p = th.body.translation()
        const dist = len(sub([p.x, p.y, p.z], d.pos))
        if (dist < best) {
          best = dist
          goal = [p.x, p.y, p.z]
          goalIsPickup = true
          waitsBy = false
        }
      }
    }
    if (t > this.retarget || !this.target || !sim.doctors.get(this.target)?.alive) {
      this.retarget = t + 4 + this.random() * 4
      let best = Infinity
      this.target = null
      for (const o of sim.doctors.values()) {
        if (o === d || !o.alive) continue
        const dist = len(sub(o.pos, d.pos)) * (0.7 + this.random() * 0.6)
        if (dist < best) {
          best = dist
          this.target = o.id
        }
      }
    }
    const foe = this.target ? (sim.doctors.get(this.target) ?? null) : null
    const foeDist = foe ? len(sub(foe.pos, d.pos)) : Infinity
    let fight = foe !== null && (goal === null || foeDist < 4)
    if (fight && foe) goal = foe.pos
    // Going round something: a point on the way, for a moment.
    if (this.detour && t < this.detourUntil && goal) {
      goal = this.detour
      goalIsPickup = false
      waitsBy = false
      fight = false
    }

    let yaw = d.yaw
    let pitch = 0
    let move: [number, number] = [0, 0]
    if (goal) {
      const to = sub(goal, d.pos)
      const flat = Math.hypot(to[0], to[2])
      yaw = Math.atan2(to[0], to[2]) + (fight ? Math.sin(t * 1.7 + this.id.length) * 0.05 : 0)
      const aimAt = fight && foe ? foe.pos[1] + EYE * 0.75 * foe.size : goal[1]
      pitch = Math.atan2(aimAt - (d.pos[1] + EYE * d.size), Math.max(0.5, flat)) + (fight ? Math.cos(t * 2.3) * 0.03 : 0)
      if (fight) {
        // Its way to the foe, drawn anew every few seconds: nearly straight in, at a slant, round
        // them, or (with something in hand, within 8 m) a step back. At its distance it goes round
        // them on the way's side, backing off if the way does.
        const armed = d.hands[0] !== null || d.hands[1] !== null
        const keep = armed ? 5 : 0.9
        if (t > this.wayUntil) {
          this.wayUntil = t + 1.2 + this.random() * 2.3
          const r = this.random()
          this.way = (this.random() < 0.5 ? -1 : 1) * (r < 0.25 ? 0.3 : r < 0.6 ? 0.8 : r < 0.85 || !armed ? 1.4 : 2.5)
        }
        const way = flat > keep + 3 && Math.abs(this.way) > 2 ? Math.sign(this.way) * 1.4 : this.way
        move = flat > keep ? [Math.sin(way), Math.cos(way)] : [Math.sign(way) * 0.8, Math.min(0, Math.cos(way))]
      } else if (flat > (waitsBy ? 1.4 : 0.6)) move = [0, 1]
      if (goalIsPickup && flat < 2) press('pick')
      if (to[1] > 1.2 && flat < 4 && d.grounded) press('jump')
    }

    // Keep off edges, unless what it goes for is below: with no floor a metre and a half along its
    // way, it takes the way's mirror or a step to either side, else stands and finds a way round.
    if ((move[0] !== 0 || move[1] !== 0) && !(goal && goal[1] < d.pos[1] - 1)) {
      const fwd = aimOf(yaw, 0)
      // The sim's right of a yaw is (-forward z, forward x).
      const floorAlong = ([x, z]: [number, number]) => {
        const k = 1.5 / Math.hypot(x, z)
        return sim.groundBelow([d.pos[0] + (fwd[0] * z - fwd[2] * x) * k, d.pos[1] + 1, d.pos[2] + (fwd[2] * z + fwd[0] * x) * k], 4.5) !== null
      }
      const side = move[0] || 0.8
      const ok = ([move, [-move[0], move[1]], [side, 0], [-side, 0]] as [number, number][]).find(floorAlong)
      if (!ok && goal && !(this.detour && t < this.detourUntil)) this.findDetour(sim, d, goal)
      move = ok ?? [0, 0]
    }

    // Stuck: jump, and step aside for a moment.
    if (len(sub(d.pos, this.lastPos)) > 0.6) {
      this.lastPos = [...d.pos]
      this.stuckSince = t
    } else if ((move[0] !== 0 || move[1] !== 0) && t - this.stuckSince > 1.2) {
      press('jump')
      this.stuckSince = t
      if (goal) this.findDetour(sim, d, goal)
    }

    const down: [boolean, boolean] = [false, false]
    if (fight && foe) {
      // A thing that has taken all it may from this foe is thrown away, to free the hand.
      for (const h of [0, 1] as const) {
        const held = sim.inHand(d, h)
        if (held && sim.dealt(held, foe.id) >= held.kind.budget) pressHand('throw', h)
      }
      const ready = ([0, 1] as const).filter((h) => {
        const held = sim.inHand(d, h)
        return held && sim.dealt(held, foe.id) < held.kind.budget
      })
      if (ready.length) {
        const h = ready[Math.floor(this.random() * ready.length)]!
        const sees = this.sees(sim, d, foe)
        if (sees && foeDist < SIGHT && t > this.nextUse) {
          pressHand('use', h)
          drawAim()
          this.holding = h
          this.nextUse = t + 0.4 + this.random() * 0.9
          this.holdUntil = t + (this.random() < 0.3 ? 1 : 0)
        }
        if (t < this.holdUntil) down[this.holding] = true
        if (t > this.nextThrow && foeDist < 9 && sees) {
          if (this.nextThrow > 0 && this.random() < 0.15) {
            pressHand('throw', h)
            drawAim()
          }
          this.nextThrow = t + 8 + this.random() * 10
        }
      } else if (foeDist < 1.6 && t > this.nextUse) {
        pressHand('use', d.hands[0] === null ? 0 : 1)
        this.nextUse = t + 0.5 + this.random() * 0.5
      }
    }
    // The spread goes on the aim when it is sent, so a use goes off with the error drawn for it.
    return { move, yaw: yaw + (fight ? this.off[0] : 0), pitch: pitch + (fight ? this.off[1] : 0), jump: false, hands: down, presses: this.presses }
  }

  /** A point five metres off with a floor and a clear way to it, nearest the goal. */
  private findDetour(sim: Sim, d: Doctor, goal: Vec3): void {
    let best: Vec3 | null = null
    let bestDist = Infinity
    const start = this.random() * Math.PI * 2
    for (let k = 0; k < 12; k++) {
      const ang = start + (k / 12) * Math.PI * 2
      const p: Vec3 = [d.pos[0] + Math.sin(ang) * 5, d.pos[1], d.pos[2] + Math.cos(ang) * 5]
      const ground = sim.groundBelow([p[0], p[1] + 1.2, p[2]], 3)
      if (!ground || !sim.clear([d.pos[0], d.pos[1] + 0.6, d.pos[2]], [p[0], ground.y + 0.6, p[2]])) continue
      const dist = len(sub(goal, p))
      if (dist < bestDist) {
        bestDist = dist
        best = [p[0], ground.y, p[2]]
      }
    }
    this.detour = best
    this.detourUntil = sim.time + 2.2
  }

  private sees(sim: Sim, d: Doctor, foe: Doctor): boolean {
    const eye = sim.eyeOf(d)
    const to = sub(sim.eyeOf(foe), eye)
    return sim.rayToDoctor(eye, to, len(to) + 0.5, d) === foe.id
  }
}
