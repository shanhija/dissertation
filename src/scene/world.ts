/**
 * The round as drawn, kept by hand in three.js and synced from the snapshots every frame: the
 * arena (solids, movers, decorations, sky), the doctors, the things, the bodies, the crates and
 * the effects. Everything but the player's own doctor is drawn a little in the past, between two
 * snapshots, so it moves smoothly; the player's own doctor follows the newest snapshot closely,
 * so the view answers the keys. The camera is the player's eyes (or, out of the round, follows
 * someone still in).
 */

import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  AdditiveBlending,
  DirectionalLight,
  EdgesGeometry,
  Euler,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  Matrix4,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PMREMGenerator,
  Plane,
  Quaternion,
  Sphere,
  SphereGeometry,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import type { Shadows } from '../options'
import type { Net } from '../net'
import type { ArenaView, BodySnap, CrateSnap, DoctorSnap, Follow, GameEvent, MoverSnap, Prim, Quat, Snap, ThingSnap, TieEnd, Vec3 } from '../protocol'
import { setListener, setOccluder, setRoom } from '../audio'
import { bodyFall, cry, footstep, impact, landing, play, shatter, speak } from '../sounds'
import { ArenaScene } from './arena'
import { DoctorMesh, Label } from './doctor'
import { Effects, Trail } from './effects'
import { boxUV, prepared, surface, surfaceMaps } from './materials'
import { GLOW, GLOW_BASE, ModelInstance } from './models'
import { PAINT_MODEL, harmonizedHex, paint } from './paint'
import { hearingOf } from './hearing'
import { Portraits } from './portrait'
import { Sights, Ties } from './sights'
import { lighting } from '../lighting'
import { LABEL_FONT } from '../fonts'

/** How far in the past others are drawn, seconds. */
const DELAY = 0.05
const EYE = 1.55

const BOX = new BoxGeometry(1, 1, 1)
/** The dust a broken piece of the arena raises, toward which its own colour is mixed. */
const DUST = new Color('#b8ab94')
const BALL = new SphereGeometry(0.5, 20, 14)
const CYL = new CylinderGeometry(0.5, 0.5, 1, 20)
const CAPSULE = new CapsuleGeometry(0.5, 1, 6, 14)
const CRATE = new BoxGeometry(0.9, 0.9, 0.9).toNonIndexed()
boxUV(CRATE, 0.45)
const BRACKET = new BoxGeometry(0.94, 0.08, 0.94)
/** A crate coming in, as a drawing in light: its edges and its brackets'. */
const CRATE_LINES = (() => {
  const box = new EdgesGeometry(new BoxGeometry(0.9, 0.9, 0.9))
  const band = new EdgesGeometry(BRACKET)
  const pts = [...box.getAttribute('position').array]
  for (const y of [-0.4, 0, 0.4]) {
    const b = band.getAttribute('position').array
    for (let i = 0; i < b.length; i += 3) pts.push(b[i]!, b[i + 1]! * (y === 0 ? 1 : 0.6) + y, b[i + 2]!)
  }
  // The planks' seams on each face.
  for (const f of [-1, 1]) {
    for (const t of [-0.15, 0.15]) {
      pts.push(t, -0.45, f * 0.451, t, 0.45, f * 0.451)
      pts.push(f * 0.451, -0.45, t, f * 0.451, 0.45, t)
    }
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3))
})()
/** The sheet of light where a crate coming in turns solid. */
const SCAN = new BoxGeometry(0.98, 0.012, 0.98)
const COG = new ConeGeometry(0.25, 0.35, 6)

/** A crate as drawn: solid below `cut` (it comes in from the bottom up), a drawing in light above. */
interface CrateDrawn {
  group: Group
  cog: Mesh
  box: Mesh
  label: Label
  state: string
  cut: Plane
  /** The other side of the cut: what is still a drawing. */
  above: Plane
  wire: LineSegments
  fill: Mesh
  scan: Mesh
  mats: Material[]
}

const solidMats = new Map<string, MeshStandardMaterial>()
function solidMat(color: string): MeshStandardMaterial {
  let m = solidMats.get(color)
  if (!m) {
    m = paint(new MeshStandardMaterial({ color: harmonizedHex(color), roughness: 0.7 }), PAINT_MODEL)
    solidMats.set(color, m)
  }
  return m
}
const glowMats = new Map<string, MeshBasicMaterial>()
function glowMat(color: string): MeshBasicMaterial {
  let m = glowMats.get(color)
  if (!m) {
    m = new MeshBasicMaterial({ color: harmonizedHex(color, true) })
    glowMats.set(color, m)
  }
  return m
}

const UP = new Vector3(0, 1, 0)
/** A thing before the eyes is turned to face away from them. */
const VIEW_TURN = new Euler(0, Math.PI, 0)
const WARM_SUN = new Color('#ffb066')
const COLD_SUN = new Color('#a8c4ff')
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const lerpV = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
/** 0 below a, 1 above b, smoothly between. */
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const angleLerp = (a: number, b: number, k: number) => {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * k
}
const qa = new Quaternion()
const qb = new Quaternion()
const slerpQ = (a: Quat, b: Quat, k: number): Quaternion => qa.set(a[0], a[1], a[2], a[3]).slerp(qb.set(b[0], b[1], b[2], b[3]), k)

interface DoctorView {
  mesh: DoctorMesh
  /** Where it was drawn last frame, and how fast it has been moving (smoothed), for the gait. */
  last: Vec3
  vel: Vec3
  disguise: ModelInstance | null
  /** Models effects put on them, by model id. */
  wear: Map<string, ModelInstance>
  /** What of its movement has been sounded: footfalls, landings, jumps (the mesh counts them). */
  heard: { steps: number; lands: number; jumps: number }
  /** Lying as a ragdoll: where its pelvis was last frame and how fast it went, to hear it hit the ground. */
  ragWas: Vec3 | null
  ragSpeed: number
  thumpAt: number
  /** When it last cried out. */
  cryAt: number
}

interface BodyView {
  obj: Group
  key: string
  inst: ModelInstance | null
  /** A geometry of its own (rubble, in an arena surface), to let go of with it. */
  own: BufferGeometry | null
  /** Half its drawn size at scale 1, for its trail. */
  radius: number
  trail: Trail | null
}

export interface Camera {
  yaw: number
  pitch: number
}

export class World {
  readonly root = new Group()
  private arena: ArenaScene | null = null
  /** The arena as the server last sent it: sent again (a page that reconnects), it is drawn again, with whatever broke meanwhile. */
  private arenaView: ArenaView | null = null
  private readonly doctors = new Map<string, DoctorView>()
  private readonly things = new Map<string, { inst: ModelInstance; kind: string }>()
  private readonly bodies = new Map<string, BodyView>()
  private readonly crates = new Map<string, CrateDrawn>()
  private readonly fx: Effects
  private readonly sights: Sights
  private readonly ties: Ties
  private readonly portraits: Portraits
  private readonly drawSize = new Vector2()
  /** How long each kind of thing is, along its front: a long one is held in both hands. */
  private readonly lengths = new Map<string, number>()
  /** Where the camera looks from while the player's own doctor lies as a ragdoll. */
  private downCam: Vector3 | null = null
  private readonly hemi = new HemisphereLight('#ffffff', '#444444', 0.9)
  private readonly sun = new DirectionalLight('#ffffff', 2.6)
  /** The things in one's own hands, as drawn before the eyes: the left hand's, then the right's. */
  private readonly viewModels: ({ inst: ModelInstance; kind: string; id: string } | null)[] = [null, null]
  private ownPos: Vec3 | null = null
  private offset: number | null = null
  /** Who the camera follows while the player is out. */
  watching: string | null = null
  /** The player's own doctor as last drawn, for the HUD. */
  own: DoctorSnap | null = null
  private unsub: (() => void)[] = []

  constructor(
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly net: Net,
    private readonly gl: WebGLRenderer,
    private readonly look: { lamps: boolean; dust: boolean; shadows: Shadows },
  ) {
    scene.add(this.root, this.hemi, this.sun, this.sun.target, camera)
    this.fx = new Effects(this.root, look.lamps)
    this.sights = new Sights(this.root, look.lamps)
    this.ties = new Ties(this.root)
    this.portraits = new Portraits(gl)
    // Crates coming in are cut off above a rising plane.
    gl.localClippingEnabled = true
    // A soft room of light all round: what shiny surfaces (marble, brass, glass) reflect, and the shade's fill.
    const pmrem = new PMREMGenerator(gl)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.55
    pmrem.dispose()
    this.sun.castShadow = look.shadows !== 'off'
    const map = look.shadows === 'fine' ? 4096 : 2048
    this.sun.shadow.mapSize.set(map, map)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    this.unsub.push(net.onEvent((e, snap) => this.event(e, snap.t)))
    this.unsub.push(
      net.onTaunt((t) => {
        const d = this.doctors.get(t.by)
        // The voice follows the doctor, at the height it was said from.
        const from = d && t.at ? ([t.at[0] - d.last[0], t.at[1] - d.last[1], t.at[2] - d.last[2]] as Vec3) : null
        const heard = speak(t.voice, t.at, this.ear(), () => {
          const now = this.doctors.get(t.by)
          return now && from ? [now.last[0] + from[0], now.last[1] + from[1], now.last[2] + from[2]] : null
        })
        d?.mesh.gesture('taunt', performance.now() / 1000)
        if (heard && d) d.mesh.say(t.text, performance.now() / 1000 + 5)
      }),
    )
  }

  dispose(): void {
    for (const u of this.unsub) u()
    this.root.removeFromParent()
    this.hemi.removeFromParent()
    this.sun.removeFromParent()
    this.arena?.dispose()
    this.fx.dispose()
    this.sights.dispose()
    this.ties.dispose()
    this.portraits.dispose()
    this.scene.environment?.dispose()
    this.scene.environment = null
    for (const d of this.doctors.values()) {
      d.mesh.dispose()
      for (const w of d.wear.values()) w.dispose()
    }
    for (const vm of this.viewModels) vm?.inst.dispose()
  }

  /** Where the player hears from: their eyes, or the camera. */
  ear(): Vec3 {
    const p = this.camera.position
    return [p.x, p.y, p.z]
  }

  // ---------------------------------------------------------------------------- the arena

  private buildArena(view: ArenaView): void {
    this.arena?.dispose()
    // The portraits are of the doctors here now, the match's leader first.
    const ranked = [...(this.net.lobby?.players ?? [])].sort((a, b) => b.wins - a.wins)
    this.arena = new ArenaScene(view, this.net.models, this.look.dust, (rank) => {
      const p = ranked[rank % Math.max(1, ranked.length)]
      return p ? { picture: this.portraits.of(p.look, this.net.wardrobe), name: `Dr ${p.name}` } : null
    })
    for (const id of view.broken) this.arena.breakPiece(id)
    this.root.add(this.arena.root)
    this.arenaView = view
    this.scene.background = this.arena.horizon
    // How it sounds: its echo, and what walls stand between a sound and the ear.
    const hearing = hearingOf(view, this.arena.bounds)
    setRoom(hearing.room)
    setOccluder(hearing.occluded)
    this.scene.fog = new FogExp2(this.arena.horizon, 0.0022 + view.sky.fog * 0.016)
    this.hemi.color.set(view.sky.color).lerp(new Color('#ffffff'), 0.7)
    this.hemi.groundColor.set(view.sky.ground)
    this.sun.color.set(view.sky.light)
    // The sun's shadows cover the arena, no more, so they stay sharp.
    const b = this.arena.bounds
    const center = b.getCenter(new Vector3())
    const size = b.getSize(new Vector3())
    const reach = Math.max(size.x, size.z) / 2 + 4
    this.sunCentre.copy(center)
    this.sunBase.set(view.sky.light)
    this.sun.position.copy(center).addScaledVector(this.arena.sunDir, 160)
    this.sun.target.position.copy(center)
    const c = this.sun.shadow.camera
    c.left = c.bottom = -reach
    c.right = c.top = reach
    c.near = 1
    c.far = 320
    c.updateProjectionMatrix()
  }

  // ---------------------------------------------------------------------------- events

  /** Sights made or steered, waiting until the drawing reaches the snapshot they came in (bodies are drawn a little in the past). */
  private readonly sightEvents: { e: GameEvent; t: number }[] = []

  private event(e: GameEvent, t: number): void {
    const now = performance.now() / 1000
    const ear = this.ear()
    switch (e.type) {
      case 'burst':
        this.fx.burst(e.at, e.color, e.size, e.count, e.glow, now, e)
        break
      case 'show':
      case 'reshow':
        this.sightEvents.push({ e, t })
        break
      case 'beam':
        this.fx.beam(e.from, e.to, e.color, e.width, e.secs, e.jag ?? 0, now)
        break
      case 'puff':
        this.fx.puff(e.at, e.color, e.size, e.secs, e.rise, e.glow, now)
        break
      case 'shake': {
        // Felt within a few metres for a small shake, across the arena for the biggest.
        const d = Math.hypot(e.at[0] - ear[0], e.at[1] - ear[1], e.at[2] - ear[2])
        const reach = 5 + 25 * e.strength
        if (d < reach) this.shake = Math.min(1, this.shake + e.strength * (1 - d / reach))
        break
      }
      case 'text':
        this.fx.floatText(e.at, e.text, e.color, now)
        break
      case 'sound':
        play(e.sound, e.pitch, e.at, e.volume ?? 1)
        break
      case 'impact':
        impact(e.at, e.on, e.speed, e.mass)
        break
      case 'break':
        // Gone from the drawing at once; its rubble comes with the bodies, a moment later.
        this.arena?.breakPiece(e.piece)
        if (e.fell) break
        shatter(e.at, e.material, e.size)
        this.fx.puff(e.at, `#${new Color(e.color).lerp(DUST, 0.6).getHexString()}`, Math.min(6, 1.2 + e.size * 1.4), 1.8, 0.3, false, now)
        this.fx.burst(e.at, e.color, Math.min(1.4, 0.35 + e.size * 0.25), Math.min(60, 14 + Math.round(e.size * 14)), false, now)
        break
      case 'hit': {
        this.fx.floatText(e.at, `-${e.amount}`, '#ff5a4a', now)
        const own = e.victim === this.net.you
        // A cry from whoever is hurt (not every blow of a flurry), in their own voice.
        const v = this.doctors.get(e.victim)
        if (v && now - v.cryAt > 0.45) {
          v.cryAt = now
          cry(e.victim, own ? null : e.at, 'hurt')
        }
        if (own) {
          play('hit-flesh', 1, null, 0.7)
          this.shake = Math.min(0.6, this.shake + e.amount / 25)
        }
        break
      }
      case 'out':
        cry(e.victim, e.victim === this.net.you ? null : (this.doctors.get(e.victim)?.last ?? null), 'out')
        if (e.victim === this.net.you) {
          play('out', 0.8, null, 0.6)
          this.watching = e.by
        }
        break
      case 'act':
        this.doctors.get(e.who)?.mesh.gesture(e.act, now, e.hand)
        break
      case 'opened':
        play('crate', 1)
        break
      default:
        break
    }
  }

  private readonly sunCentre = new Vector3()
  private readonly sunBase = new Color('#ffffff')

  /** The lighting tab's light, as it is now: the camera's exposure, the sky's and the room's light, the sun, the lamps, glowing shapes. */
  private applyLighting(): void {
    const l = lighting()
    this.gl.toneMappingExposure = l.exposure
    this.hemi.intensity = l.ambient
    this.scene.environmentIntensity = l.reflections
    this.sun.intensity = l.sun
    const w = l.sunWarmth
    this.sun.color.copy(this.sunBase).lerp(w >= 0 ? WARM_SUN : COLD_SUN, Math.abs(w) * 0.6)
    const h = (l.sunHeight * Math.PI) / 180
    const t = (l.sunTurn * Math.PI) / 180
    this.sun.position.copy(this.sunCentre).add(new Vector3(Math.cos(h) * Math.cos(t), Math.sin(h), Math.cos(h) * Math.sin(t)).multiplyScalar(160))
    for (const lamp of this.arena?.lamps ?? []) {
      lamp.light.intensity = lamp.power * l.lamps
      lamp.light.distance = lamp.range * l.lampReach
    }
    ;(GLOW as MeshBasicMaterial).color.setScalar(GLOW_BASE * l.glow)
  }

  /** Camera shake left, from being hit or from something going off nearby. */
  shake = 0

  // ---------------------------------------------------------------------------- every frame

  /** How long a kind of thing is along its front (z), from its model. */
  private lengthOf(kind: string): number {
    let l = this.lengths.get(kind)
    if (l === undefined) {
      const r = this.net.models.get(`thing:${kind}`)
      l = r ? r.bounds.max[2] - r.bounds.min[2] : 0.3
      this.lengths.set(kind, l)
    }
    return l
  }

  /** Two snapshots around the time drawn, how far between them, and the time drawn (server seconds). */
  private bracket(): { a: Snap; b: Snap; k: number; t: number } | null {
    const snaps = this.net.snaps
    if (snaps.length === 0) return null
    for (const s of snaps.slice(-10)) {
      const o = s.snap.t * 1000 - s.at
      this.offset = this.offset === null ? o : Math.max(this.offset - 0.05, o)
    }
    const t = (performance.now() + this.offset!) / 1000 - DELAY
    for (let i = snaps.length - 1; i > 0; i--) {
      const a = snaps[i - 1]!.snap
      const b = snaps[i]!.snap
      if (a.t <= t && t <= b.t) return { a, b, k: b.t > a.t ? (t - a.t) / (b.t - a.t) : 1, t }
    }
    const last = snaps.at(-1)!.snap
    return { a: last, b: last, k: 1, t: Math.max(t, last.t) }
  }

  update(cam: Camera, dt: number): void {
    const view = this.net.arena
    if (view && view !== this.arenaView) this.buildArena(view)
    this.applyLighting()
    const now = performance.now() / 1000
    const br = this.bracket()
    this.fx.update(now, this.gl.getDrawingBufferSize(this.drawSize).y, this.camera.fov)
    this.arena?.update(dt, now, this.camera.position)
    if (!br) return
    const { a, b, k } = br
    // Sights come in when the drawing reaches them.
    while (this.sightEvents.length && this.sightEvents[0]!.t <= br.t + 1e-6) {
      const { e } = this.sightEvents.shift()!
      if (e.type === 'show') {
        const recipe = this.net.models.get(e.model)
        if (recipe) this.sights.show(e, recipe, now)
      } else if (e.type === 'reshow') this.sights.reshow(e, now)
    }
    const newest = this.net.latest()!.snap
    const you = this.net.you

    // Movers.
    const moversA = new Map(a.movers.map((m) => [m.id, m]))
    for (const m of b.movers) this.placeMover(m, moversA.get(m.id) ?? m, k)

    // Doctors.
    const docsA = new Map(a.doctors.map((d) => [d.id, d]))
    const seen = new Set<string>()
    for (const db of b.doctors) {
      seen.add(db.id)
      const da = docsA.get(db.id) ?? db
      const own = db.id === you
      let p = lerpV(da.p, db.p, k)
      if (own) {
        const n = newest.doctors.find((d) => d.id === you) ?? db
        this.own = n
        this.ownPos = this.ownPos ? lerpV(this.ownPos, n.p, 1 - Math.exp(-dt * 30)) : n.p
        p = this.ownPos
      }
      const length = (id: string | null) => {
        const t = id && id !== db.riding ? b.things.find((x) => x.id === id) : undefined
        return t ? this.lengthOf(t.kind) : null
      }
      this.placeDoctor(db, da, p, k, dt, now, own, [length(db.hands[0]), length(db.hands[1])])
    }
    for (const [id, d] of this.doctors) {
      if (!seen.has(id)) {
        d.mesh.dispose()
        d.disguise?.dispose()
        for (const w of d.wear.values()) w.dispose()
        this.doctors.delete(id)
      }
    }

    // Things.
    const thingsA = new Map(a.things.map((t) => [t.id, t]))
    const thingSeen = new Set<string>()
    const ownSnap = this.own
    for (const tb of b.things) {
      // One's own things in hand are drawn before the eyes, except what one rides.
      const ownHeld = tb.holder === you && ownSnap?.alive && !ownSnap.rag && ownSnap.riding !== tb.id
      if (ownHeld) continue
      thingSeen.add(tb.id)
      // In someone's hand (not ridden): swaying with them.
      const by = tb.holder ? b.doctors.find((d) => d.id === tb.holder) : undefined
      const hand = by && by.riding !== tb.id && !by.rag ? by.hands.indexOf(tb.id) : -1
      const holderMesh = tb.holder ? this.doctors.get(tb.holder)?.mesh : undefined
      this.placeThing(tb, thingsA.get(tb.id) ?? tb, k, ownSnap && tb.holder === you && ownSnap.riding === tb.id ? ownSnap : null, hand >= 0 && holderMesh ? { sway: holderMesh.handSway[hand]!, yaw: holderMesh.root.rotation.y, size: by!.size } : null)
    }
    for (const [id, t] of this.things) {
      if (!thingSeen.has(id)) {
        t.inst.dispose()
        this.things.delete(id)
      }
    }

    // Bodies.
    const bodiesA = new Map(a.bodies.map((x) => [x.id, x]))
    const bodySeen = new Set<string>()
    for (const bb of b.bodies) {
      bodySeen.add(bb.id)
      this.placeBody(bb, bodiesA.get(bb.id) ?? bb, k)
    }
    for (const [id, x] of this.bodies) {
      if (!bodySeen.has(id)) {
        x.obj.removeFromParent()
        x.inst?.dispose()
        x.own?.dispose()
        if (x.trail) this.fx.leave(x.trail)
        this.bodies.delete(id)
      }
    }

    // Crates.
    const cratesA = new Map(a.crates.map((c) => [c.id, c]))
    const crateSeen = new Set<string>()
    for (const cb of b.crates) {
      crateSeen.add(cb.id)
      this.placeCrate(cb, cratesA.get(cb.id) ?? cb, k, now)
    }
    for (const [id, c] of this.crates) {
      if (!crateSeen.has(id)) {
        c.group.removeFromParent()
        c.label.dispose()
        for (const m of c.mats) m.dispose()
        this.crates.delete(id)
      }
    }

    this.placeCamera(cam, dt, now)
    // Sights and ties go with what is now placed, the camera too (a thing in one's own hand).
    this.camera.updateMatrixWorld()
    // The ear is the camera.
    const look = this.camera.getWorldDirection(new Vector3())
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.getWorldQuaternion(new Quaternion()))
    setListener([this.camera.position.x, this.camera.position.y, this.camera.position.z], [look.x, look.y, look.z], [up.x, up.y, up.z])
    this.sights.update(now, this.objectOf, this.camera.position)
    this.ties.update(b.ties ?? [], this.tieEnd)
  }

  /** What a sight or a tie goes with, as drawn: the player's own held thing is the one before their eyes. */
  private readonly objectOf = (f: Follow): Object3D | null => {
    if (f.kind === 'doctor') return this.doctors.get(f.id)?.mesh.root ?? null
    if (f.kind === 'body') return this.bodies.get(f.id)?.obj ?? null
    const vm = this.viewModels.find((v) => v?.id === f.id)
    if (vm) return vm.inst.root
    return this.things.get(f.id)?.inst.root ?? null
  }

  /** Where a tie's end is drawn: a doctor's chest, a body's or a thing's middle, or the point. */
  private readonly tieEnd = (e: TieEnd): Vector3 | null => {
    if (e.kind === 'point') return new Vector3(...e.p)
    if (e.kind === 'doctor') {
      const d = this.doctors.get(e.id)
      if (!d) return null
      d.mesh.spine.updateWorldMatrix(true, false)
      return d.mesh.spine.localToWorld(new Vector3(0, 0.3, 0))
    }
    const o = this.objectOf(e)
    if (!o) return null
    o.updateWorldMatrix(true, false)
    return o.getWorldPosition(new Vector3())
  }

  private placeMover(mb: MoverSnap, ma: MoverSnap, k: number): void {
    const g = this.arena?.movers.get(mb.id)
    if (!g) return
    g.position.set(...lerpV(ma.p, mb.p, k))
    g.quaternion.copy(slerpQ(ma.q, mb.q, k))
  }

  private placeDoctor(db: DoctorSnap, da: DoctorSnap, p: Vec3, k: number, dt: number, now: number, own: boolean, hands: [number | null, number | null]): void {
    const info = this.net.player(db.id)
    let v = this.doctors.get(db.id)
    if (!v) {
      v = { mesh: new DoctorMesh(), last: p, vel: [0, 0, 0], disguise: null, wear: new Map(), heard: { steps: 0, lands: 0, jumps: 0 }, ragWas: null, ragSpeed: 0, thumpAt: -10, cryAt: -10 }
      this.root.add(v.mesh.root)
      this.doctors.set(db.id, v)
    }
    if (info) v.mesh.dress(info.look, this.net.wardrobe, db.id)
    // How fast it moves, from where it is drawn: smoothed, and a jump to a new place (a respawn) is no speed.
    if (dt > 0) {
      const inst: Vec3 = [(p[0] - v.last[0]) / dt, (p[1] - v.last[1]) / dt, (p[2] - v.last[2]) / dt]
      if (Math.hypot(...inst) > 45) v.vel = [0, 0, 0]
      else {
        const a = 1 - Math.exp(-dt * 12)
        v.vel = [lerp(v.vel[0], inst[0], a), lerp(v.vel[1], inst[1], a), lerp(v.vel[2], inst[2], a)]
      }
    }
    v.last = p
    v.mesh.root.position.set(...p)
    // Knocked flat or dismissed: the game's ragdoll, drawn as it lies (between two snapshots); the
    // player's own doctor too, seen from behind while they are down.
    if (db.rag && !v.disguise) {
      const ra = da.rag ?? db.rag
      const at = lerpV(ra.p, db.rag.p, k)
      const q = db.rag.q.map((qb, i) => {
        const r = slerpQ(ra.q[i] ?? qb, qb, k)
        return [r.x, r.y, r.z, r.w] as [number, number, number, number]
      })
      v.mesh.ragPose(at, q, angleLerp(da.yaw, db.yaw, k), db.size, db.hurt, now)
      // Heard hitting the ground: a sudden loss of speed.
      if (v.ragWas && dt > 0) {
        const speed = Math.hypot(at[0] - v.ragWas[0], at[1] - v.ragWas[1], at[2] - v.ragWas[2]) / dt
        const drop = v.ragSpeed - speed
        if (drop > 3 && now - v.thumpAt > 0.15) {
          v.thumpAt = now
          bodyFall(at, drop / 8)
        }
        v.ragSpeed = lerp(v.ragSpeed, speed, 0.6)
      }
      v.ragWas = at
      v.mesh.root.visible = true
      v.mesh.tag.sprite.visible = db.alive && !own
      v.mesh.label(info?.name ?? '', info?.color ?? '#ffffff', db.cred)
      return
    }
    v.ragWas = null
    v.ragSpeed = 0
    v.mesh.root.visible = db.alive && !own
    v.mesh.label(info?.name ?? '', info?.color ?? '#ffffff', db.cred)
    // A disguise: the model instead of the doctor.
    const disguise = db.disguise ? this.net.models.get(db.disguise) : undefined
    if (disguise && v.disguise?.recipe !== disguise) {
      v.disguise?.dispose()
      v.disguise = new ModelInstance(disguise)
      this.root.add(v.disguise.root)
    } else if (!disguise && v.disguise) {
      v.disguise.dispose()
      v.disguise = null
    }
    if (v.disguise) {
      v.disguise.root.position.set(...p)
      v.disguise.root.rotation.set(0, angleLerp(da.yaw, db.yaw, k), 0)
      v.disguise.root.visible = db.alive && !own
    }
    v.mesh.showBody(!v.disguise)
    // What effects put on them, drawn round them (on the player's own doctor too: a net seen from inside).
    const wear = db.alive ? (db.fx?.wear ?? []) : []
    for (const [id, inst] of v.wear) {
      if (!wear.includes(id)) {
        inst.dispose()
        v.wear.delete(id)
      }
    }
    for (const id of wear) {
      let inst = v.wear.get(id)
      const recipe = this.net.models.get(id)
      if (!inst && recipe) {
        inst = new ModelInstance(recipe)
        this.root.add(inst.root)
        v.wear.set(id, inst)
      }
      if (!inst) continue
      inst.root.position.set(...p)
      inst.root.rotation.set(0, angleLerp(da.yaw, db.yaw, k), 0)
      inst.root.scale.setScalar(db.size)
    }
    v.mesh.pose(
      {
        yaw: angleLerp(da.yaw, db.yaw, k),
        pitch: lerp(da.pitch, db.pitch, k),
        vel: v.vel,
        grounded: db.grounded,
        hands,
        riding: db.riding !== null,
        writing: db.writing,
        held: db.fx?.held ?? false,
        hurt: db.hurt,
        size: db.size,
        shake: db.fx?.shake ?? 0,
        glow: db.fx?.glow ?? null,
        cred: db.cred,
      },
      now,
    )
    // Their feet, landings and jumps, heard (one's own a little quieter: they are right under the ear).
    const m = v.mesh
    const near = own ? 0.6 : 1
    if (m.footfalls !== v.heard.steps) {
      if (db.alive && !db.riding) footstep(p, db.floor, m.stepWeight(m.lastFoot) * db.size * near)
      v.heard.steps = m.footfalls
    }
    if (m.landings !== v.heard.lands) {
      if (db.alive) landing(p, db.floor, Math.min(1.2, 0.6 + db.size * 0.4) * near)
      v.heard.lands = m.landings
    }
    if (m.jumps !== v.heard.jumps) {
      if (db.alive) play('cloth', 1.1, p, 0.5 * near)
      v.heard.jumps = m.jumps
    }
  }

  private placeThing(tb: ThingSnap, ta: ThingSnap, k: number, ownRiding: DoctorSnap | null, swaying: { sway: { at: Vector3; tilt: Euler }; yaw: number; size: number } | null): void {
    const recipe = this.net.models.get(`thing:${tb.kind}`)
    if (!recipe) return
    let t = this.things.get(tb.id)
    if (!t || t.kind !== tb.kind) {
      t?.inst.dispose()
      t = { inst: new ModelInstance(recipe), kind: tb.kind }
      this.root.add(t.inst.root)
      this.things.set(tb.id, t)
    }
    const holder = tb.holder ? this.doctors.get(tb.holder) : undefined
    // A disguised holder's thing is the disguise: not drawn twice.
    t.inst.root.visible = !(holder?.disguise && tb.holder)
    if (ownRiding && this.ownPos) {
      t.inst.root.position.set(...this.ownPos)
      t.inst.root.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), ownRiding.yaw)
    } else {
      t.inst.root.position.set(...lerpV(ta.p, tb.p, k))
      t.inst.root.quaternion.copy(slerpQ(ta.q, tb.q, k))
      // Where the holder's hand has swayed it to (the doctor's own frame, turned to the world), tilted as it sways.
      if (swaying) {
        t.inst.root.position.add(swaying.sway.at.clone().multiplyScalar(swaying.size).applyAxisAngle(UP, swaying.yaw))
        t.inst.root.quaternion.multiply(new Quaternion().setFromEuler(swaying.sway.tilt))
      }
    }
    t.inst.root.scale.setScalar(tb.scale)
    t.inst.pose(tb.poses)
  }

  private placeBody(bb: BodySnap, ba: BodySnap, k: number): void {
    const key = bb.model ?? JSON.stringify(bb.prim)
    let x = this.bodies.get(bb.id)
    if (!x || x.key !== key) {
      if (x) {
        x.obj.removeFromParent()
        x.inst?.dispose()
        x.own?.dispose()
      }
      const obj = new Group()
      let inst: ModelInstance | null = null
      let own: BufferGeometry | null = null
      const recipe = bb.model ? this.net.models.get(bb.model) : undefined
      if (recipe) {
        inst = new ModelInstance(recipe)
        obj.add(inst.root)
      } else if (bb.prim) {
        const mesh = primMesh(bb.prim)
        if (bb.prim.material) own = mesh.geometry
        obj.add(mesh)
      }
      this.root.add(obj)
      const radius = new Box3().setFromObject(obj).getBoundingSphere(new Sphere()).radius || 0.15
      x = { obj, key, inst, own, radius, trail: x?.trail ?? null }
      this.bodies.set(bb.id, x)
    }
    const p = lerpV(ba.p, bb.p, k)
    x.obj.position.set(...p)
    x.obj.quaternion.copy(slerpQ(ba.q, bb.q, k))
    x.obj.scale.setScalar(bb.scale)
    x.inst?.pose(bb.poses ?? null)
    if (bb.trail && !x.trail) x.trail = new Trail(this.fx, bb.trail, Math.min(0.35, Math.max(0.08, x.radius * bb.scale * 0.5)))
    x.trail?.at(p)
  }

  private placeCrate(cb: CrateSnap, ca: CrateSnap, k: number, now: number): void {
    let c = this.crates.get(cb.id)
    const owner = this.net.player(cb.owner)
    if (!c) {
      const group = new Group()
      // What is solid is cut off above a plane that rises as the crate comes in.
      const cut = new Plane(new Vector3(0, -1, 0), 0)
      const clip = <T extends Material>(m: T): T => {
        m.clippingPlanes = [cut]
        m.clipShadows = true
        return m
      }
      const wood = surfaceMaps('planks')
      const box = new Mesh(CRATE, clip(paint(new MeshStandardMaterial({ color: '#c49a68', map: wood.map, normalMap: wood.normal, normalScale: new Vector2(1.5, 1.5), roughness: 0.8 }), PAINT_MODEL)))
      box.castShadow = true
      const band = new Mesh(BRACKET, clip(paint(new MeshStandardMaterial({ color: harmonizedHex(owner?.color ?? '#888888'), roughness: 0.7 }), PAINT_MODEL)))
      const metal = surfaceMaps('metal')
      const bracketMat = clip(paint(new MeshStandardMaterial({ color: '#8a8f98', map: metal.map, metalness: 0.85, roughness: 0.35 }), PAINT_MODEL))
      for (const y of [-0.4, 0.4]) {
        const b = new Mesh(BRACKET, bracketMat)
        b.scale.set(1, 0.6, 1)
        b.position.y = y
        group.add(b)
      }
      // Coming in, above the cut: blue lines and a faint blue body (the bloom takes them).
      const above = new Plane(new Vector3(0, 1, 0), 0)
      const wireMat = new LineBasicMaterial({ color: '#3d9bff', transparent: true, opacity: 0, depthWrite: false, clippingPlanes: [above] })
      const wire = new LineSegments(CRATE_LINES, wireMat)
      const fillMat = new MeshBasicMaterial({ color: '#2a78ff', transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending, side: 2, clippingPlanes: [above] })
      const fill = new Mesh(CRATE, fillMat)
      const scanMat = new MeshBasicMaterial({ color: '#8fd0ff', transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending })
      const scan = new Mesh(SCAN, scanMat)
      const cog = new Mesh(COG, glowMat('#ffd27a'))
      cog.position.y = 1.0
      const label = new Label(320, 64, 1.6)
      label.sprite.position.y = 1.45
      group.add(box, band, wire, fill, scan, cog, label.sprite)
      this.root.add(group)
      c = { group, cog, box, label, state: '', cut, above, wire, fill, scan, mats: [box.material as Material, band.material as Material, bracketMat, wireMat, fillMat, scanMat] }
      this.crates.set(cb.id, c)
    }
    c.group.position.set(...lerpV(ca.p, cb.p, k))
    // Coming in: the drawing flickers up, then the crate turns solid from the bottom, a bright line
    // where it turns, and the drawing goes as it arrives.
    const arriving = cb.state === 'arriving'
    const a = arriving ? lerp(ca.arrived ?? 0, cb.arrived ?? 0, k) : 1
    const flicker = 0.85 + 0.15 * Math.sin(now * 37 + cb.id.length) * Math.sin(now * 23)
    const shown = Math.min(1, a / 0.15) * (1 - smooth(0.92, 1, a)) * flicker
    const solid = smooth(0.3, 0.95, a)
    ;(c.wire.material as LineBasicMaterial).opacity = 0.9 * shown
    ;(c.fill.material as MeshBasicMaterial).opacity = 0.14 * shown
    c.wire.visible = c.fill.visible = arriving
    c.scan.visible = arriving && solid > 0 && solid < 1
    ;(c.scan.material as MeshBasicMaterial).opacity = 0.8 * shown
    c.scan.position.y = -0.5 + solid
    c.group.updateWorldMatrix(true, false)
    const cutY = c.group.localToWorld(new Vector3(0, -0.5 + solid, 0)).y
    c.cut.constant = arriving ? cutY : 1e6
    c.above.constant = -cutY
    c.cog.visible = cb.state === 'waiting'
    c.cog.rotation.y = now * 3
    c.cog.position.y = 1.0 + Math.sin(now * 4) * 0.08
    const m = c.box.material as MeshStandardMaterial
    m.emissive.setRGB(cb.state === 'ready' ? 0.35 + Math.sin(now * 6) * 0.2 : 0, cb.state === 'ready' ? 0.25 + Math.sin(now * 6) * 0.15 : 0, 0)
    const text = cb.state === 'ready' ? 'Open it: E' : cb.state === 'waiting' ? 'Under review' : `For ${owner?.name ?? 'someone'}`
    if (c.state !== text) {
      c.state = text
      c.label.draw(text, (g, w) => {
        g.font = `600 30px ${LABEL_FONT}`
        g.textAlign = 'center'
        g.lineWidth = 6
        g.strokeStyle = 'rgba(20,10,5,0.85)'
        g.strokeText(text, w / 2, 42)
        g.fillStyle = cb.state === 'ready' ? '#ffd27a' : '#f4ecd8'
        g.fillText(text, w / 2, 42)
      })
    }
  }

  private placeCamera(cam: Camera, dt: number, now: number): void {
    const own = this.own
    this.shake = Math.max(0, this.shake - dt * 1.5)
    // Knocked flat: the camera pulls back to watch one's own body until it gets up.
    if (own && own.alive && own.rag) {
      this.watching = null
      this.syncViewModels(null)
      const target = new Vector3(own.rag.p[0], own.rag.p[1] + 0.3, own.rag.p[2])
      const want = target.clone().add(new Vector3(-Math.sin(cam.yaw) * 3.8, 2.2, -Math.cos(cam.yaw) * 3.8))
      this.downCam = this.downCam ? this.downCam.lerp(want, 1 - Math.exp(-dt * 6)) : this.camera.position.clone().lerp(want, 0.3)
      this.camera.position.copy(this.downCam)
      this.camera.lookAt(target)
      return
    }
    this.downCam = null
    if (own && own.alive && this.ownPos) {
      this.watching = null
      // Trembling from an effect shakes the view as long as it lasts.
      const s = Math.max(this.shake, (own.fx?.shake ?? 0) * 0.45)
      const jx = Math.sin(now * 61) * Math.sin(now * 17.3)
      const jy = Math.sin(now * 53 + 1.3) * Math.sin(now * 13.1)
      this.camera.position.set(this.ownPos[0] + jx * s * 0.03, this.ownPos[1] + EYE * own.size + jy * s * 0.03, this.ownPos[2])
      this.camera.rotation.set(cam.pitch + Math.sin(now * 40) * s * 0.045, cam.yaw + Math.PI, Math.sin(now * 33) * s * 0.04, 'YXZ')
      this.syncViewModels(own)
      return
    }
    this.syncViewModels(null)
    // Out of the round: follow someone still in, from behind and above.
    const alive = [...this.doctors.entries()].filter(([id, d]) => id !== this.net.you && d.mesh.root.visible)
    if (!alive.some(([id]) => id === this.watching)) this.watching = alive[0]?.[0] ?? null
    const target = this.watching ? this.doctors.get(this.watching) : undefined
    if (!target) return
    const p = target.mesh.root.position
    const yaw = target.mesh.root.rotation.y
    const want = new Vector3(p.x - Math.sin(yaw) * 4.5, p.y + 2.8, p.z - Math.cos(yaw) * 4.5)
    this.camera.position.lerp(want, 1 - Math.exp(-dt * 4))
    this.camera.lookAt(p.x, p.y + 1.4, p.z)
  }

  /** Watches the next doctor still in. */
  watchNext(): void {
    const alive = [...this.doctors.entries()].filter(([id, d]) => id !== this.net.you && d.mesh.root.visible).map(([id]) => id)
    if (!alive.length) return
    const i = alive.indexOf(this.watching ?? '')
    this.watching = alive[(i + 1) % alive.length]!
  }

  /** The things in the player's own hands, drawn in front of their eyes, each to its own side (what they ride is drawn under them instead). */
  private syncViewModels(own: DoctorSnap | null): void {
    for (const h of [0, 1] as const) {
      const id = own?.hands[h] ?? null
      const held = id && id !== own?.riding ? this.net.latest()?.snap.things.find((t) => t.id === id) : undefined
      const recipe = held ? this.net.models.get(`thing:${held.kind}`) : undefined
      let vm = this.viewModels[h]
      if (!held || !recipe) {
        vm?.inst.dispose()
        this.viewModels[h] = null
        continue
      }
      if (!vm || vm.kind !== held.kind) {
        vm?.inst.dispose()
        vm = { inst: new ModelInstance(recipe), kind: held.kind, id: held.id }
        this.camera.add(vm.inst.root)
        vm.inst.root.position.set(h === 1 ? 0.28 : -0.28, -0.3, -0.55)
        vm.inst.root.rotation.set(0, Math.PI, 0)
        this.viewModels[h] = vm
      }
      vm.id = held.id
      vm.inst.root.scale.setScalar(held.scale)
      vm.inst.pose(held.poses)
      // Swaying before the eyes as the hand sways it: the doctor's frame (x to its left, z ahead) is the camera's turned round.
      const sway = this.doctors.get(this.net.you ?? '')?.mesh.handSway[h]
      const base = new Vector3(h === 1 ? 0.28 : -0.28, -0.3, -0.55)
      if (sway) base.add(new Vector3(-sway.at.x, sway.at.y, -sway.at.z))
      vm.inst.root.position.copy(base)
      vm.inst.root.quaternion.setFromEuler(VIEW_TURN)
      if (sway) vm.inst.root.quaternion.multiply(new Quaternion().setFromEuler(sway.tilt))
    }
  }
}

/** A body's plain shape: in its colour, or (rubble) in an arena surface, with a geometry of its own so the texture keeps its scale. */
function primMesh(p: Prim): Mesh {
  const geo = p.shape === 'box' ? BOX : p.shape === 'cylinder' ? CYL : p.shape === 'capsule' ? CAPSULE : BALL
  const [x, y, z] = p.size
  const size = p.shape === 'capsule' ? new Vector3(x, y / 2, x) : p.shape === 'ball' ? new Vector3(x, x, x) : p.shape === 'cylinder' ? new Vector3(x, y, x) : new Vector3(x, y, z)
  const mesh = p.material ? new Mesh(prepared(geo, new Matrix4().makeScale(size.x, size.y, size.z), p.material, p.color), surface(p.material)) : new Mesh(geo, p.glow ? glowMat(p.color) : solidMat(p.color))
  if (!p.material) mesh.scale.copy(size)
  mesh.castShadow = true
  return mesh
}
