/**
 * The doctor's body and clothes as geometry, in the standard doctor's measures (feet at y 0,
 * facing +z, its left at +x); doctor.ts puts them on its joints and moves them. Smooth surfaces
 * lofted through rings rather than boxes and cylinders, so nothing has a corner a body or cloth
 * would not have (2026-11-11: "a lot of hard corners, the arms look like tubes, and many things
 * are pointy and sharp"):
 *
 * - the coat fitted over the chest and the shoulders, buttoned to the chest and open above in a V
 *   with lapels folded back; skinned to the hips and the chest, so it bends at the waist as cloth;
 * - its skirt one piece of cloth hanging from the waist, flaring and bending as four springs round
 *   it say (drape), open in front below the buttons;
 * - sleeves and trouser legs that swell at the shoulder and the hip, taper and bend at the elbow
 *   and the knee (skinned to the joint above and below), with a turned hem;
 * - pockets sewn on, sinking into the cloth at their rims; hands with a thumb and four fingers.
 */

import { BufferAttribute, BufferGeometry, CapsuleGeometry, ExtrudeGeometry, Float32BufferAttribute, LatheGeometry, Matrix4, Quaternion, Shape, SphereGeometry, Uint16BufferAttribute, Vector2, Vector3 } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { BODY } from '../doctor'

/** The joints on the standard doctor, metres: lengths run from joint to joint. */
export const JOINTS = {
  hipX: 0.1,
  thigh: 0.44,
  shin: 0.43,
  /** Where the spine bends. */
  waist: 1.0,
  neck: 1.49,
  upper: 0.3,
  fore: 0.26,
  /** From the wrist to the middle of the hand. */
  palm: 0.05,
} as const
/** The ankle's height when standing. */
export const ANKLE = BODY.hips.y - JOINTS.thigh - JOINTS.shin

const TAU = Math.PI * 2
const smooth = (lo: number, hi: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/**
 * A surface through rings of points, top to bottom, each ring running round the way a polar
 * angle from +z toward +x grows: indexed, so it is smoothly lit, and facing out. A closed ring
 * joins its last point to its first.
 */
function loft(rings: Vector3[][], closed: boolean): BufferGeometry {
  const n = rings[0]!.length
  const pos: number[] = []
  for (const ring of rings) {
    if (ring.length !== n) throw new Error('a loft needs rings of one length')
    for (const p of ring) pos.push(p.x, p.y, p.z)
  }
  const index: number[] = []
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < (closed ? n : n - 1); j++) {
      const a = i * n + j
      const b = i * n + ((j + 1) % n)
      index.push(a, a + n, b, b, a + n, b + n)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

/** A point at polar angle θ (from +z toward +x), r from the middle, at height y. */
const polar = (θ: number, r: number, y: number) => new Vector3(Math.sin(θ) * r, y, Math.cos(θ) * r)

/**
 * A value along keys [at, ...values] sorted by at, the k-th value, smoothly between them
 * (Catmull-Rom), held at the ends.
 */
function along(keys: readonly (readonly number[])[], at: number, k: number): number {
  const last = keys.length - 1
  if (at <= keys[0]![0]!) return keys[0]![k]!
  if (at >= keys[last]![0]!) return keys[last]![k]!
  let i = 0
  while (keys[i + 1]![0]! < at) i++
  const t = (at - keys[i]![0]!) / (keys[i + 1]![0]! - keys[i]![0]!)
  const [p0, p1, p2, p3] = [keys[Math.max(0, i - 1)]![k]!, keys[i]![k]!, keys[i + 1]![k]!, keys[Math.min(last, i + 2)]![k]!]
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
}

/**
 * The distance from the middle of a body's cross-section, a rounded square (between an ellipse
 * and a box) half `a` wide, `front` deep in front and `back` behind, at polar angle θ.
 */
function section(θ: number, a: number, front: number, back: number): number {
  const s = Math.abs(Math.sin(θ)) / a
  const c = Math.abs(Math.cos(θ)) / (Math.cos(θ) >= 0 ? front : back)
  return (s ** 2.4 + c ** 2.4) ** (-1 / 2.4)
}

/** Joint weights for each vertex of a geometry: the joints it goes with (by index, at most four) and how much with each, adding up to 1. */
function skin(g: BufferGeometry, weigh: (p: Vector3) => [number, number][]): BufferGeometry {
  const pos = g.getAttribute('position')
  const index = new Uint16Array(pos.count * 4)
  const weight = new Float32Array(pos.count * 4)
  const p = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    weigh(p.fromBufferAttribute(pos, i)).forEach(([joint, w], k) => {
      index[i * 4 + k] = joint
      weight[i * 4 + k] = w
    })
  }
  g.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4))
  g.setAttribute('skinWeight', new Float32BufferAttribute(weight, 4))
  return g
}

/**
 * A patch sewn on cloth whose distance from the middle at (θ, y) is `cloth`: a rectangle round
 * polar angle θ0 and height y0, halfW metres across and halfH up and down, its lower corners
 * rounded; raised `lift` off the cloth, sinking into it at the sides and the bottom, its top edge
 * left open, as a pocket's is.
 */
function sewn(cloth: (θ: number, y: number) => number, θ0: number, y0: number, halfW: number, halfH: number, lift: number): BufferGeometry {
  const rings: Vector3[][] = []
  for (let i = 0; i <= 8; i++) {
    const t = 1 - i / 4
    const ring: Vector3[] = []
    for (let j = 0; j <= 8; j++) {
      const s = j / 4 - 1
      // Below the middle the square is pulled in to a rounded one.
      const k = t < 0 ? Math.max(Math.abs(s), Math.abs(t)) / (s ** 4 + t ** 4) ** 0.25 : 1
      const y = y0 + t * k * halfH
      const θ = θ0 + (s * k * halfW) / cloth(θ0, y)
      const rim = Math.max(Math.abs(s * k), Math.max(0, -t * k))
      ring.push(polar(θ, cloth(θ, y) + 0.0015 + lift * (1 - rim ** 6), y))
    }
    rings.push(ring)
  }
  return loft(rings, false)
}

// ------------------------------------------------------------------------------ the coat above the waist

/**
 * The coat round the trunk: [y, half-width, depth in front, depth behind], from inside the skirt
 * up to the neck. Above the armpits it widens over the top of each sleeve, as a coat's shoulder
 * does, the sleeve coming out from under it.
 */
const TRUNK: readonly (readonly number[])[] = [
  [0.9, 0.172, 0.13, 0.125],
  [1.0, 0.174, 0.132, 0.126],
  [1.1, 0.177, 0.137, 0.128],
  [1.2, 0.181, 0.143, 0.131],
  [1.28, 0.185, 0.146, 0.132],
  [1.33, 0.19, 0.143, 0.131],
  [1.38, 0.212, 0.136, 0.127],
  [1.42, 0.24, 0.125, 0.119],
  [1.45, 0.245, 0.112, 0.108],
  [1.475, 0.222, 0.098, 0.095],
  [1.495, 0.17, 0.085, 0.083],
  [1.508, 0.115, 0.073, 0.072],
  [1.517, 0.075, 0.064, 0.064],
]
/** The coat's distance from the middle at polar angle θ and height y. */
export const trunk = (θ: number, y: number) => section(θ, along(TRUNK, y, 1), along(TRUNK, y, 2), along(TRUNK, y, 3))
/** Where the coat opens above its buttons, and how far round from the front each edge is at height y (radians). */
const V_FROM = 1.2
const opening = (y: number) => 0.012 + 0.78 * smooth(V_FROM, 1.49, y) ** 1.15
/** Below this the coat goes with the hips, above the next with the chest, bending between them. */
const WAIST_BEND = [0.95, 1.08] as const
/** How much of the coat over each shoulder goes with the arm under it, out from beside the lapels. */
const SHOULDER_PULL = 0.55

/** Rings round the cloth from one front edge to the other, each edge turned in a little, as cloth with a thickness. */
function openRing(cloth: (θ: number) => number, edge: number, y: number, cols: number): Vector3[] {
  const ring = [polar(edge, cloth(edge) - 0.007, y)]
  for (let j = 0; j <= cols; j++) {
    const θ = edge + ((TAU - 2 * edge) * j) / cols
    ring.push(polar(θ, cloth(θ), y))
  }
  ring.push(polar(TAU - edge, cloth(TAU - edge) - 0.007, y))
  return ring
}

/**
 * The coat above the waist, in the doctor's own frame, its joints the hips (0), the chest (1) and
 * the upper arms, right (2) and left (3): over each shoulder it goes partly with the arm, so the
 * shoulder moves as the arm does.
 */
export const COAT = (() => {
  const rings: Vector3[][] = []
  for (let y = TRUNK[0]![0]!; y < 1.5171; y += 0.017) rings.unshift(openRing((θ) => trunk(θ, y), opening(y), y, 48))
  return skin(loft(rings, false), (p) => {
    const chest = smooth(WAIST_BEND[0], WAIST_BEND[1], p.y)
    const arm = SHOULDER_PULL * smooth(0.19, 0.24, Math.abs(p.x)) * smooth(1.34, 1.42, p.y)
    return [
      [0, (1 - chest) * (1 - arm)],
      [1, chest * (1 - arm)],
      [p.x < 0 ? 2 : 3, arm],
    ]
  })
})()

/** The shirt under the coat, seen in its V. */
export const SHIRT = (() => {
  const rings: Vector3[][] = []
  for (let y = 1.1; y < 1.5201; y += 0.035) {
    // As narrow at the shoulders as below them: the coat's shoulders move with the arms, over nothing.
    const at = Math.min(y, 1.505)
    const shirt = (θ: number) => section(θ, Math.min(along(TRUNK, at, 1), 0.185), along(TRUNK, at, 2), along(TRUNK, at, 3)) - 0.013
    rings.unshift(Array.from({ length: 28 }, (_, j) => polar((TAU * j) / 28, shirt((TAU * j) / 28), y)))
  }
  return loft(rings, true)
})()

/**
 * The lapels, left and right: folded back from the edges of the V, widening up the chest to a
 * notch below the collarbone, rolled over the coat's edge where they fold and lying on it at their
 * outer edge.
 */
export const LAPELS = (() => {
  const halves = [1, -1].map((side) => {
    const rings: Vector3[][] = []
    for (let i = 0; i <= 16; i++) {
      const y = 1.475 - ((1.475 - V_FROM) * i) / 16
      const width = 0.075 * smooth(V_FROM, 1.38, y) - 0.03 * smooth(1.42, 1.475, y) + 0.004
      const edge = opening(y)
      const ring: Vector3[] = []
      // From the fold (rolled round the coat's edge) out to where it lies on the coat.
      for (let j = -1; j <= 6; j++) {
        const s = Math.max(0, j) / 6
        const θ = edge + (j < 0 ? -0.025 : (s * width) / trunk(edge, y))
        const r = trunk(θ, y) + (j < 0 ? -0.002 : 0.0015 + 0.0055 * (1 - s * s))
        ring.push(polar(side > 0 ? θ : TAU - θ, r, y))
      }
      rings.push(side > 0 ? ring : ring.reverse())
    }
    return loft(rings, false)
  })
  return mergeGeometries(halves)!
})()

/** The breast pocket on the doctor's right, and where the pens stand in it (their middles). */
const BREAST = { θ: TAU - 0.95, y: 1.215, halfW: 0.05, halfH: 0.05 }
export const BREAST_POCKET = sewn(trunk, BREAST.θ, BREAST.y, BREAST.halfW, BREAST.halfH, 0.004)
export const PEN_AT = [-0.45, -0.05, 0.3].map((k) => {
  const θ = BREAST.θ + (k * BREAST.halfW) / trunk(BREAST.θ, BREAST.y)
  return polar(θ, trunk(θ, BREAST.y) + 0.0045, BREAST.y + 0.035 - Math.abs(k) * 0.01)
})
/** The coat's buttons below the V, and the shirt's in it. */
export const COAT_BUTTONS = [1.1, 1.17].map((y) => polar(0, trunk(0, y) + 0.004, y))
export const SHIRT_BUTTONS = [1.29, 1.36, 1.43].map((y) => polar(0, trunk(0, y) - 0.01, y))

// ------------------------------------------------------------------------------ the skirt

/** The skirt hangs from the waist at this height, down to the coat's hem. */
export const SKIRT_Y = JOINTS.waist
export const SKIRT_LENGTH = SKIRT_Y - BODY.coat.bottom
/** How far down from the waist the cloth bends (below the pockets). */
export const BEND_FROM = 0.3
/** The skirt round the hips by depth below the waist: [u, half-width, depth in front, depth behind], flaring to the hem. */
const HANG: readonly (readonly number[])[] = [
  [0, 0.177, 0.135, 0.129],
  [0.08, 0.187, 0.146, 0.137],
  [0.16, 0.194, 0.153, 0.143],
  [0.3, 0.2, 0.158, 0.148],
  [SKIRT_LENGTH, 0.208, 0.164, 0.154],
]
const hang = (θ: number, u: number) => section(θ, along(HANG, u, 1), along(HANG, u, 2), along(HANG, u, 3))
/** Where the skirt opens in front, wider toward the hem. */
const skirtOpening = (u: number) => 0.012 + 0.32 * smooth(0.1, SKIRT_LENGTH, u)
/** The polar angles the skirt's four springs pull at, round its open front: left front, left back, right back, right front. */
export const SPRINGS = [0, 1, 2, 3].map((i) => 0.42 + ((i + 0.5) * (TAU - 0.84)) / 4)
/** How far the waist is from the middle where each spring pulls. */
export const SPRING_WAIST = SPRINGS.map((θ) => hang(θ, 0))

/**
 * The skirt as made, and for each vertex what drape needs: its polar angle, its distance below the
 * waist and out from the waist's ring (waist: the ring's distance from the middle there), how far
 * out the cloth is where it starts to bend and how it slants out from there to the hem, and the
 * springs it moves between.
 */
export interface SkirtRest {
  geometry: BufferGeometry
  theta: Float32Array
  below: Float32Array
  out: Float32Array
  waist: Float32Array
  outAtBend: Float32Array
  slant: Float32Array
  from: Uint8Array
  to: Uint8Array
  toward: Float32Array
}

/** The skirt in its own frame (the waist's middle at the origin), with a pocket on each front and its hem turned in. */
export const SKIRT: SkirtRest = (() => {
  const rings: Vector3[][] = []
  const depths = [0, 0.03, 0.07, 0.12, 0.18, 0.24, 0.3, 0.34, 0.38, 0.42, 0.46, 0.5, 0.54, SKIRT_LENGTH]
  for (const u of depths) rings.push(openRing((θ) => hang(θ, u), skirtOpening(u), -u, 48))
  const edge = skirtOpening(SKIRT_LENGTH)
  rings.push(openRing((θ) => hang(θ, SKIRT_LENGTH) - 0.008, edge, -SKIRT_LENGTH + 0.006, 48))
  const cloth = (θ: number, y: number) => hang(θ, -y)
  // A pocket on each front, and a half-belt across the back at the waist.
  const sewnOn = [sewn(cloth, 0.98, -0.27, 0.065, 0.065, 0.005), sewn(cloth, TAU - 0.98, -0.27, 0.065, 0.065, 0.005), sewn(cloth, Math.PI, -0.022, 0.1, 0.018, 0.004)]
  const geometry = mergeGeometries([loft(rings, false), ...sewnOn])!
  const pos = geometry.getAttribute('position')
  const n = pos.count
  const rest: SkirtRest = { geometry, theta: new Float32Array(n), below: new Float32Array(n), out: new Float32Array(n), waist: new Float32Array(n), outAtBend: new Float32Array(n), slant: new Float32Array(n), from: new Uint8Array(n), to: new Uint8Array(n), toward: new Float32Array(n) }
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)]
    const θ = (Math.atan2(x, z) + TAU) % TAU
    rest.theta[i] = θ
    rest.below[i] = -y
    rest.waist[i] = hang(θ, 0)
    rest.out[i] = Math.hypot(x, z) - rest.waist[i]!
    rest.outAtBend[i] = hang(θ, BEND_FROM) - rest.waist[i]!
    rest.slant[i] = Math.atan2(hang(θ, SKIRT_LENGTH) - hang(θ, BEND_FROM), SKIRT_LENGTH - BEND_FROM)
    let s = 0
    while (s < 3 && θ > SPRINGS[s + 1]!) s++
    rest.from[i] = s
    rest.to[i] = Math.min(3, s + 1)
    rest.toward[i] = θ <= SPRINGS[0]! || s === 3 ? 0 : smooth(SPRINGS[s]!, SPRINGS[s + 1]!, θ)
  }
  return rest
})()

/**
 * The skirt hung as its springs say, into `out` (a copy of the rest geometry): each spring swings
 * the cloth round it out by `angle` from hanging straight (in by less than 0), and bends it out by
 * `bend` more at the hem, from BEND_FROM down, the cloth keeping its length; between springs the
 * cloth goes smoothly from one to the next.
 */
export function drape(out: BufferGeometry, rest: SkirtRest, springs: readonly { angle: number; bend: number }[]): void {
  const pos = out.getAttribute('position') as BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const a = springs[rest.from[i]!]!
    const b = springs[rest.to[i]!]!
    const k = rest.toward[i]!
    const angle = a.angle + (b.angle - a.angle) * k
    const bend = a.bend + (b.bend - a.bend) * k
    const u = rest.below[i]!
    const z = rest.out[i]!
    // In the upright plane through the cloth's own angle: down and out from the waist's ring.
    let y = -u
    let o = z
    const c = bend / (SKIRT_LENGTH - BEND_FROM)
    if (u > BEND_FROM && Math.abs(c) > 1e-6) {
      // Along the cloth as it slants from where it bends (how far down it, how far off it), curved by the bend.
      const [cb, sb] = [Math.cos(rest.slant[i]!), Math.sin(rest.slant[i]!)]
      const [dy, dout] = [BEND_FROM - u, z - rest.outAtBend[i]!]
      const down = -dy * cb + dout * sb
      const off = dy * sb + dout * cb
      const phi = c * down
      const Y = -Math.sin(phi) / c + off * Math.sin(phi)
      const O = (1 - Math.cos(phi)) / c + off * Math.cos(phi)
      y = -BEND_FROM + Y * cb + O * sb
      o = rest.outAtBend[i]! - Y * sb + O * cb
    }
    const [ca, sa] = [Math.cos(angle), Math.sin(angle)]
    const θ = rest.theta[i]!
    const r = rest.waist[i]! - y * sa + o * ca
    pos.setXYZ(i, Math.sin(θ) * r, y * ca + o * sa, Math.cos(θ) * r)
  }
  pos.needsUpdate = true
  out.computeVertexNormals()
}

// ------------------------------------------------------------------------------ sleeves and trouser legs

/**
 * A limb hanging down its own -y from its pivot: a dome round the pivot (so it turns there as a
 * ball in a socket), then rings of the radii given [y, r], ending in a hem turned up inside.
 * Skinned to the joint above (0) and the one below (1), bending between `bend` y's.
 */
function limb(radii: readonly (readonly number[])[], bend: readonly [number, number]): BufferGeometry {
  const rings: Vector3[][] = []
  const ring = (r: number, y: number) => Array.from({ length: 20 }, (_, j) => polar((TAU * j) / 20, r, y))
  const top = radii[0]![1]!
  // Closed at the top all but a pinhole, as a raised arm shows it under the shoulder; a little flattened, under the coat's shoulder.
  for (const a of [0.02, 0.3, 0.6, 0.9, 1.2, Math.PI / 2]) rings.push(ring(top * Math.sin(a), 0.7 * top * Math.cos(a)))
  for (const [y, r] of radii.slice(1)) rings.push(ring(r!, y!))
  const [y, r] = radii.at(-1)!
  rings.push(ring(r! - 0.004, y! - 0.003), ring(r! - 0.009, y!), ring(r! - 0.01, y! + 0.05))
  return skin(loft(rings, true), (p) => {
    const k = smooth(bend[0], bend[1], -p.y)
    return [
      [0, 1 - k],
      [1, k],
    ]
  })
}

/** A sleeve from the shoulder: swelling over it, tapering to the elbow and the forearm, a little wider at the cuff. */
export const SLEEVE = limb(
  [
    [0, 0.067],
    [-0.06, 0.067],
    [-0.15, 0.066],
    [-JOINTS.upper, 0.062],
    [-0.4, 0.06],
    [-0.5, 0.061],
    [-JOINTS.upper - JOINTS.fore + 0.005, 0.064],
  ],
  [JOINTS.upper - 0.05, JOINTS.upper + 0.05],
)
/** Inside the elbow, filling the sleeve's outside as it bends. */
export const ELBOW = new SphereGeometry(0.057, 12, 8)
/** The shirt's cuff, just out of the sleeve, from the elbow. */
export const CUFF = new LatheGeometry(
  [
    [0.04, -JOINTS.fore - 0.018],
    [0.046, -JOINTS.fore - 0.013],
    [0.048, -JOINTS.fore],
    [0.047, -JOINTS.fore + 0.025],
  ].map(([r, y]) => new Vector2(r, y)),
  20,
)
/** A trouser leg from the hip: full over the thigh, narrowing to the knee and the ankle, its hem on the shoe. */
export const TROUSER_LEG = limb(
  [
    [0, 0.085],
    [-0.08, 0.084],
    [-0.2, 0.08],
    [-0.35, 0.073],
    [-JOINTS.thigh, 0.069],
    [-0.55, 0.066],
    [-0.7, 0.063],
    [-0.8, 0.064],
    [-JOINTS.thigh - JOINTS.shin - 0.005, 0.067],
  ],
  [JOINTS.thigh - 0.05, JOINTS.thigh + 0.05],
)
/** Inside the knee, as the elbow. */
export const KNEE = new SphereGeometry(0.064, 12, 8)
/** The seat of the trousers, between the hips. */
export const SEAT = new SphereGeometry(1, 16, 10).scale(0.17, 0.11, 0.125).translate(0, 0.02, 0)

// ------------------------------------------------------------------------------ hands and feet

/**
 * The left hand, hanging from the wrist: the palm toward the body (-x), four fingers curled a
 * little toward it, the index finger in front, and the thumb forward and in. The right is it
 * mirrored.
 */
export const HAND = (() => {
  const parts: BufferGeometry[] = []
  const down = new Vector3(0, -1, 0)
  const put = (g: BufferGeometry, at: Vector3, dir: Vector3, scale = new Vector3(1, 1, 1)) => parts.push(g.applyMatrix4(new Matrix4().compose(at, new Quaternion().setFromUnitVectors(down, dir), scale)))
  put(new SphereGeometry(1, 12, 8), new Vector3(0.002, -0.045, 0.002), down, new Vector3(0.024, 0.042, 0.04))
  for (const [z, length] of [
    [0.026, 0.03],
    [0.009, 0.033],
    [-0.008, 0.031],
    [-0.024, 0.025],
  ] as const) {
    let at = new Vector3(0, -0.078, z)
    let curl = 0.25
    for (const [l, r] of [
      [length, 0.0115],
      [length * 0.8, 0.0105],
    ] as const) {
      const dir = new Vector3(-Math.sin(curl), -Math.cos(curl), 0)
      put(new CapsuleGeometry(r, l, 2, 6).translate(0, -l / 2, 0), at, dir)
      at = at.clone().addScaledVector(dir, l)
      curl += 0.55
    }
  }
  put(new CapsuleGeometry(0.0125, 0.034, 2, 6).translate(0, -0.017, 0), new Vector3(-0.008, -0.03, 0.03), new Vector3(-0.45, -0.6, 0.66).normalize())
  return mergeGeometries(parts)!
})()
/** A shoe's sole under the ankle: the foot's outline, broader at the toe than the heel, its edges rounded. */
export const SOLE = (() => {
  const outline = Array.from({ length: 24 }, (_, i) => {
    const t = (TAU * i) / 24
    const [c, s] = [Math.cos(t), Math.sin(t)]
    // x across, z along (toe ahead at +z): a rounded oblong, wider toward the toe.
    const half = 0.054 + 0.01 * Math.max(0, c)
    return new Vector2(half * Math.sign(s) * Math.abs(s) ** 0.8, 0.045 + 0.148 * Math.sign(c) * Math.abs(c) ** 0.8)
  })
  return new ExtrudeGeometry(new Shape(outline), { depth: 0.012, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelOffset: -0.004, bevelSegments: 2, curveSegments: 4 })
    .rotateX(Math.PI / 2)
    .translate(0, 0.02 - ANKLE, 0)
})()
/** A shoe over the sole. */
export const SHOE = new SphereGeometry(0.075, 16, 10).scale(0.85, 0.6, 1.9).translate(0, 0.06 - ANKLE, 0.05)
