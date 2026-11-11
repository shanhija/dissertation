/**
 * A doctor as drawn: a body of joints under a lab coat (hips, knees and ankles; a waist that
 * bends; shoulders, elbows and wrists; a neck), and the wardrobe parts worn in each slot
 * (doctor.ts gives their frames), swinging as they hang (swing.ts). Built in the standard doctor's measures and scaled to the
 * look's height; build widens the body, not the head.
 *
 * It moves by itself from what the snapshots say. It walks and runs with bending knees, the hips
 * turning to where it goes while the chest keeps to where it aims; it tucks in a jump, squashes
 * on landing; it flinches when hurt, struggles when held,
 * trembles or convulses under an effect and glows. Its right hand holds what it holds where the
 * game puts it, and a long thing in both hands, the arms bent to reach (two-bone IK). Short
 * gestures play over all this: the recoil of a use, a shove, a throw, stooping to pick something
 * up, a taunt's shaken fist. Every movement is made big, as in a cartoon. A doctor knocked flat
 * or dismissed is a ragdoll in the game (sim/ragdoll.ts): its parts' turns come in the snapshot
 * and become the joints here, and getting up blends from the ragdoll back into the doctor.
 */

import {
  Bone,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Sphere,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three'

import { BODY, SLOT_FRAMES } from '../doctor'
import { GAITS, SLOTS, type Gait, type Hand, type Look, type Quat, type Slot, type Vec3, type WardrobePart } from '../protocol'
import {
  ANKLE,
  BREAST_POCKET,
  COAT,
  COAT_BUTTONS,
  CUFF,
  ELBOW,
  HAND,
  JOINTS,
  KNEE,
  LAPELS,
  PEN_AT,
  SEAT,
  SHIRT,
  SHIRT_BUTTONS,
  SHOE,
  SKIRT,
  SKIRT_LENGTH,
  SKIRT_Y,
  SLEEVE,
  SOLE,
  SPRINGS,
  SPRING_WAIST,
  TROUSER_LEG,
  drape,
} from './figure'
import { ModelInstance, wornInstance } from './models'
import { Swing, type Fence } from './swing'
import { PAINT_DOCTOR, harmonize, harmonizedHex, paint } from './paint'
import { LABEL_LAYER } from './post'
import { LABEL_FONT } from '../fonts'

/** Where the game holds a thing, as the sim's hand: below and right of the eyes, half a metre ahead. */
const HOLD = { eye: 1.55, right: 0.28, down: 0.28, ahead: 0.5 }

/**
 * The body a worn part may not swing into, in each slot's frame: the trunk (the coat round the
 * back and sides, the shirt in front) for what is worn on the body and back, the head for what is
 * worn on it, nothing for the feet.
 */
const TRUNK = { x: 0, z: 0, rx: 0.2, rz: 0.145 }
const SKULL = { x: 0, z: 0, rx: 0.12, rz: 0.12 }
const FENCES = Object.fromEntries(
  SLOTS.map((s) => {
    const round = s === 'feet' ? null : s === 'body' || s === 'back' ? TRUNK : SKULL
    const o = SLOT_FRAMES[s].origin
    return [s, round && { ...round, x: round.x - o[0], z: round.z - o[2] }]
  }),
) as Record<Slot, Fence | null>

const STAR = new OctahedronGeometry(0.03)
const STAR_MAT = new MeshBasicMaterial({ color: new Color(2.4, 2.1, 0.9) })

/**
 * How each way of walking moves the body: steps a second and their length, knee lift and a
 * standing knee bend, a forward bend of the back (a hunch; below 0 the chest thrown out) and the
 * head held against it, a roll of the hips, legs set wide, one leg lame, a tremble, and the arms'
 * swing, how far out and how far forward they hang.
 */
interface GaitStyle {
  cadence: number
  stride: number
  knee: number
  bend: number
  hunch: number
  neck: number
  roll: number
  width: number
  limp: number
  tremble: number
  arms: number
  armsOut: number
  armsForward: number
}
const STEADY: GaitStyle = { cadence: 1, stride: 1, knee: 1, bend: 0, hunch: 0, neck: 0, roll: 0, width: 0, limp: 0, tremble: 0, arms: 1, armsOut: 0, armsForward: 0 }
const STYLES: Record<Exclude<Gait, 'chance'>, GaitStyle> = {
  steady: STEADY,
  limp: { ...STEADY, cadence: 0.9, stride: 0.9, bend: 0.05, hunch: 0.1, roll: 0.05, limp: 1, arms: 0.8 },
  hunched: { ...STEADY, cadence: 0.95, stride: 0.8, knee: 1.1, bend: 0.14, hunch: 0.62, neck: -0.55, roll: 0.04, width: 0.02, arms: 0.55, armsOut: 0.05, armsForward: 0.45 },
  shuffle: { ...STEADY, cadence: 1.55, stride: 0.45, knee: 0.35, bend: 0.16, hunch: 0.16, neck: -0.1, roll: 0.02, arms: 0.4, armsForward: 0.15 },
  waddle: { ...STEADY, cadence: 1.15, stride: 0.65, knee: 0.8, bend: 0.1, roll: 0.17, width: 0.1, arms: 0.6, armsOut: 0.35 },
  pompous: { ...STEADY, cadence: 0.85, stride: 1.15, knee: 1.6, hunch: -0.2, neck: -0.15, arms: 1.4, armsOut: 0.08 },
  doddery: { ...STEADY, cadence: 0.8, stride: 0.55, knee: 0.8, bend: 0.25, hunch: 0.3, neck: -0.25, roll: 0.05, width: 0.03, tremble: 1, arms: 0.5, armsOut: 0.05, armsForward: 0.2 },
}

/** The gait a look stands for; 'chance' picks one by who it is, the same on every screen. */
export function gaitOf(gait: Gait, who: string): Exclude<Gait, 'chance'> {
  if (gait !== 'chance') return gait
  let h = 2166136261
  for (let i = 0; i < who.length; i++) h = Math.imul(h ^ who.charCodeAt(i), 16777619)
  const real = GAITS.slice(1) as Exclude<Gait, 'chance'>[]
  return real[(h >>> 0) % real.length]!
}
const PEN = new CapsuleGeometry(0.007, 0.12, 2, 8)
const BUTTON = new SphereGeometry(0.011, 8, 6)
const NECK = new CylinderGeometry(0.05, 0.056, 0.12, 16)
const HEAD = new SphereGeometry(BODY.head.radius, 28, 20)
const EAR = new SphereGeometry(0.03, 12, 8)
const EYE = new SphereGeometry(0.024, 14, 10)
const PUPIL = new SphereGeometry(0.012, 10, 6)
/** Brows and mouth lie across the face, round-ended. */
const BROW = new CapsuleGeometry(0.0065, 0.036, 3, 8).rotateZ(Math.PI / 2)
const NOSE = new CapsuleGeometry(0.017, 0.03, 4, 12)
const MOUTH = new CapsuleGeometry(0.0048, 0.042, 3, 8).rotateZ(Math.PI / 2)
const WHITE = paint(new MeshStandardMaterial({ color: harmonizedHex('#fbfaf5'), roughness: 0.35 }), PAINT_DOCTOR)
const DARK = paint(new MeshStandardMaterial({ color: harmonizedHex('#3a2a22'), roughness: 0.8 }), PAINT_DOCTOR)
const PENS = ['#c0303a', '#2a4aa0', '#1e1e24'].map((color) => paint(new MeshStandardMaterial({ color: harmonizedHex(color), roughness: 0.4, metalness: 0.2 }), PAINT_DOCTOR))
const glowColor = new Color()
/** A jitter between -1 and 1 that changes every frame, different for each i. */
const jitter = (now: number, i: number) => Math.sin(now * (41 + i * 9.7) + i * 1.9) * Math.cos(now * (23 + i * 5.3) + i)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const smooth = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
const TAU = Math.PI * 2

/** A doctor's material in one colour: skin smooth, cloth matte (the page's paper is its only texture: a knitted weave made them look like sock puppets). */
function mat(color: string, cloth: boolean, double = false): MeshStandardMaterial {
  const m = paint(new MeshStandardMaterial({ color: harmonizedHex(color), roughness: cloth ? 0.95 : 0.6 }), PAINT_DOCTOR)
  if (double) m.side = DoubleSide
  return m
}

/** A text label as a sprite, as wide in the world as asked (metres). */
export class Label {
  readonly sprite: Sprite
  private readonly canvas = document.createElement('canvas')
  protected readonly texture: CanvasTexture
  private key = ''

  constructor(width: number, height: number, worldWidth: number) {
    this.canvas.width = width
    this.canvas.height = height
    this.texture = new CanvasTexture(this.canvas)
    this.texture.minFilter = LinearFilter
    this.sprite = new Sprite(new SpriteMaterial({ map: this.texture, depthTest: false, transparent: true }))
    this.sprite.scale.set(worldWidth, (worldWidth * height) / width, 1)
    this.sprite.renderOrder = 10
    // Drawn over everything once the light is made the screen's colours (post.ts): the canvas's
    // colours go onto the screen as they are, the texture read with no colour space of its own.
    this.sprite.layers.set(LABEL_LAYER)
  }

  draw(key: string, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): void {
    if (key === this.key) return
    this.key = key
    const g = this.canvas.getContext('2d')!
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    paint(g, this.canvas.width, this.canvas.height)
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
    ;(this.sprite.material as SpriteMaterial).dispose()
  }
}

const screenSize = new Vector2()
const parentScale = new Vector3()

/**
 * A label drawn at a steady size on the screen whatever its distance, as the page's own text is
 * (2026-11-11: a name tag sized in metres could not be read past about 8 m), and in the same
 * pixels: width and height are its size there. The canvas is drawn at twice that, for sharp
 * screens, and stays sharp smaller through its mipmaps. Drawn over everything: whoever shows it
 * decides when it can be seen (a name tag while its doctor can be: World.nameTags).
 */
export class ScreenLabel extends Label {
  constructor(width: number, height: number) {
    super(width * 2, height * 2, 1)
    this.texture.minFilter = LinearMipmapLinearFilter
    const m = this.sprite.material as SpriteMaterial
    m.sizeAttenuation = false
    m.depthWrite = false
    m.fog = false
    this.sprite.onBeforeRender = (renderer, _scene, camera) => {
      // Metres per pixel one metre away (a sprite of fixed size is scaled by its distance), under whatever scales its parent.
      const perPixel = 2 / (camera.projectionMatrix.elements[5]! * renderer.getSize(screenSize).y)
      this.sprite.parent!.getWorldScale(parentScale)
      this.sprite.scale.set((width * perPixel) / parentScale.x, (height * perPixel) / parentScale.y, 1)
      this.sprite.updateMatrixWorld()
    }
  }
}

/** A name tag's height on the screen, in the page's pixels: it stands this tall above its foot, over the head. */
export const TAG_HEIGHT = 40
/** A taunt's bubble on the screen, in the page's pixels: it stands over the name tag, at most four lines. */
const BUBBLE = [300, 120] as const

/** Within this many metres a doctor's name tag is drawn in full. */
export const TAG_NEAR = 12
/** The doctor nearest the crosshair, within this angle (radians), has their tag in full however far. */
export const TAG_AIM = (6 * Math.PI) / 180

/**
 * Whose name tags are drawn in full, seen from an eye looking along `forward`: every doctor near
 * (marks: where each is), and the one nearest the crosshair. The rest show a pip in their colour,
 * so a line of doctors is not a wall of names, and who is who still reads at any distance.
 */
export function fullTags(eye: Vector3, forward: Vector3, marks: ReadonlyMap<string, Vector3>): Set<string> {
  const full = new Set<string>()
  let aimed: string | null = null
  let best = TAG_AIM
  for (const [id, p] of marks) {
    const to = p.clone().sub(eye)
    if (to.length() <= TAG_NEAR) full.add(id)
    const angle = to.angleTo(forward)
    if (angle < best) {
      best = angle
      aimed = id
    }
  }
  if (aimed) full.add(aimed)
  return full
}

/** Wraps text into lines that fit a width. */
export function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (g.measureText(next).width > width && line) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export interface DoctorPose {
  yaw: number
  pitch: number
  /** How fast it moves, m/s, in the world. */
  vel: Vec3
  grounded: boolean
  /** How long the thing in each hand is (0 left, 1 right), metres, or null when the hand is empty: a long one takes both hands when the other is free. */
  hands: [number | null, number | null]
  riding: boolean
  writing: boolean
  /** Held by an effect: can neither walk nor use its hands. */
  held: boolean
  /** Seconds since hurt. */
  hurt: number
  size: number
  /** 0..1 from effects: trembling, at 1 convulsing. */
  shake: number
  glow: string | null
  /** Credibility, 0..100: the less of it, the more stress and doubt bow them. */
  cred: number
}

/** What a doctor does for a moment, over whatever else it is doing. */
export type Gesture = 'use' | 'alt' | 'throw' | 'shove' | 'pick' | 'taunt'
const LASTS: Record<Gesture, number> = { use: 0.35, alt: 0.4, throw: 0.55, shove: 0.45, pick: 0.7, taunt: 2.2 }
/** The furthest the legs push the coat out from hanging straight, radians. */
const LEG_PUSH = 0.75
/** Seconds it takes to get from lying as a ragdoll back into the doctor's own pose. */
const GET_UP = 0.45

/** A gesture's strength at t seconds in: up in `attack`, held, down over the last part. */
function envelope(t: number, dur: number, attack = 0.08, release = 0.35): number {
  if (t < 0 || t > dur) return 0
  return Math.min(1, t / attack) * Math.min(1, (dur - t) / (dur * release))
}

/** An arm's pose: the shoulder's turn, the elbow's bend (radians, negative bends it) and the wrist's twist. */
interface ArmPose {
  q: Quaternion
  elbow: number
  wrist: number
}

const euler = new Euler()
function armFK(x: number, z: number, elbow: number, wrist = 0): ArmPose {
  return { q: new Quaternion().setFromEuler(euler.set(x, 0, z)), elbow, wrist }
}

function blendArm(a: ArmPose, b: ArmPose, k: number): ArmPose {
  if (k <= 0) return a
  if (k >= 1) return b
  return { q: a.q.clone().slerp(b.q, k), elbow: lerp(a.elbow, b.elbow, k), wrist: lerp(a.wrist, b.wrist, k) }
}

/**
 * Two-bone IK: the shoulder's turn and the elbow's bend that put the end of an arm of lengths a
 * and b (from a shoulder at s) on the target t, the elbow toward the pole. All in the shoulder's
 * parent's space; the limb hangs along its own -y and bends about its own x.
 */
export function reach(s: Vector3, t: Vector3, a: number, b: number, pole: Vector3): ArmPose {
  const d = t.clone().sub(s)
  const dist = clamp(d.length(), Math.abs(a - b) + 0.01, a + b - 0.001)
  d.normalize()
  const n = new Vector3().crossVectors(d, pole)
  if (n.lengthSq() < 1e-8) n.crossVectors(d, Math.abs(d.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0))
  n.normalize()
  // The upper part leans off the straight line toward the pole by the angle the triangle needs.
  const lean = Math.acos(clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1))
  const u = d.clone().applyAxisAngle(n, lean)
  const y = u.clone().negate()
  const z = new Vector3().crossVectors(n, y)
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(n, y, z))
  const inner = Math.acos(clamp((a * a + b * b - dist * dist) / (2 * a * b), -1, 1))
  return { q, elbow: -(Math.PI - inner), wrist: 0 }
}

/** The joints a ragdoll turns. */
type Jointed = Pick<DoctorMesh, 'root' | 'body' | 'pelvis' | 'spine' | 'neck' | 'hips' | 'knees' | 'ankles' | 'shoulders' | 'elbows' | 'wrists'>

/**
 * Lays the joints as a ragdoll lies: the trunk's turn and the pelvis on its point, then each part
 * turned from the part it hangs from (the ragdoll's parts have the joints' own frames).
 */
export function applyRag(m: Jointed, p: Vec3, q: Quat[]): void {
  const Q = (i: number) => new Quaternion(q[i]![0], q[i]![1], q[i]![2], q[i]![3])
  // The parts: pelvis, chest, head, right arm (upper, fore), left arm, right leg (thigh, shin), left leg.
  const pelvis = Q(0)
  const chest = Q(1)
  m.root.updateMatrixWorld(true)
  const rootQ = m.root.getWorldQuaternion(new Quaternion())
  m.body.quaternion.copy(rootQ.invert().multiply(pelvis))
  const scale = m.body.getWorldScale(new Vector3()).y
  m.body.position.copy(m.root.worldToLocal(new Vector3(...p).sub(new Vector3(0, BODY.hips.y * scale, 0).applyQuaternion(pelvis))))
  m.pelvis.rotation.set(0, 0, 0)
  const fromPelvis = pelvis.clone().invert()
  const fromChest = chest.clone().invert()
  m.spine.quaternion.copy(fromPelvis.clone().multiply(chest))
  m.neck.quaternion.copy(fromChest.clone().multiply(Q(2)))
  for (const i of [0, 1]) {
    const upper = Q(3 + 2 * i)
    const thigh = Q(7 + 2 * i)
    m.shoulders[i]!.quaternion.copy(fromChest.clone().multiply(upper))
    m.elbows[i]!.quaternion.copy(upper.clone().invert().multiply(Q(4 + 2 * i)))
    m.hips[i]!.quaternion.copy(fromPelvis.clone().multiply(thigh))
    m.knees[i]!.quaternion.copy(thigh.clone().invert().multiply(Q(8 + 2 * i)))
    m.ankles[i]!.rotation.set(0.3, 0, 0)
    m.wrists[i]!.rotation.set(0, 0, 0)
  }
}

export class DoctorMesh {
  readonly root = new Group()
  /** The whole body, scaled to the look's height, moved for bobbing, landing and tumbling. */
  readonly body = new Group()
  readonly pelvis = new Group()
  readonly spine = new Group()
  /** The trunk on the spine, widened by build: torso, coat and what is on it. */
  private readonly chest = new Group()
  readonly neck = new Group()
  readonly head = new Group()
  /** Right first (at -x: the doctor faces +z), then left. */
  readonly hips: Group[] = []
  readonly knees: Group[] = []
  readonly ankles: Group[] = []
  readonly shoulders: Group[] = []
  readonly elbows: Group[] = []
  readonly wrists: Group[] = []
  private readonly hipsMesh: Mesh
  private readonly mats: Record<'skin' | 'eyes' | 'coat' | 'shirt' | 'trousers' | 'shoes', MeshStandardMaterial>
  /** What is worn in each slot: one copy, or one on each foot, each swinging on its own. */
  private readonly worn = new Map<Slot, { inst: ModelInstance; swing: Swing }[]>()
  /** Where each slot's parts hang: the head, the trunk, or each ankle (the right foot mirrored). */
  private readonly wornGroups: Record<Slot, Group[]>
  /** The shoes, hidden while something is worn on the feet. */
  private readonly shoes: Mesh[] = []
  /** Each ankle's group for what is worn on the feet, built before the slots are. */
  private readonly feetAt: Group[] = []
  private lookKey = ''
  private height: number = BODY.height
  private build = 1
  /** The name tag, standing over the doctor's head (shown while the doctor can be seen), TAG_HEIGHT page pixels tall above its foot. */
  readonly tag = new ScreenLabel(240, TAG_HEIGHT)
  /**
   * A taunt as said, in a bubble over the name tag, as the tag the same size on the screen near or
   * far (sized in metres, it was unreadable past a few metres, and the tag stood up into it).
   */
  readonly bubble = new ScreenLabel(BUBBLE[0], BUBBLE[1])
  bubbleUntil = 0
  /** When it last lay as a ragdoll, and the joints as they lay, to get up from. */
  private ragAt = -10
  private readonly lay = new Map<Group, Quaternion>()
  private readonly layAt = new Vector3()
  /** Where the ragdoll's pelvis was last frame, for how fast it flies. */
  private readonly ragWas = new Vector3()

  // How it is moving, kept between frames.
  private last = -1
  private phase = 0
  private legYaw = 0
  private lean = 0
  private sway = 0
  private air = 0
  private wasGrounded = true
  private airSince = 0
  private landAt = -10
  private readonly gestures: { kind: Gesture; at: number; hand: Hand }[] = []
  private readonly seed = Math.random() * 100
  /**
   * The coat below the waist: one piece of cloth (its own copy, draped each frame) swung by four
   * springs round it (angle out from hanging straight), each with its hem on a softer one that
   * trails it (hem: its angle out); draped: the springs as last drawn.
   */
  private readonly skirt = new Group()
  /** The skinned parts' skeletons, each holding its joints' turns in a texture of its own. */
  private readonly skeletons: Skeleton[] = []
  /** The limbs' girth on each joint (hips, knees, shoulders, elbows), widened by build. */
  private readonly flesh: Group[] = []
  private readonly skirtGeometry: BufferGeometry = SKIRT.geometry.clone()
  private readonly springs = SPRINGS.map((mid) => ({ mid, angle: 0.06, speed: 0, hem: 0.06, hemSpeed: 0 }))
  private draped = SPRINGS.map(() => ({ angle: NaN, bend: NaN }))
  private style: GaitStyle = STEADY
  /** The head lagging the body's moves, a spring each way; the free arms' swing, a spring each. */
  private readonly nod = { x: 0, z: 0, vx: 0, vz: 0 }
  private readonly armSwing = [
    { a: 0, v: 0 },
    { a: 0, v: 0 },
  ]
  /** The body's velocity and heading last frame, for its acceleration and turning (its own frame). */
  private readonly prevLocal = new Vector3()
  private prevYaw = 0
  private readonly accel = new Vector3()
  private yawRate = 0
  /** Stars round the head while it is dazed. */
  private readonly stars = new Group()
  /** Counted for the sounds: feet put down (and which: 0 right, 1 left), landings, jumps. */
  footfalls = 0
  lastFoot = 0
  landings = 0
  jumps = 0
  private footK = 0
  /**
   * Where a thing in each hand (0 left, 1 right) is carried off its steady place by the stride, a
   * turn and a recoil, in the doctor's own frame, and how it tilts: the hands follow it, and the
   * world moves the drawn thing with it.
   */
  readonly handSway: { at: Vector3; tilt: Euler }[] = [
    { at: new Vector3(), tilt: new Euler() },
    { at: new Vector3(), tilt: new Euler() },
  ]

  constructor() {
    this.mats = { skin: mat('#e8b892', false), eyes: mat('#3a2a1e', false), coat: mat('#f4f1ea', true, true), shirt: mat('#4a6a9a', true), trousers: mat('#2a2a30', true), shoes: mat('#1e1a18', false) }
    this.mats.shoes.roughness = 0.35
    const m = this.mats
    this.root.add(this.body)

    // Each skinned part (the trouser legs, the coat above the waist, the sleeves) and the joints it bends with.
    const skinned: { mesh: SkinnedMesh; joints: Group[]; seen: Sphere }[] = []
    /** A limb's girth on its joint, widened by build with nothing hanging from it. */
    const fleshOf = (joint: Group) => {
      const g = new Group()
      joint.add(g)
      this.flesh.push(g)
      return g
    }
    // Hips and legs: trouser legs bending at the knee, the seat between them.
    this.pelvis.position.y = BODY.hips.y
    this.body.add(this.pelvis)
    this.hipsMesh = new Mesh(SEAT, m.trousers)
    this.pelvis.add(this.hipsMesh)
    for (const side of [-1, 1]) {
      const hip = new Group()
      hip.position.set(side * JOINTS.hipX, 0, 0)
      const knee = new Group()
      knee.position.y = -JOINTS.thigh
      const ankle = new Group()
      ankle.position.y = -JOINTS.shin
      const sole = new Mesh(SOLE, DARK)
      const shoe = new Mesh(SHOE, m.shoes)
      ankle.add(sole, shoe)
      this.shoes.push(sole, shoe)
      // What is worn on the feet: the ground under the ankle, the left as made, the right mirrored.
      const feet = new Group()
      feet.position.y = -ANKLE
      feet.scale.x = side
      ankle.add(feet)
      this.feetAt.push(feet)
      knee.add(ankle)
      const shin = fleshOf(knee)
      shin.add(new Mesh(KNEE, m.trousers))
      const leg = new SkinnedMesh(TROUSER_LEG, m.trousers)
      hip.add(leg, knee)
      skinned.push({ mesh: leg, joints: [fleshOf(hip), shin], seen: new Sphere(new Vector3(), 1) })
      this.pelvis.add(hip)
      this.hips.push(hip)
      this.knees.push(knee)
      this.ankles.push(ankle)
    }

    // The trunk on the spine: positions below are from the waist. The skirt hangs from the waist
    // on the hips; the coat above it bends between the hips and the chest.
    const w = JOINTS.waist
    this.spine.position.y = w
    this.body.add(this.spine)
    this.spine.add(this.chest)
    this.skirt.position.y = SKIRT_Y - BODY.hips.y
    this.pelvis.add(this.skirt)
    const coat = new SkinnedMesh(COAT, m.coat)
    // Its joints: the hips and the chest, then each upper arm as the arms are made.
    const coatJoints = [this.skirt, this.chest]
    skinned.push({ mesh: coat, joints: coatJoints, seen: new Sphere(new Vector3(0, 1.2, 0), 0.6) })
    // The coat's front: the shirt in its V, the lapels, the breast pocket with its pens, buttons.
    const front: Mesh[] = [coat, new Mesh(SHIRT, m.shirt), new Mesh(LAPELS, m.coat), new Mesh(BREAST_POCKET, m.coat)]
    PEN_AT.forEach((at, i) => front.push(new Mesh(PEN, PENS[i]!).translateX(at.x).translateY(at.y).translateZ(at.z)))
    for (const at of [...COAT_BUTTONS, ...SHIRT_BUTTONS]) front.push(new Mesh(BUTTON, WHITE).translateX(at.x).translateY(at.y).translateZ(at.z))
    for (const mesh of front) {
      mesh.position.y -= w
      this.chest.add(mesh)
    }
    // Its own copy of the skirt to drape, seen wherever the hem may swing.
    this.skirtGeometry.computeBoundingSphere()
    this.skirtGeometry.boundingSphere!.radius += 0.35
    this.skirt.add(new Mesh(this.skirtGeometry, m.coat))

    // Neck and head: the head turns at the neck.
    this.neck.position.y = JOINTS.neck - w
    this.neck.add(new Mesh(NECK, m.skin))
    this.spine.add(this.neck)
    this.head.position.y = BODY.head.center[1] - JOINTS.neck
    this.neck.add(this.head)
    const skull = new Mesh(HEAD, m.skin)
    skull.scale.set(1, 1.06, 1)
    this.head.add(skull)
    // Stars for when it is dazed, circling over the head.
    this.stars.position.y = 0.24
    for (let i = 0; i < 5; i++) {
      const star = new Mesh(STAR, STAR_MAT)
      star.position.set(Math.cos((i / 5) * TAU) * 0.17, 0, Math.sin((i / 5) * TAU) * 0.17)
      this.stars.add(star)
    }
    this.stars.visible = false
    this.head.add(this.stars)
    for (const side of [-1, 1]) {
      const eye = new Mesh(EYE, WHITE)
      eye.position.set(side * 0.045, 0.02, 0.11)
      const pupil = new Mesh(PUPIL, m.eyes)
      pupil.position.set(side * 0.045, 0.02, 0.131)
      const brow = new Mesh(BROW, DARK)
      brow.position.set(side * 0.047, 0.058, 0.12)
      brow.rotation.z = side * -0.15
      const ear = new Mesh(EAR, m.skin)
      ear.position.set(side * 0.128, 0.0, -0.005)
      ear.scale.set(0.45, 1, 0.8)
      this.head.add(eye, pupil, brow, ear)
    }
    const nose = new Mesh(NOSE, m.skin)
    nose.position.set(0, -0.012, 0.13)
    nose.rotation.x = 0.35
    const mouth = new Mesh(MOUTH, DARK)
    mouth.position.set(0, -0.062, 0.118)
    this.head.add(nose, mouth)

    // Arms: shoulder, elbow, wrist; a sleeve bending at the elbow, the shirt's cuff out of it, a hand.
    for (const side of [-1, 1]) {
      const shoulder = new Group()
      shoulder.position.set(side * BODY.shoulders.half, BODY.shoulders.y - w, 0)
      const elbow = new Group()
      elbow.position.y = -JOINTS.upper
      const wrist = new Group()
      wrist.position.y = -JOINTS.fore
      const hand = new Mesh(HAND, m.skin)
      hand.scale.x = side
      wrist.add(hand)
      elbow.add(wrist)
      const forearm = fleshOf(elbow)
      forearm.add(new Mesh(ELBOW, m.coat), new Mesh(CUFF, m.shirt))
      const sleeve = new SkinnedMesh(SLEEVE, m.coat)
      shoulder.add(sleeve, elbow)
      const upperArm = fleshOf(shoulder)
      skinned.push({ mesh: sleeve, joints: [upperArm, forearm], seen: new Sphere(new Vector3(), 0.75) })
      coatJoints.push(upperArm)
      this.spine.add(shoulder)
      this.shoulders.push(shoulder)
      this.elbows.push(elbow)
      this.wrists.push(wrist)
    }

    this.wornGroups = Object.fromEntries(SLOTS.map((s) => [s, s === 'feet' ? this.feetAt : [new Group()]])) as Record<Slot, Group[]>
    for (const s of SLOTS) {
      if (s === 'feet') continue
      const g = this.wornGroups[s][0]!
      if (s === 'hair' || s === 'head' || s === 'face') this.head.add(g)
      else {
        // Body and back parts go with the trunk, in the body's frame.
        const o = SLOT_FRAMES[s].origin
        g.position.set(o[0], o[1] - w, o[2])
        this.spine.add(g)
      }
    }
    // Skinned as made, every joint at rest: a bone on each joint, and the part seen wherever they take it.
    this.root.updateMatrixWorld(true)
    for (const { mesh, joints, seen } of skinned) {
      const skeleton = new Skeleton(
        joints.map((j) => {
          const bone = new Bone()
          j.add(bone)
          bone.updateMatrixWorld(true)
          return bone
        }),
      )
      mesh.bind(skeleton)
      mesh.boundingSphere = seen
      this.skeletons.push(skeleton)
    }
    this.body.traverse((o) => {
      if (o instanceof Mesh) o.castShadow = true
    })
    this.root.add(this.tag.sprite, this.bubble.sprite)
    this.tag.sprite.center.set(0.5, 0)
    // From the tag's foot, up past the tag.
    this.bubble.sprite.center.set(0.5, -(TAG_HEIGHT + 4) / BUBBLE[1])
    this.bubble.sprite.visible = false
  }

  /** Dresses it as the look says (rebuilt only when the look or the wardrobe changed). */
  /** Dresses it as a look says; who it is decides a gait left to chance. */
  dress(look: Look, wardrobe: ReadonlyMap<string, WardrobePart>, who = ''): void {
    const key = JSON.stringify(look) + who + [...SLOTS].map((s) => (look.worn[s] && wardrobe.has(look.worn[s]!) ? '1' : '0')).join('')
    if (key === this.lookKey) return
    this.lookKey = key
    this.style = STYLES[gaitOf(look.gait ?? 'chance', who)]
    for (const k of ['skin', 'eyes', 'coat', 'shirt', 'trousers', 'shoes'] as const) harmonize(this.mats[k].color.set(look[k]))
    this.height = look.height
    this.build = look.build
    const h = look.height / BODY.height
    this.body.scale.set(h, h, h)
    // Build widens the trunk and moves the arms and legs out; the head and what it wears stay as they are.
    this.chest.scale.set(look.build, 1, look.build)
    this.skirt.scale.set(look.build, 1, look.build)
    this.hipsMesh.scale.set(look.build, 1, look.build)
    for (const g of this.flesh) g.scale.set(look.build, 1, look.build)
    this.shoulders.forEach((a, i) => (a.position.x = (i === 0 ? -1 : 1) * BODY.shoulders.half * look.build))
    this.hips.forEach((l, i) => (l.position.x = (i === 0 ? -1 : 1) * JOINTS.hipX * look.build))
    this.wornGroups.body[0]!.scale.set(look.build, 1, look.build)
    this.wornGroups.back[0]!.scale.set(look.build, 1, 1)
    for (const s of SLOTS) {
      const id = look.worn[s]
      const part = id ? wardrobe.get(id) : undefined
      const had = this.worn.get(s)
      if (had && had[0]!.inst.recipe === part?.recipe) continue
      had?.forEach((w) => w.inst.dispose())
      this.worn.delete(s)
      if (part) {
        this.worn.set(
          s,
          this.wornGroups[s].map((g) => {
            const inst = wornInstance(part.recipe)
            g.add(inst.root)
            return { inst, swing: new Swing(part.recipe, inst.parts, inst.root, FENCES[s]) }
          }),
        )
      }
    }
    for (const m of this.shoes) m.visible = !this.worn.has('feet')
    // Over the top of whatever the head wears (a tall hat stood through the tag).
    const crown = Math.max(0, ...(['hair', 'head'] as const).map((s) => (this.worn.get(s)?.[0]!.inst.recipe.bounds.max[1] ?? 0) - BODY.head.radius))
    const top = this.height + crown * h
    this.tag.sprite.position.y = top + 0.3
    this.bubble.sprite.position.y = top + 0.3
  }

  /**
   * The name tag: the name in the player's colour and a bar of credibility under it; or, for a
   * doctor neither near nor looked at, a pip in their colour, so a room of doctors is not a
   * wall of names.
   */
  label(name: string, color: string, cred: number, full: boolean): void {
    const c = Math.round(cred)
    this.tag.draw(full ? `${name}|${color}|${c}` : `pip|${color}`, (g, w, h) => {
      const ink = 'rgba(20,14,10,0.9)'
      if (!full) {
        g.beginPath()
        g.arc(w / 2, h - 13, 9, 0, TAU)
        g.fillStyle = color
        g.fill()
        g.lineWidth = 4
        g.strokeStyle = ink
        g.stroke()
        return
      }
      g.font = `600 34px ${LABEL_FONT}`
      g.textAlign = 'center'
      // An outline thick enough to hold the name off a bright window or a lamp's bloom.
      g.lineWidth = 10
      g.lineJoin = 'round'
      g.strokeStyle = ink
      g.strokeText(name, w / 2, 38)
      g.fillStyle = color
      g.fillText(name, w / 2, 38)
      g.fillStyle = ink
      g.fillRect(w / 2 - 82, 52, 164, 18)
      g.fillStyle = c > 50 ? '#e8d9a8' : c > 25 ? '#e0a040' : '#e05040'
      g.fillRect(w / 2 - 79, 55, (158 * c) / 100, 12)
    })
  }

  /** Where the name tag (and a taunt's bubble over it) stands, its foot over the head, in the world. */
  tagFoot(): Vec3 {
    return this.tag.sprite.getWorldPosition(new Vector3()).toArray()
  }

  /** Page pixels over the tag's foot that the tag and, while one is up, a taunt's bubble take: words floating over the doctor start above them. */
  overhead(): number {
    return TAG_HEIGHT + 4 + (this.bubble.sprite.visible ? BUBBLE[1] : 0)
  }

  say(text: string, until: number): void {
    this.bubbleUntil = until
    this.bubble.sprite.visible = true
    this.bubble.draw(text, (g, w, h) => {
      g.font = `italic 500 34px ${LABEL_FONT}`
      const lines = wrap(g, `“${text}”`, w - 40).slice(0, 4)
      const bh = lines.length * 40 + 24
      g.fillStyle = 'rgba(250,244,226,0.95)'
      g.strokeStyle = '#3a2a1e'
      g.lineWidth = 3
      g.beginPath()
      g.roundRect(4, h - bh - 4, w - 8, bh, 14)
      g.fill()
      g.stroke()
      g.fillStyle = '#2a1e14'
      g.textAlign = 'center'
      lines.forEach((l, i) => g.fillText(l, w / 2, h - bh + 40 + i * 40))
    })
  }

  /** Starts a gesture, played over whatever the doctor is doing, with one hand (0 left, 1 right). */
  gesture(kind: Gesture, now: number, hand: Hand = 1): void {
    this.gestures.push({ kind, at: now, hand })
    if (this.gestures.length > 6) this.gestures.shift()
  }

  pose(p: DoctorPose, now: number): void {
    const dt = this.last < 0 ? 1 / 60 : clamp(now - this.last, 0, 0.1)
    this.last = now
    this.root.rotation.y = p.yaw
    this.root.scale.setScalar(p.size)
    this.colour(p, now)
    if (this.bubble.sprite.visible && now > this.bubbleUntil) this.bubble.sprite.visible = false
    for (let i = this.gestures.length - 1; i >= 0; i--) if (now - this.gestures[i]!.at > LASTS[this.gestures[i]!.kind]) this.gestures.splice(i, 1)
    /** How far into a gesture it is (0..1 and back), of either hand or of one. */
    const g = (kind: Gesture, hand?: Hand) => {
      let e = 0
      for (const x of this.gestures) if (x.kind === kind && (hand === undefined || x.hand === hand)) e = Math.max(e, kind === 'use' ? envelope(now - x.at, LASTS.use, 0.02, 0.85) : envelope(now - x.at, LASTS[kind]))
      return e
    }
    const last = (kind: Gesture) => {
      for (let i = this.gestures.length - 1; i >= 0; i--) if (this.gestures[i]!.kind === kind) return this.gestures[i]!
      return null
    }
    const since = (kind: Gesture) => {
      const x = last(kind)
      return x ? now - x.at : Infinity
    }
    const holding = p.hands[0] !== null || p.hands[1] !== null
    /** The arm of a hand: the drawn arms go right (0, at -x) then left (1). */
    const armOf = (hand: Hand) => (hand === 1 ? 0 : 1)

    // How it moves, in its own frame: +z ahead, +x to its left.
    const sy = Math.sin(p.yaw)
    const cy = Math.cos(p.yaw)
    const lz = p.vel[0] * sy + p.vel[2] * cy
    const lx = p.vel[0] * cy - p.vel[2] * sy
    const speed = Math.hypot(lx, lz)
    const vy = p.vel[1]
    const k = (rate: number) => 1 - Math.exp(-dt * rate)
    // Acceleration and turning, smoothed, for what lags behind: the coat, the head, a thing in hand.
    if (dt > 0) {
      this.accel.lerp(new Vector3((lx - this.prevLocal.x) / dt, (vy - this.prevLocal.y) / dt, (lz - this.prevLocal.z) / dt).clampLength(0, 40), k(12))
      let turn = p.yaw - this.prevYaw
      turn -= Math.round(turn / TAU) * TAU
      this.yawRate += (clamp(turn / dt, -12, 12) - this.yawRate) * k(12)
    }
    this.prevLocal.set(lx, vy, lz)
    this.prevYaw = p.yaw
    const st = this.style
    // Stress and doubt: the less credibility is left, the more they bow under it ("they should hunch more, being overburdened by stress and doubt").
    const stress = clamp(1 - p.cred / 100, 0, 1) ** 1.3
    // Dazed for a moment after getting up from a fall.
    const sinceUp = now - this.ragAt
    const dazed = sinceUp > 0 && sinceUp < 2.4 ? clamp(1 - (sinceUp - GET_UP) / 1.9, 0, 1) : 0

    // In the air, landing, thrown.
    if (p.grounded && !this.wasGrounded && now - this.airSince > 0.25) {
      this.landAt = now
      this.landings++
    }
    if (!p.grounded && this.wasGrounded) {
      this.airSince = now
      if (vy > 2) this.jumps++
    }
    this.wasGrounded = p.grounded
    this.air += ((p.grounded || p.riding ? 0 : 1) - this.air) * k(14)
    const squash = Math.max(0, 1 - (now - this.landAt) / 0.28)

    // The gait: a cycle per stride, the hips turned toward where it goes (backwards: legs ahead, walking back).
    const moving = p.grounded && !p.riding && !p.held ? smooth(0.3, 1.2, speed) : 0
    let travel = Math.atan2(lx, lz)
    let dir = 1
    if (Math.abs(travel) > 2.0) {
      travel -= Math.PI * Math.sign(travel)
      dir = -1
    }
    this.legYaw += ((moving > 0.1 ? clamp(travel, -1.1, 1.1) : 0) - this.legYaw) * k(10)
    this.phase += dir * (speed / (1.1 + 0.22 * speed)) * TAU * dt * moving * st.cadence * (1 - 0.15 * stress)
    // A foot comes down every half stride: the right at 3/2 pi, the left at 1/2 pi.
    const footK = Math.floor((this.phase - Math.PI / 2) / Math.PI)
    if (footK !== this.footK && moving > 0.3 && p.grounded) {
      this.footfalls++
      this.lastFoot = ((footK % 2) + 2) % 2 === 0 ? 1 : 0
    }
    this.footK = footK
    const run = clamp((speed - 2.5) / 3.5, 0, 1) * moving
    const amp = (0.42 + 0.09 * Math.min(speed, 8)) * moving * st.stride * (1 - 0.25 * stress)
    this.lean += (clamp(0.05 * lz * dir, -0.22, 0.45) * moving + 0.15 * run - this.lean) * k(8)
    this.sway += (clamp(-0.05 * lx, -0.22, 0.22) * moving - this.sway) * k(8)

    // Legs: hip (+ swings back), knee (+ bends), ankle (+ toes down).
    const legs = [0, 1].map((i) => {
      const ph = this.phase + i * Math.PI
      const h = amp * Math.sin(ph)
      const swing = Math.max(0, -Math.cos(ph))
      // Each way of walking: its knee lift, a standing bend (more with stress), legs set wide.
      return { hip: h, knee: (0.08 + Math.pow(swing, 1.5) * (0.55 + 1.25 * run) * st.knee) * moving + st.bend + 0.12 * stress, side: (i === 0 ? -1 : 1) * st.width }
    })
    // A lame right leg: a short stiff step, the weight off it quickly.
    if (st.limp > 0) {
      legs[0]!.hip *= 1 - 0.55 * st.limp
      legs[0]!.knee = lerp(legs[0]!.knee, Math.min(legs[0]!.knee, 0.14), st.limp)
    }
    // Standing: weight shifts a little from foot to foot.
    const idle = 1 - moving
    legs[0]!.knee += idle * (0.05 + 0.07 * Math.max(0, Math.sin(now * 0.7 + this.seed)))
    legs[1]!.knee += idle * (0.05 + 0.07 * Math.max(0, -Math.sin(now * 0.7 + this.seed)))
    // In the air: knees tucked going up, legs reaching down coming down.
    const rising = clamp(vy / 4, 0, 1)
    legs.forEach((l, i) => {
      const tuck = lerp(0.5, 1.45, rising)
      l.hip = lerp(l.hip, -lerp(0.25, 0.85, rising) + (i ? 0.2 : -0.15), this.air)
      l.knee = lerp(l.knee, tuck + (i ? 0.2 : 0), this.air)
    })
    // Riding: a crouch, knees forward.
    if (p.riding) legs.forEach((l) => ((l.hip = -0.4), (l.knee = 0.8)))
    // Landing and stooping: knees give.
    const pick = g('pick')
    legs.forEach((l) => {
      l.knee += 1.0 * squash + 0.85 * pick
      l.hip -= 0.5 * squash + 0.45 * pick
    })
    // Held fast: knees jigging.
    if (p.held) legs.forEach((l, i) => (l.knee = 0.15 + 0.18 * Math.max(0, Math.sin(now * 9 + i * Math.PI))))

    // The spine's gestures, and the body: bob with the stride, squash on landing, crouch to ride, lunge into a shove, rock back from a recoil.
    const hurt = p.hurt < 0.45 ? 1 - p.hurt / 0.45 : 0
    const shove = g('shove')
    const recoils = [p.hands[0] !== null ? g('use', 0) : 0, p.hands[1] !== null ? g('use', 1) : 0]
    const recoil = Math.max(recoils[0]!, recoils[1]!)
    const taunt = g('taunt')
    const throwT = since('throw') / LASTS.throw
    const throwing = throwT <= 1
    const h = this.height / BODY.height
    const stance = Math.max(0, Math.cos(this.phase)) * moving
    const bob =
      moving * (0.04 * Math.cos(2 * this.phase) - 0.02 - 0.06 * run) - 0.14 * squash - 0.16 * pick - (p.riding ? 0.1 : 0) + taunt * 0.05 * Math.abs(Math.sin(now * 8)) - st.limp * 0.08 * stance - st.bend * 0.12 - 0.04 * stress
    this.body.quaternion.identity()
    this.body.position.set(0, bob * h, (0.15 * shove - 0.1 * recoil) * h)
    // A waddle rolls the whole body from foot to foot; a limp drops it onto the good side.
    this.body.rotateZ(st.roll * Math.sin(this.phase) * (moving + 0.15 * (1 - moving)) - st.limp * 0.07 * stance)
    this.pelvis.rotation.set(0, this.legYaw + 0.2 * Math.sin(this.phase) * moving, 0.09 * Math.sin(this.phase) * moving + st.limp * 0.12 * Math.cos(this.phase) * moving)

    // The spine: lean into the run and the strafe, flinch when hurt, struggle when held, gestures.
    const spineX =
      this.lean - 0.45 * hurt + 0.35 * shove - 0.22 * recoil + 1.0 * pick + 0.3 * squash - 0.2 * taunt + (p.riding ? 0.2 : 0) + idle * 0.025 * Math.sin(now * 1.6) + st.hunch + 0.55 * stress + 0.08 * dazed * Math.sin(now * 2.9)
    let spineY = 0
    let spineZ = this.sway + st.limp * 0.12 * stance + 0.16 * dazed * Math.sin(now * 4.3)
    // Winding up and turning into the throw, the other way round for the left hand.
    if (throwing) spineY = (last('throw')?.hand === 0 ? -1 : 1) * (throwT < 0.3 ? lerp(0, -0.7, throwT / 0.3) : throwT < 0.6 ? lerp(-0.7, 0.6, (throwT - 0.3) / 0.3) : lerp(0.6, 0, (throwT - 0.6) / 0.4))
    if (p.held) {
      spineZ += 0.2 * Math.sin(now * 10 + this.seed)
      spineY += 0.3 * Math.sin(now * 6.3 + this.seed)
    }
    this.spine.rotation.set(spineX, spineY, spineZ)
    this.chest.scale.y = 1 + idle * 0.02 * Math.sin(now * 1.6)

    // The head: with the aim, down to write, back when hurt, cocked to taunt, looking about when idle.
    const look = holding || p.writing ? 0 : idle * 0.25 * Math.sin(now * 0.31 + this.seed)
    // The head lags the body: back when it sets off, forward when it stops or lands, aside on a turn (a spring each way).
    this.spring(this.nod, -this.accel.z * 0.012 + 0.3 * squash, -this.accel.x * 0.012 + this.yawRate * 0.02, dt)
    const tremble = st.tremble + Math.max(0, stress - 0.7) * 3
    this.neck.rotation.set(
      -p.pitch * 0.6 + (p.writing ? 0.55 : 0) - 0.5 * hurt - 0.25 * taunt - 0.2 * recoil + st.neck - 0.3 * stress + this.nod.x + jitter(now, 21) * 0.03 * tremble + 0.18 * dazed * Math.cos(now * 3.7),
      look,
      0.35 * taunt + (p.held ? 0.25 * Math.sin(now * 8) : 0) + this.nod.z + 0.3 * dazed * Math.sin(now * 5.1),
    )
    this.stars.visible = dazed > 0.05
    if (this.stars.visible) {
      this.stars.rotation.y = now * 4.5
      this.stars.scale.setScalar(0.4 + 0.6 * dazed)
    }

    // Arms: first as they swing free, then what the hands are doing.
    this.root.updateMatrixWorld(true)
    const toSpine = new Matrix4().copy(this.spine.matrixWorld).invert().multiply(this.root.matrixWorld)
    /** A point in the doctor's own frame (feet at 0, standard metres, before height) in the spine's frame. */
    const spinePoint = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(toSpine)
    const reachTo = (i: number, target: Vector3) => {
      const side = i === 0 ? -1 : 1
      return reach(this.shoulders[i]!.position, target, JOINTS.upper, JOINTS.fore + JOINTS.palm, new Vector3(side * 0.5, -1, -0.35))
    }
    const arms = [0, 1].map((i) => {
      const side = i === 0 ? -1 : 1
      const l = legs[i]!
      // Swinging against the leg of its own side (with a little follow-through), as far as the gait swings them, hanging forward or out as it carries them; bent more running; out in the air.
      const sw = this.armSwing[i]!
      this.spring1(sw, -l.hip * 1.25 * (1 - this.air) * st.arms - st.armsForward - 0.35 * stress, dt)
      let a = armFK(sw.a, side * (0.08 + st.armsOut + 0.12 * run + 1.1 * this.air - 0.06 * stress), -(0.18 + 1.4 * run + 0.15 * moving) - 0.4 * this.air - 0.3 * st.armsForward)
      if (hurt > 0) a = blendArm(a, armFK(-0.5, side * 0.9, -0.7), hurt * 0.8)
      if (p.held) a = armFK(0.05, side * 0.03, -0.15)
      return a
    })
    // The hands at work: holding (a long thing in both hands when the other is free), riding, writing.
    const pitchS = Math.sin(p.pitch)
    const pitchC = Math.cos(p.pitch)
    // What is in hand sways: bobbing with the stride, lagging a turn and a start, kicking back on use, trembling with the hands.
    const carry = moving * st.stride
    for (const h of [0, 1] as const) {
      const sw = this.handSway[h]!
      const side = h === 1 ? -1 : 1
      const shiver = tremble * 0.006
      sw.at.set(
        side * 0.014 * Math.sin(this.phase) * carry + clamp(-this.yawRate * 0.025, -0.08, 0.08) + jitter(now, 30 + h) * shiver,
        -0.032 * Math.abs(Math.sin(this.phase)) * carry - 0.06 * squash + 0.07 * recoils[h]! - 0.05 * stress + jitter(now, 32 + h) * shiver,
        0.016 * Math.cos(2 * this.phase) * carry - 0.16 * recoils[h]! - clamp(this.accel.z * 0.004, -0.06, 0.06),
      )
      sw.tilt.set(-0.4 * recoils[h]! + 0.07 * Math.sin(this.phase) * carry + 0.15 * stress, clamp(this.yawRate * 0.06, -0.25, 0.25), 0.09 * Math.sin(this.phase + h) * carry)
    }
    if (holding && !p.riding && !p.held) {
      for (const h of [0, 1] as const) {
        const length = p.hands[h]
        if (length === null) continue
        // Each hand out to its own side (the right at -x), where its thing has swayed to.
        const side = h === 1 ? -1 : 1
        const sw = this.handSway[h]!.at
        const hold = { x: side * HOLD.right + sw.x, y: HOLD.eye - HOLD.down + HOLD.ahead * pitchS + sw.y, z: HOLD.ahead * pitchC + sw.z }
        arms[armOf(h)] = reachTo(armOf(h), spinePoint(hold.x, hold.y, hold.z))
        const other = h === 1 ? 0 : 1
        if (length > 0.45 && p.hands[other] === null) {
          const along = Math.min(0.32, length * 0.5)
          arms[armOf(other)] = reachTo(armOf(other), spinePoint(hold.x - side * 0.05, hold.y - 0.03 + along * pitchS, hold.z + along * pitchC))
        }
      }
    }
    if (p.riding) {
      arms[0] = reachTo(0, spinePoint(-0.2, 1.05, 0.42))
      arms[1] = reachTo(1, spinePoint(0.2, 1.05, 0.42))
    }
    if (p.writing && !p.held) {
      arms[1] = reachTo(1, spinePoint(0.1, 1.12, 0.3))
      arms[0] = reachTo(0, spinePoint(-0.07 + 0.035 * Math.sin(now * 13), 1.14 + 0.02 * Math.cos(now * 9.3), 0.33))
    }
    // Gestures over it all.
    if (shove > 0) for (const i of [0, 1]) arms[i] = blendArm(arms[i]!, armFK(-1.55, (i ? 1 : -1) * 0.05, -0.05), shove)
    if (pick > 0) {
      const a = armOf(last('pick')?.hand ?? 1)
      arms[a] = blendArm(arms[a]!, armFK(-1.1, a === 0 ? -0.15 : 0.15, -0.1), pick)
    }
    for (const h of [0, 1] as const) {
      const alt = g('alt', h)
      const a = armOf(h)
      if (alt > 0) arms[a] = { ...arms[a]!, wrist: arms[a]!.wrist + (a === 0 ? 0.9 : -0.9) * alt }
    }
    if (throwing) {
      const t = throwT
      const a = armOf(last('throw')?.hand ?? 1)
      const x = t < 0.3 ? lerp(0, 1.4, t / 0.3) : t < 0.55 ? lerp(1.4, -3.0, (t - 0.3) / 0.25) : lerp(-3.0, -0.8, (t - 0.55) / 0.45)
      const e = t < 0.3 ? lerp(-0.4, -1.4, t / 0.3) : t < 0.55 ? lerp(-1.4, -0.15, (t - 0.3) / 0.25) : -0.15
      arms[a] = blendArm(arms[a]!, armFK(x, a === 0 ? -0.25 : 0.25, e), envelope(t * LASTS.throw, LASTS.throw, 0.05, 0.25))
    }
    if (taunt > 0) {
      // A wagging finger raised, the other hand on the hip.
      arms[1] = blendArm(arms[1]!, armFK(-2.6 + 0.35 * Math.sin(now * 9), 0.3 + 0.25 * Math.sin(now * 7), -0.7, 1.0 * Math.sin(now * 15)), taunt)
      if (p.hands[1] === null) arms[0] = blendArm(arms[0]!, armFK(0.15, -0.75, -1.7), taunt)
    }

    // Trembling from an effect: a shiver at a little; at 1 the whole body jerks, the arms flung out stiff and the legs apart.
    const s = p.shake
    if (s > 0) {
      this.body.position.add(new Vector3(jitter(now, 1) * 0.03 * s, Math.max(0, jitter(now, 2)) * 0.045 * s, jitter(now, 3) * 0.03 * s))
      this.body.rotateX(jitter(now, 4) * 0.07 * s).rotateY(jitter(now, 5) * 0.1 * s).rotateZ(jitter(now, 6) * 0.09 * s)
      for (const i of [0, 1]) {
        const side = i === 0 ? -1 : 1
        arms[i] = blendArm(arms[i]!, armFK(jitter(now, 9 + i) * 0.6, side * (0.08 + 1.15 + jitter(now, 7 + i) * 0.35), -0.1), s)
        legs[i]!.hip += jitter(now, 11 + i) * 0.3 * s
        legs[i]!.side = (i === 0 ? -1 : 1) * 0.12 * s
      }
      this.neck.rotation.x += jitter(now, 14) * 0.25 * s
      this.neck.rotation.z += jitter(now, 13) * 0.3 * s
    }

    // The coat below the waist swings, and what is worn.
    this.swingClothes(dt, lx, vy, lz, legs, 0)

    // Down to the joints.
    for (const i of [0, 1]) {
      const l = legs[i]!
      this.hips[i]!.rotation.set(l.hip, 0, l.side)
      this.knees[i]!.rotation.set(l.knee, 0, 0)
      // The foot kept about level with the ground, toes down a little as it swings.
      this.ankles[i]!.rotation.set(-(l.hip + l.knee) * 0.85 + 0.15 * Math.max(0, -Math.cos(this.phase + i * Math.PI)) * moving, 0, 0)
      const a = arms[i]!
      this.shoulders[i]!.quaternion.copy(a.q)
      this.elbows[i]!.rotation.set(Math.min(0, a.elbow), 0, 0)
      this.wrists[i]!.rotation.set(0, 0, a.wrist)
    }

    // Getting up: from the joints as the ragdoll lay into this pose.
    const up = (now - this.ragAt) / GET_UP
    if (up < 1) {
      const kk = smooth(0, 1, up)
      for (const [joint, lay] of this.lay) joint.quaternion.copy(lay.clone().slerp(joint.quaternion, kk))
      this.body.position.lerpVectors(this.layAt, this.body.position, kk)
    }
  }

  /** How heavily a foot comes down (0 the right, 1 the left), by the gait: a lame foot lightly, a pompous one heavily. */
  stepWeight(foot: number): number {
    const st = this.style
    if (st.limp > 0 && foot === 0) return 0.45
    return st === STYLES.pompous ? 1.25 : st === STYLES.shuffle ? 0.6 : st === STYLES.doddery ? 0.7 : st === STYLES.hunched ? 0.85 : 1
  }

  /** A spring each way (x and z) toward a target, stepped finely. */
  private spring(s: { x: number; z: number; vx: number; vz: number }, tx: number, tz: number, dt: number): void {
    const n = Math.max(1, Math.ceil(dt * 120))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      s.vx += ((tx - s.x) * 90 - s.vx * 11) * h
      s.vz += ((tz - s.z) * 90 - s.vz * 11) * h
      s.x += s.vx * h
      s.z += s.vz * h
    }
    s.x = clamp(s.x, -0.6, 0.6)
    s.z = clamp(s.z, -0.5, 0.5)
  }

  /** One springy number toward a target: a little overshoot, then still. */
  private spring1(s: { a: number; v: number }, target: number, dt: number): void {
    const n = Math.max(1, Math.ceil(dt * 120))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      s.v += ((target - s.a) * 70 - s.v * 8) * h
      s.a += s.v * h
    }
  }

  /**
   * The coat below the waist, round each of its springs: thrown out by the body's acceleration
   * against it, by the air as it goes, by falling and turning; pushed out as far as the legs reach
   * (clearance); fluttering (0..1) as told. Each hem trails its spring on a softer one, flaring
   * further with the air, and the cloth bends to it; the skirt is draped again once a spring has
   * moved enough to see. Then what is worn swings (swing.ts).
   */
  private swingClothes(dt: number, lx: number, vy: number, lz: number, legs: { hip: number; knee: number }[], flutter: number): void {
    const clear = this.clearance(legs)
    const n = Math.max(1, Math.ceil(dt * 120))
    const h = dt / n
    for (const [i, s] of this.springs.entries()) {
      const nx = Math.sin(s.mid)
      const nz = Math.cos(s.mid)
      const out = clamp(-(this.accel.x * nx + this.accel.z * nz) * 0.03 - (lx * nx + lz * nz) * 0.045 + Math.max(0, -vy) * 0.05 + Math.abs(this.yawRate) * 0.06 + this.air * 0.12, -0.1, 1.2)
      const push = clear[i]!
      const target = 0.05 + out + flutter * (0.25 + 0.2 * Math.sin(this.last * 17 + i * 2.1))
      const lift = out * 0.35 + flutter * 0.3 * Math.sin(this.last * 23 + i * 1.3)
      for (let j = 0; j < n; j++) {
        s.speed += ((target - s.angle) * 90 - s.speed * 10) * h
        s.angle += s.speed * h
        if (s.angle < push) {
          s.angle = push
          s.speed = Math.max(s.speed, 0)
        }
        s.hemSpeed += ((s.angle + lift - s.hem) * 40 - s.hemSpeed * 4.5) * h
        s.hem += s.hemSpeed * h
      }
      s.angle = Math.min(s.angle, 1.4)
    }
    // Bent no further in than the leg behind it leaves room for.
    const now = this.springs.map((s) => ({ angle: s.angle, bend: clamp(s.hem - s.angle, -0.3, 0.9) }))
    if (now.some((x, i) => !(Math.abs(x.angle - this.draped[i]!.angle) < 0.003 && Math.abs(x.bend - this.draped[i]!.bend) < 0.004))) {
      drape(this.skirtGeometry, SKIRT, now)
      this.draped = now
    }
    for (const list of this.worn.values()) for (const w of list) w.swing.step(dt)
  }

  /**
   * How far out from hanging straight the cloth round each of the coat's springs must swing to
   * clear the legs as their hips and knees bend: points down each thigh and shin, in the hips'
   * frame, against the cloth hanging from the waist in the spring's direction. At most LEG_PUSH:
   * a running kick would throw the coat up like a bell; a heel kicked high shows through for a moment.
   */
  private clearance(legs: { hip: number; knee: number }[]): number[] {
    const b = this.build
    const girth = 0.085 * b
    const points = legs.flatMap((l, i) => {
      const x = (i === 0 ? -1 : 1) * JOINTS.hipX * b
      const knee = [-JOINTS.thigh * Math.sin(l.hip), -JOINTS.thigh * Math.cos(l.hip)] as const
      const shin = l.hip + l.knee
      return [
        ...[0.5, 1].map((f) => [x, knee[0] * f, knee[1] * f]),
        ...[1 / 3, 2 / 3].map((f) => [x, knee[0] - JOINTS.shin * f * Math.sin(shin), knee[1] - JOINTS.shin * f * Math.cos(shin)]),
      ]
    })
    return SPRINGS.map((θ, i) => {
      const [nx, nz] = [Math.sin(θ), Math.cos(θ)]
      let need = 0
      for (const [x, z, y] of points) {
        const below = SKIRT_Y - BODY.hips.y - y!
        if (below < 0.05 || below > SKIRT_LENGTH + 0.05) continue
        need = Math.max(need, Math.atan2(x! * nx + z! * nz + girth - SPRING_WAIST[i]! * b, below))
      }
      return Math.min(need, LEG_PUSH)
    })
  }

  /** Lies as the game's ragdoll lies: the pelvis joint at p, each part turned as q says (see RagSnap). */
  ragPose(p: Vec3, q: Quat[], yaw: number, size: number, hurt: number, now: number): void {
    // The coat flutters as the body flies.
    const dt = this.last < 0 ? 1 / 60 : clamp(now - this.last, 0, 0.1)
    const flying = dt > 0 && this.ragAt > now - 0.2 ? Math.min(1, new Vector3(...p).distanceTo(this.ragWas) / dt / 6) : 0
    this.ragWas.set(...p)
    this.swingClothes(dt, 0, 0, 0, [{ hip: 0, knee: 0 }, { hip: 0, knee: 0 }], flying)
    this.stars.visible = false
    this.last = now
    this.root.rotation.y = yaw
    this.root.scale.setScalar(size)
    this.colour({ hurt, glow: null, shake: 0 } as DoctorPose, now)
    applyRag(this, p, q)
    this.ragAt = now
    this.gestures.length = 0
    for (const j of [this.body, this.pelvis, this.spine, this.neck, ...this.hips, ...this.knees, ...this.ankles, ...this.shoulders, ...this.elbows, ...this.wrists]) {
      const saved = this.lay.get(j)
      if (saved) saved.copy(j.quaternion)
      else this.lay.set(j, j.quaternion.clone())
    }
    this.layAt.copy(this.body.position)
  }

  /** The hurt flash and an effect's glow, on the doctor's own colours. */
  private colour(p: DoctorPose, now: number): void {
    const flash = p.hurt < 0.18 ? 1 - p.hurt / 0.18 : 0
    let [gr, gg, gb] = [0, 0, 0]
    if (p.glow) {
      glowColor.set(p.glow)
      // Steady with a slow pulse; flickering while it trembles.
      const k = p.shake > 0 ? 0.35 + 0.9 * Math.abs(Math.sin(now * 57) * Math.sin(now * 21 + 0.7)) : 0.7 + 0.2 * Math.sin(now * 5)
      ;[gr, gg, gb] = [glowColor.r * k, glowColor.g * k, glowColor.b * k]
    }
    for (const m of Object.values(this.mats)) m.emissive.setRGB(Math.max(flash * 0.8, gr), gg, gb)
  }

  /** Shows or hides the body (a disguise hides it; the label goes with it). */
  showBody(on: boolean): void {
    this.body.visible = on
    this.tag.sprite.visible = on
  }

  dispose(): void {
    for (const w of this.worn.values()) w.forEach((x) => x.inst.dispose())
    this.skirtGeometry.dispose()
    for (const s of this.skeletons) s.dispose()
    for (const m of Object.values(this.mats)) (m as Material).dispose()
    this.tag.dispose()
    this.bubble.dispose()
    this.root.removeFromParent()
  }
}
