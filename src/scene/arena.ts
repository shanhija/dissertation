/**
 * An arena as drawn. Every solid and every placed model becomes geometry in its place, with box
 * mapped texture coordinates and its colour per corner, merged into one mesh per surface (and
 * per mover), so an arena of a thousand pieces is a few dozen draw calls. Boxes are bevelled,
 * round things are smooth. A breakable piece that breaks is folded out of the merged meshes (its
 * corners all moved to one point), with no merging again. Around it: a sky dome (its colours from
 * the arena's sky, a sun glow and drifting clouds), the arena's lamps, and dust hanging in the light.
 */

import {
  AdditiveBlending,
  BackSide,
  Box3,
  BufferGeometry,
  type BufferAttribute,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { partTransform } from '../model/kit'
import type { ArenaSolid, ArenaView, MaterialName, Recipe, Vec3 } from '../protocol'
import { flowSurfaces, prepared, surface } from './materials'
import { GLOW, modelOf } from './models'
import { openSky } from './place'
import { framed } from './portrait'
import { Sightlines } from './sightlines'

/** What a portrait shows: the doctor at a rank (0 leads the match), painted, and their name; null when nobody is there to paint. */
export type PortraitOf = (rank: number) => { picture: Texture; name: string } | null

function rampGeometry(w: number, h: number, d: number): BufferGeometry {
  const x = w / 2
  const y = h / 2
  const z = d / 2
  const v: Vec3[] = [
    [-x, -y, -z],
    [x, -y, -z],
    [-x, -y, z],
    [x, -y, z],
    [-x, y, z],
    [x, y, z],
  ]
  const tris = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 0, 4, 5, 0, 5, 1, 0, 2, 4, 1, 5, 3]
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(tris.flatMap((i) => v[i]!), 3))
  g.computeVertexNormals()
  return g
}

/** A solid's own geometry, centred, at its size: boxes with bevelled edges, round things smooth. */
function solidGeometry(s: ArenaSolid): BufferGeometry {
  const [x, y, z] = s.size
  switch (s.kind) {
    case 'box': {
      const r = Math.min(0.06, Math.min(x, y, z) * 0.12)
      return r > 0.008 ? new RoundedBoxGeometry(x, y, z, 2, r) : new RoundedBoxGeometry(x, y, z, 1, 0.001)
    }
    case 'ramp':
      return rampGeometry(x, y, z)
    case 'cylinder':
      return new CylinderGeometry(x, x, y, Math.max(12, Math.min(48, Math.round(x * 18))))
    case 'sphere':
      return new SphereGeometry(x, Math.max(16, Math.min(40, Math.round(x * 14))), Math.max(10, Math.min(28, Math.round(x * 10))))
  }
}

const SKY_VERTEX = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`

const SKY_FRAGMENT = `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 bottom;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float time;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { s += noise(p) * a; p *= 2.03; a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, bottom, pow(-h, 0.35));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 600.0) * 3.0 + pow(s, 16.0) * 0.22 + pow(s, 3.0) * 0.06);
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 0.9 + vec2(time * 0.004, time * 0.0015);
    float c = smoothstep(0.52, 0.8, fbm(uv * 1.3));
    vec3 cloud = mix(horizon * 1.15, sunColor * 0.9 + horizon * 0.3, pow(s, 4.0));
    col = mix(col, cloud, c * 0.55 * smoothstep(0.0, 0.18, h));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export class ArenaScene {
  readonly root = new Group()
  readonly movers = new Map<string, Group>()
  /** The static part's extent, for the shadows and the dust. */
  readonly bounds = new Box3()
  readonly horizon: Color
  readonly sunDir: Vector3
  private readonly sky: Mesh<SphereGeometry, ShaderMaterial>
  private readonly dust: Points | null = null
  private readonly dustBase: Float32Array | null = null
  private readonly geometries: BufferGeometry[] = []
  /** Where each breakable piece not yet broken is in the merged meshes: a run of corners in a position attribute. */
  private readonly pieces = new Map<string, { attr: BufferAttribute; start: number; count: number }[]>()

  private readonly disposers: (() => void)[] = []
  /** The arena's lamps as made, for the lighting tab to scale. */
  readonly lamps: { light: PointLight; power: number; range: number }[] = []
  /** How much of it is open to the sky, 0 roofed over to 1 (place.ts): what light from all round it gets. */
  readonly skyOpen: number
  /** What hides one doctor from another (sightlines.ts). */
  readonly sightlines: Sightlines

  constructor(view: ArenaView, models: ReadonlyMap<string, Recipe>, dust: boolean, portraitOf: PortraitOf = () => null) {
    for (const id of view.movers) {
      const g = new Group()
      this.movers.set(id, g)
      this.root.add(g)
    }
    // Geometry by where it goes (null: the arena itself; else a mover) and by surface, each with the breakable piece it is part of.
    type Part = { g: BufferGeometry; piece: string | null }
    const lists = new Map<string | null, { surfaces: Map<MaterialName, Part[]>; glow: Part[] }>()
    const listFor = (mover: string | null) => {
      let l = lists.get(mover)
      if (!l) {
        l = { surfaces: new Map(), glow: [] }
        lists.set(mover, l)
      }
      return l
    }
    const put = (mover: string | null, name: MaterialName, part: Part) => {
      const l = listFor(mover)
      let arr = l.surfaces.get(name)
      if (!arr) {
        arr = []
        l.surfaces.set(name, arr)
      }
      arr.push(part)
    }
    /** One mesh's geometry from its parts, noting where each piece's corners went. */
    const merge = (parts: Part[]): BufferGeometry | null => {
      const merged = mergeGeometries(
        parts.map((p) => p.g),
        false,
      )
      let start = 0
      for (const p of parts) {
        const count = p.g.getAttribute('position').count
        if (merged && p.piece) {
          let runs = this.pieces.get(p.piece)
          if (!runs) this.pieces.set(p.piece, (runs = []))
          runs.push({ attr: merged.getAttribute('position') as BufferAttribute, start, count })
        }
        start += count
        p.g.dispose()
      }
      if (merged) this.geometries.push(merged)
      return merged
    }
    const m4 = new Matrix4()
    const part = new Matrix4()
    const q4 = new Quaternion()
    const e = new Euler()
    const one = new Vector3(1, 1, 1)
    const at = new Vector3()

    for (const s of view.solids) {
      m4.compose(at.set(...s.at), q4.setFromEuler(e.set(s.rot[0], s.rot[1], s.rot[2], 'XYZ')), one)
      const source = solidGeometry(s)
      const g = prepared(source, m4, s.material, s.color)
      source.dispose()
      put(s.mover, s.material, { g, piece: s.piece })
      if (!s.mover) {
        g.computeBoundingBox()
        this.bounds.union(g.boundingBox!)
      }
    }
    for (const d of view.decor) {
      const recipe = models.get(d.model)
      if (!recipe) continue
      const model = modelOf(recipe)
      m4.compose(at.set(...d.at), q4.setFromEuler(e.set(d.rot[0], d.rot[1], d.rot[2], 'XYZ')), new Vector3(d.scale, d.scale, d.scale))
      for (const [name, geo] of model.parts) {
        const t = partTransform(recipe.parts, name)
        const r = t.r
        part.set(r[0], r[1], r[2], t.p[0], r[3], r[4], r[5], t.p[1], r[6], r[7], r[8], t.p[2], 0, 0, 0, 1)
        const full = m4.clone().multiply(part)
        if (geo.solid) put(d.mover, d.material, { g: prepared(geo.solid, full, d.material, null), piece: d.piece })
        if (geo.glow) listFor(d.mover).glow.push({ g: prepared(geo.glow, full, 'plain', null), piece: d.piece })
      }
    }
    // What stays, but glass: its roofs, and what stands between one doctor and another.
    const roofs: BufferGeometry[] = []
    for (const [mover, l] of lists) {
      const parent = mover ? this.movers.get(mover)! : this.root
      for (const [name, arr] of l.surfaces) {
        const merged = merge(arr)
        if (!merged) continue
        if (!mover && name !== 'glass') roofs.push(merged)
        const mesh = new Mesh(merged, surface(name))
        mesh.castShadow = name !== 'glass' && name !== 'water'
        mesh.receiveShadow = true
        parent.add(mesh)
      }
      if (l.glow.length) {
        const merged = merge(l.glow)
        if (merged) parent.add(new Mesh(merged, GLOW))
      }
    }
    if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-30, -1, -30), new Vector3(30, 10, 30))
    this.skyOpen = openSky(roofs, this.bounds)
    this.sightlines = new Sightlines(roofs)

    // The doctors' portraits.
    for (const p of view.portraits ?? []) {
      const who = portraitOf(p.rank)
      const { group, dispose } = framed(who?.picture ?? null, who?.name ?? null, p.size)
      group.position.set(...p.at)
      group.rotation.set(p.rot[0], p.rot[1], p.rot[2], 'XYZ')
      ;(p.mover ? this.movers.get(p.mover)! : this.root).add(group)
      this.disposers.push(dispose)
    }

    // The lamps.
    for (const l of view.lights) {
      // Bright enough to pool light round itself, never brighter than the sun on what is near it.
      const light = new PointLight(l.color, l.power * 16, l.range, 1.5)
      light.position.set(...l.at)
      ;(l.mover ? this.movers.get(l.mover)! : this.root).add(light)
      this.lamps.push({ light, power: l.power * 16, range: l.range })
    }

    // The sky: darker above, lighter at the horizon, the ground colour below.
    const sky = new Color(view.sky.color)
    this.horizon = sky.clone().lerp(new Color('#ffffff'), 0.3)
    const topColor = sky.clone().multiplyScalar(0.6)
    const bottom = new Color(view.sky.ground).multiplyScalar(0.6)
    this.sunDir = new Vector3(0.45, 0.72, 0.35).normalize()
    this.sky = new Mesh(
      new SphereGeometry(900, 32, 16),
      new ShaderMaterial({
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: topColor },
          horizon: { value: this.horizon },
          bottom: { value: bottom },
          sunDir: { value: this.sunDir },
          sunColor: { value: new Color(view.sky.light) },
          time: { value: 0 },
        },
      }),
    )
    this.sky.renderOrder = -1
    this.sky.frustumCulled = false
    this.root.add(this.sky)

    // Dust hanging in the air, catching the light.
    if (dust) {
      const n = 900
      const size = this.bounds.getSize(new Vector3())
      const base = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        base[i * 3] = this.bounds.min.x + Math.random() * size.x
        base[i * 3 + 1] = this.bounds.min.y + 0.3 + Math.random() * Math.min(12, Math.max(3, size.y))
        base[i * 3 + 2] = this.bounds.min.z + Math.random() * size.z
      }
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(base.slice(), 3))
      this.dustBase = base
      this.dust = new Points(g, new PointsMaterial({ color: new Color(view.sky.light).multiplyScalar(1.4), size: 0.035, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }))
      this.dust.frustumCulled = false
      this.root.add(this.dust)
    }
  }

  update(dt: number, t: number, eye: Vector3): void {
    this.sky.position.copy(eye)
    this.sky.material.uniforms.time!.value = t
    flowSurfaces(dt)
    if (this.dust && this.dustBase) {
      const a = this.dust.geometry.getAttribute('position') as Float32BufferAttribute
      const b = this.dustBase
      for (let i = 0; i < a.count; i++) {
        const k = i * 0.37
        a.setXYZ(i, b[i * 3]! + Math.sin(t * 0.13 + k) * 0.6, b[i * 3 + 1]! + Math.sin(t * 0.09 + k * 1.7) * 0.4, b[i * 3 + 2]! + Math.cos(t * 0.11 + k) * 0.6)
      }
      a.needsUpdate = true
    }
  }

  /** A breakable piece broke (or had broken before this page came): nothing of it is drawn from now on. */
  breakPiece(id: string): void {
    const runs = this.pieces.get(id)
    if (!runs) return
    this.pieces.delete(id)
    for (const r of runs) {
      const x = r.attr.getX(r.start)
      const y = r.attr.getY(r.start)
      const z = r.attr.getZ(r.start)
      for (let i = r.start; i < r.start + r.count; i++) r.attr.setXYZ(i, x, y, z)
      r.attr.addUpdateRange(r.start * 3, r.count * 3)
      r.attr.needsUpdate = true
    }
  }

  dispose(): void {
    this.root.removeFromParent()
    for (const d of this.disposers) d()
    for (const g of this.geometries) g.dispose()
    this.sky.geometry.dispose()
    this.sky.material.dispose()
    if (this.dust) {
      this.dust.geometry.dispose()
      ;(this.dust.material as PointsMaterial).dispose()
    }
  }
}
