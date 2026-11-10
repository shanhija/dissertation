/**
 * What made code shows that is not a body: sights (any model it built, swelling, turning,
 * drifting, fading, following a doctor, a body or a thing, lighting what is near) and ties (ropes
 * and springs between two ends). A sight is animated here from the event that made it, on the
 * page's own clock, so it moves smoothly; code that steers it sends what it set, which holds from
 * then on. A tie is drawn every frame from the snapshot, between where its ends are drawn.
 */

import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  Quaternion,
  Vector3,
  type MeshStandardMaterial,
  type Object3D,
} from 'three'

import type { Follow, GameEvent, Recipe, TieEnd, TieSnap, Vec3 } from '../protocol'
import { GLOW, ModelInstance, solidMaterial } from './models'
import { lighting } from '../lighting'
import { PAINT_MODEL, paint } from './paint'

type ShowEvent = Extract<GameEvent, { type: 'show' }>
type ReshowEvent = Extract<GameEvent, { type: 'reshow' }>

/** Finds what a sight or a tie goes with, as drawn now. */
export type Resolve = (f: Follow) => Object3D | null

const v = new Vector3()
const q = new Quaternion()
const e = new Euler()
const wp = new Vector3()
const wq = new Quaternion()

interface Live {
  ev: ShowEvent
  inst: ModelInstance
  solid: MeshStandardMaterial
  glow: MeshBasicMaterial
  /** Page seconds it began; where it is and when that was set; its turn and when that was set. */
  t0: number
  at: Vec3
  tAt: number
  turn: Quaternion
  tTurn: number
  /** Set by code: holds instead of growing. */
  size: Vec3 | null
  opacity: number
  /** Half its model's diagonal, metres at scale 1. */
  radius: number
  /** Where it was last drawn, in the world (kept when what it followed is gone). */
  last: { p: Vector3; q: Quaternion } | null
  drawnSize: number
  drawnOpacity: number
}

export class Sights {
  readonly layer = new Group()
  private readonly live = new Map<string, Live>()
  private readonly lamps: PointLight[] = []

  /** lamps: whether lit sights may light what is near them. */
  constructor(parent: Object3D, lamps: boolean) {
    parent.add(this.layer)
    for (let i = 0; i < (lamps ? 2 : 0); i++) {
      const light = new PointLight('#ffffff', 0, 10, 2)
      this.layer.add(light)
      this.lamps.push(light)
    }
  }

  show(ev: ShowEvent, recipe: Recipe, now: number): void {
    this.drop(ev.id)
    // A copy of the models' painted material, to fade on its own (a copy keeps nothing of how it was painted).
    const solid = paint(solidMaterial().clone(), PAINT_MODEL)
    solid.transparent = true
    const glow = (GLOW as MeshBasicMaterial).clone()
    glow.transparent = true
    glow.blending = AdditiveBlending
    glow.depthWrite = false
    const inst = new ModelInstance(recipe, solid, glow)
    this.layer.add(inst.root)
    const b = recipe.bounds
    const radius = Math.max(0.05, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2)
    this.live.set(ev.id, {
      ev,
      inst,
      solid,
      glow,
      t0: now,
      at: [...ev.at],
      tAt: now,
      turn: new Quaternion(...ev.q),
      tTurn: now,
      size: null,
      opacity: ev.opacity,
      radius,
      last: null,
      drawnSize: 1,
      drawnOpacity: 1,
    })
  }

  reshow(ev: ReshowEvent, now: number): void {
    const s = this.live.get(ev.id)
    if (!s) return
    if (ev.gone) return this.drop(ev.id)
    if (ev.at) {
      s.at = [...ev.at]
      s.tAt = now
    }
    if (ev.q) {
      s.turn.set(...ev.q)
      s.tTurn = now
    }
    if (ev.scale) s.size = [...ev.scale]
    if (ev.opacity !== undefined) s.opacity = ev.opacity
    if (ev.poses) s.inst.pose(ev.poses)
  }

  private drop(id: string): void {
    const s = this.live.get(id)
    if (!s) return
    s.inst.dispose()
    s.solid.dispose()
    s.glow.dispose()
    this.live.delete(id)
  }

  /** Every frame, after everything they may follow has been placed. */
  update(now: number, resolve: Resolve, eye: Vector3): void {
    const lit: { p: Vector3; color: string; power: number; reach: number; d: number }[] = []
    for (const [id, s] of this.live) {
      const ev = s.ev
      const age = now - s.t0
      if (age > ev.secs) {
        this.drop(id)
        continue
      }
      const k = age / ev.secs
      const ease = 1 - (1 - k) * (1 - k)
      const size: Vec3 = s.size ?? (ev.grow ? [0, 1, 2].map((i) => ev.scale[i]! + (ev.grow![i]! - ev.scale[i]!) * ease) as Vec3 : ev.scale)
      const ta = now - s.tAt
      v.set(s.at[0] + ev.vel[0] * ta, s.at[1] + ev.vel[1] * ta, s.at[2] + ev.vel[2] * ta)
      const tt = now - s.tTurn
      q.copy(s.turn).multiply(new Quaternion().setFromEuler(e.set(ev.spin[0] * tt, ev.spin[1] * tt, ev.spin[2] * tt)))
      const target = ev.follow ? resolve(ev.follow) : null
      const root = s.inst.root
      if (target) {
        target.updateWorldMatrix(true, false)
        target.getWorldPosition(wp)
        target.getWorldQuaternion(wq)
        root.position.copy(v.applyQuaternion(wq)).add(wp)
        root.quaternion.copy(wq).multiply(q)
        s.last = { p: root.position.clone(), q: root.quaternion.clone() }
      } else if (ev.follow && s.last) {
        // What it followed is gone: it stays where it was last seen.
        root.position.copy(s.last.p)
        root.quaternion.copy(s.last.q)
      } else {
        root.position.copy(v)
        root.quaternion.copy(q)
      }
      root.scale.set(size[0], size[1], size[2])
      const fade = ev.fade > 0 ? Math.min(1, (1 - k) / ev.fade) : 1
      const opacity = Math.max(0, s.opacity * fade)
      s.solid.opacity = opacity
      s.solid.depthWrite = opacity > 0.98
      s.glow.opacity = opacity
      s.glow.color.copy((GLOW as MeshBasicMaterial).color)
      for (const m of s.inst.meshes) if (m.material === s.solid) m.castShadow = opacity > 0.9
      root.visible = opacity > 0.003
      s.drawnSize = Math.max(size[0], size[1], size[2])
      s.drawnOpacity = opacity
      if (ev.light && opacity > 0.01) {
        const r = Math.min(8, s.radius * s.drawnSize)
        lit.push({ p: root.position, color: ev.light, power: 8 * Math.max(0.6, r) ** 2 * opacity, reach: 3 + r * 4, d: root.position.distanceTo(eye) })
      }
    }
    // The few lamps go to the lit sights nearest the eye.
    lit.sort((a, b) => a.d - b.d)
    this.lamps.forEach((lamp, i) => {
      const l = lit[i]
      if (!l) {
        lamp.intensity = 0
        return
      }
      lamp.position.copy(l.p)
      lamp.color.set(l.color)
      lamp.intensity = l.power * lighting().effectLight
      lamp.distance = l.reach
    })
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) this.drop(id)
    this.layer.removeFromParent()
  }
}

// ------------------------------------------------------------------------------ ties

const SEG = new CylinderGeometry(0.5, 0.5, 1, 6)
const SEGMENTS = 36
const yAxis = new Vector3(0, 1, 0)

interface TieView {
  group: Group
  meshes: Mesh[]
  material: MeshBasicMaterial | null
  color: string
}

export class Ties {
  readonly layer = new Group()
  private readonly views = new Map<string, TieView>()
  private readonly pts = Array.from({ length: SEGMENTS + 1 }, () => new Vector3())

  constructor(parent: Object3D) {
    parent.add(this.layer)
  }

  /** Draws the ties a snapshot has, between their ends as drawn now. */
  update(ties: TieSnap[], end: (e: TieEnd) => Vector3 | null): void {
    const seen = new Set<string>()
    for (const t of ties) {
      if (!t.color) continue
      const a = end(t.a)
      const b = end(t.b)
      if (!a || !b) continue
      seen.add(t.id)
      let view = this.views.get(t.id)
      if (!view || view.color !== t.color) {
        if (view) this.drop(t.id)
        const material = new MeshBasicMaterial({ color: new Color(t.color) })
        const group = new Group()
        const meshes = Array.from({ length: SEGMENTS }, () => {
          const m = new Mesh(SEG, material)
          m.castShadow = true
          group.add(m)
          return m
        })
        this.layer.add(group)
        view = { group, meshes, material, color: t.color }
        this.views.set(t.id, view)
      }
      this.lay(view, a, b, t)
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.drop(id)
  }

  private lay(view: TieView, a: Vector3, b: Vector3, t: TieSnap): void {
    const dist = a.distanceTo(b)
    const dir = b.clone().sub(a)
    const n = dist > 1e-4 ? dir.clone().divideScalar(dist) : new Vector3(0, 0, 1)
    const side = new Vector3().crossVectors(n, Math.abs(n.y) < 0.95 ? yAxis : new Vector3(1, 0, 0)).normalize()
    const up = new Vector3().crossVectors(side, n)
    // A slack rope sags (a parabola as long as the rope); a spring coils round its line.
    const sag = !t.spring && dist < t.length ? Math.min(t.length / 2, Math.sqrt((3 * dist * (t.length - dist)) / 8)) : 0
    const coil = t.spring ? Math.max(0.05, t.width * 3) : 0
    const turns = Math.max(3, Math.min(10, Math.round(dist * 2)))
    for (let i = 0; i <= SEGMENTS; i++) {
      const k = i / SEGMENTS
      const p = this.pts[i]!.copy(a).addScaledVector(dir, k)
      p.y -= 4 * sag * k * (1 - k)
      if (coil && i > 0 && i < SEGMENTS) {
        const th = k * turns * Math.PI * 2
        p.addScaledVector(side, Math.cos(th) * coil).addScaledVector(up, Math.sin(th) * coil)
      }
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const p = this.pts[i]!
      const r = this.pts[i + 1]!
      const m = view.meshes[i]!
      m.position.copy(p).add(r).multiplyScalar(0.5)
      const d = r.clone().sub(p)
      const l = d.length()
      m.scale.set(t.width * 2, l + t.width, t.width * 2)
      if (l > 1e-6) m.quaternion.setFromUnitVectors(yAxis, d.divideScalar(l))
    }
  }

  private drop(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    view.group.removeFromParent()
    view.material?.dispose()
    this.views.delete(id)
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.drop(id)
    this.layer.removeFromParent()
  }
}
