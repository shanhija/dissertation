/**
 * What made code and the game show for a moment: bursts of sparks or bits, beams (straight, or
 * crackling like lightning), soft clouds (smoke, steam, dust; glowing ones are fire and flashes
 * and light what is near them), trails behind flying bodies, and words floating up. Each lives
 * for its time on the page's clock and is gone. A cloud or a trail is one draw: points with a
 * shader that grows, drifts and fades them. Glowing clouds borrow one of a few lamps kept in the
 * scene for them, since a lamp added or taken away makes three.js rebuild every shader.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PointLight,
  Points,
  ShaderMaterial,
  Vector3,
  type Object3D,
} from 'three'

import type { Vec3 } from '../protocol'
import { ScreenLabel } from './doctor'
import { lighting } from '../lighting'
import { harmonize } from './paint'
import { LABEL_FONT } from '../fonts'

/** Floating words' size on the screen, in the page's pixels. */
const FLOAT = [128, 32] as const

const CYL = new CylinderGeometry(0.5, 0.5, 1, 10)
/** Glowing colours are drawn this much brighter than white, so the bloom catches them. */
const HOT = 2.2
/**
 * Light is drawn over paint: fire, sparks, beams and glowing sights after smoke and dust. Each
 * cloud's points sit round the object's origin, so three.js sorts them by when they were made, and
 * a fireball made before its smoke was drawn under it, a grey disc with an orange rim.
 */
export const LIGHT_ORDER = 1

const CLOUD_VERTEX = `
attribute float born;
attribute float seed;
attribute vec3 drift;
uniform float time;
uniform float life;
uniform float size0;
uniform float size1;
uniform float rise;
uniform float pixels;
uniform float fade;
uniform float near;
varying float vAlpha;
varying float vSeed;
varying float vAge;
void main() {
  float t = time - born;
  float age = t / life;
  vec3 p = position + drift * t + vec3(0.0, rise * t, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float a = clamp(age, 0.0, 1.0);
  float grow = 1.0 - (1.0 - a) * (1.0 - a);
  float s = mix(size0, size1, grow) * (0.75 + 0.5 * seed);
  bool live = age >= 0.0 && age <= 1.0;
  gl_PointSize = live ? min(s * pixels / max(0.05, -mv.z), 1024.0) : 0.0;
  vAlpha = live ? pow(1.0 - a, fade) * smoothstep(0.0, 0.06, a + 0.02) : 0.0;
  // Fading away as it nears the eye, if asked, so a puff never fills the view.
  if (near > 0.0) vAlpha *= smoothstep(near * 0.25, near, -mv.z);
  vSeed = seed;
  vAge = a;
}`

const CLOUD_FRAGMENT = `
uniform vec3 color;
uniform vec3 ember;
uniform float opacity;
uniform float hot;
varying float vAlpha;
varying float vSeed;
varying float vAge;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  // Each puff is a dab of a flat brush, turned its own way: longer than it is wide, with bristles
  // along it and ragged where the brush came off.
  float an = vSeed * 6.2832;
  vec2 r = vec2(cos(an) * c.x - sin(an) * c.y, sin(an) * c.x + cos(an) * c.y) * 2.0;
  float bristle = 0.8 + 0.2 * sin(r.y * 23.0 + vSeed * 40.0) * sin(r.y * 9.0 - vSeed * 13.0);
  float shape = length(vec2(r.x * 0.92, r.y * 1.12));
  float rag = 0.06 * sin(r.y * 29.0 + vSeed * 7.0) * smoothstep(0.5, 0.95, abs(r.x));
  // Smoke and dust crisp at the edge, as paint; fire soft, as light.
  float edge = mix(smoothstep(1.0, 0.88, shape + rag), smoothstep(1.0, 0.15, shape + rag) * 0.75, hot);
  float a = edge * bristle * vAlpha * opacity;
  if (a < 0.01) discard;
  // Three tones, the lightest on top: painted, not airbrushed.
  float lit = clamp(1.0 - gl_PointCoord.y + (bristle - 0.8) * 1.5, 0.0, 0.999);
  float tone = floor(lit * 3.0) / 2.0;
  vec3 col = mix(color, ember, vAge) * (0.78 + 0.32 * tone);
  // A glowing cloud burns white-yellow at its heart while it is young.
  col = mix(col, vec3(3.2, 2.6, 1.6), hot * smoothstep(0.75, 0.1, shape) * (1.0 - vAge) * (1.0 - vAge));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** Bits flying: each a short stroke along its flight on the screen, longer the faster it goes. */
const BIT_VERTEX = `
attribute vec3 vel;
attribute float seed;
uniform float size;
uniform float pixels;
uniform float screen;
varying vec2 vDir;
varying float vStretch;
varying float vSeed;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 mv2 = modelViewMatrix * vec4(position + vel * 0.04, 1.0);
  vec4 p1 = projectionMatrix * mv;
  vec4 p2 = projectionMatrix * mv2;
  gl_Position = p1;
  vec2 d = (p2.xy / max(p2.w, 0.001) - p1.xy / max(p1.w, 0.001)) * 0.5 * screen;
  float l = length(d);
  float px = max(2.0, size * pixels / max(0.05, -mv.z));
  vDir = l > 0.001 ? d / l : vec2(1.0, 0.0);
  float span = clamp(px + l, px, px * 6.0);
  vStretch = span / px;
  vSeed = seed;
  gl_PointSize = min(span, 256.0);
}`

const BIT_FRAGMENT = `
uniform vec3 color;
uniform float opacity;
varying vec2 vDir;
varying float vStretch;
varying float vSeed;
void main() {
  vec2 c = (gl_PointCoord - 0.5) * 2.0;
  c.y = -c.y;
  vec2 r = vec2(dot(c, vDir), dot(c, vec2(-vDir.y, vDir.x)));
  float shape = length(vec2(r.x, r.y * vStretch * 1.6));
  float a = smoothstep(1.0, 0.75, shape) * opacity;
  if (a < 0.01) discard;
  // The head of the stroke lighter than its tail.
  vec3 col = color * (0.8 + 0.3 * step(0.0, r.x));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** Points that swell, drift and fade: one cloud, or one trail. */
class Cloud {
  readonly points: Points
  readonly material: ShaderMaterial
  private readonly geometry = new BufferGeometry()
  private next = 0

  constructor(
    readonly count: number,
    /** near: metres from the eye within which its puffs fade away (0: they never do). */
    opts: { color: string; size0: number; size1: number; life: number; rise: number; glow: boolean; opacity: number; near: number },
  ) {
    this.geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3))
    this.geometry.setAttribute('drift', new Float32BufferAttribute(new Float32Array(count * 3), 3))
    this.geometry.setAttribute('born', new Float32BufferAttribute(new Float32Array(count).fill(-1e6), 1))
    this.geometry.setAttribute('seed', new Float32BufferAttribute(Float32Array.from({ length: count }, () => Math.random()), 1))
    const color = harmonize(new Color(opts.color), opts.glow)
    const ember = opts.glow ? color.clone().lerp(new Color('#3a0a02'), 0.75).multiplyScalar(0.6) : color.clone().multiplyScalar(0.9)
    if (opts.glow) color.multiplyScalar(HOT)
    this.material = new ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: opts.glow ? AdditiveBlending : NormalBlending,
      uniforms: {
        time: { value: 0 },
        life: { value: opts.life },
        size0: { value: opts.size0 },
        size1: { value: opts.size1 },
        rise: { value: opts.rise },
        pixels: { value: 600 },
        // Fire is gone quickly; smoke lingers and thins.
        fade: { value: opts.glow ? 1.6 : 0.75 },
        near: { value: opts.near },
        color: { value: color },
        ember: { value: ember },
        opacity: { value: opts.opacity },
        hot: { value: opts.glow ? 1 : 0 },
      },
    })
    this.points = new Points(this.geometry, this.material)
    this.points.frustumCulled = false
    if (opts.glow) this.points.renderOrder = LIGHT_ORDER
  }

  /** Lets a puff go from a point, drifting at v, born at time t. */
  emit(p: Vec3, v: Vec3, t: number): void {
    const i = this.next
    this.next = (this.next + 1) % this.count
    ;(this.geometry.getAttribute('position') as Float32BufferAttribute).setXYZ(i, p[0], p[1], p[2])
    ;(this.geometry.getAttribute('drift') as Float32BufferAttribute).setXYZ(i, v[0], v[1], v[2])
    ;(this.geometry.getAttribute('born') as Float32BufferAttribute).setX(i, t)
    for (const name of ['position', 'drift', 'born']) this.geometry.getAttribute(name).needsUpdate = true
  }

  tick(t: number, pixels: number): void {
    this.material.uniforms.time!.value = t
    this.material.uniforms.pixels!.value = pixels
  }

  dispose(): void {
    this.points.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
  }
}

/** Bits flying, in a colour (glowing: brighter than white and added to what is behind), each stroke `size` metres across. */
function bitMaterial(color: string, glow: boolean, size: number): ShaderMaterial {
  const c = harmonize(new Color(color), glow)
  if (glow) c.multiplyScalar(HOT)
  return new ShaderMaterial({
    vertexShader: BIT_VERTEX,
    fragmentShader: BIT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: glow ? AdditiveBlending : NormalBlending,
    uniforms: {
      color: { value: c },
      opacity: { value: 1 },
      size: { value: size },
      pixels: { value: 600 },
      screen: { value: 600 },
    },
  })
}

/** A beam's light, to fade as it goes. */
const beamMaterial = (color: string) => new MeshBasicMaterial({ color: harmonize(new Color(color), true).multiplyScalar(1.6), transparent: true, depthWrite: false, toneMapped: true })

/**
 * A trail of smoke behind a body: puffs let go along its path, thin beside the body and swelling
 * a little as they fade, gone near the eye so one's own throw leaves the view clear.
 */
export class Trail {
  private readonly cloud: Cloud
  private last: Vec3 | null = null
  /** Page time of the last puff, to know when the trail has faded. */
  lastAt = -1e6

  constructor(
    private readonly fx: Effects,
    color: string,
    private readonly width: number,
  ) {
    this.cloud = new Cloud(512, { color, size0: width, size1: width * 2.5, life: 1, rise: 0.35, glow: false, opacity: 0.6, near: 2.5 })
    fx.layer.add(this.cloud.points)
    fx.trails.add(this)
  }

  /** The body is here now: puffs fill the way from where it was, one every third of its width or so. */
  at(p: Vec3): void {
    const last = this.last
    if (!last) {
      this.last = [...p]
      return
    }
    let d = Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2])
    // A jump (a body put somewhere new) starts the trail again.
    if (d > 8) {
      this.last = [...p]
      return
    }
    const step = Math.max(0.04, this.width * 0.35)
    let n = 0
    let q = last
    while (d >= step && n < 16) {
      const k = step / d
      q = [q[0] + (p[0] - q[0]) * k, q[1] + (p[1] - q[1]) * k, q[2] + (p[2] - q[2]) * k]
      this.cloud.emit(q, [(Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3], this.fx.clock)
      d -= step
      n++
    }
    this.last = n === 16 ? [...p] : q
    if (n > 0) this.lastAt = this.fx.clock
  }

  tick(t: number, pixels: number): boolean {
    this.cloud.tick(t, pixels)
    return t - this.lastAt < 1
  }

  dispose(): void {
    this.cloud.dispose()
    this.fx.trails.delete(this)
  }
}

interface Live {
  until: number
  update(t: number): void
  dispose(): void
}

interface Lamp {
  light: PointLight
  t0: number
  secs: number
  peak: number
}

export class Effects {
  /** Where everything shown goes. */
  readonly layer = new Group()
  readonly trails = new Set<Trail>()
  /** Trails whose body is gone, fading out. */
  private readonly leftTrails = new Set<Trail>()
  private readonly live: Live[] = []
  private readonly clouds = new Set<Cloud>()
  private readonly lamps: Lamp[] = []
  private readonly t0 = performance.now() / 1000
  /** Seconds since these effects began (the shaders' clock). */
  clock = 0
  /** Pixels a metre spans one metre away, for the clouds' sizes; and the drawing's height in pixels. */
  private pixels = 600
  private screen = 600

  /** lamps: whether glowing clouds may light what is near them. */
  constructor(parent: Object3D, lamps: boolean) {
    parent.add(this.layer)
    for (let i = 0; i < (lamps ? 2 : 0); i++) {
      const light = new PointLight('#ffffff', 0, 10, 2)
      this.layer.add(light)
      this.lamps.push({ light, t0: -1e6, secs: 1, peak: 0 })
    }
  }

  /** Every frame: the page's time, the drawing's height in pixels and the camera's vertical field of view (degrees). */
  update(now: number, height: number, fov: number): void {
    this.clock = now - this.t0
    this.pixels = height / (2 * Math.tan((fov * Math.PI) / 360))
    this.screen = height
    for (const e of [...this.live]) {
      e.update(now)
      if (now > e.until) {
        e.dispose()
        this.live.splice(this.live.indexOf(e), 1)
      }
    }
    for (const t of this.trails) t.tick(this.clock, this.pixels)
    for (const t of this.leftTrails) {
      if (!t.tick(this.clock, this.pixels)) {
        t.dispose()
        this.leftTrails.delete(t)
      }
    }
    for (const l of this.lamps) {
      const k = (this.clock - l.t0) / l.secs
      l.light.intensity = k >= 0 && k < 1 ? l.peak * (1 - k) * (1 - k) : 0
    }
  }

  /** A trail whose body is gone fades where it is. */
  leave(t: Trail): void {
    this.trails.delete(t)
    this.leftTrails.add(t)
  }

  /**
   * Bits flying from a point and falling: all round, or toward dir within spread (0 a jet, 1 all
   * round), at speed (by default, by size) for secs.
   */
  burst(at: Vec3, color: string, size: number, count: number, glow: boolean, now: number, opts: { speed?: number | null; secs?: number | null; dir?: Vec3 | null; spread?: number } = {}): void {
    const n = Math.min(150, count)
    const pos = new Float32Array(n * 3)
    const vel: Vec3[] = []
    const dir = opts.dir ? new Vector3(...opts.dir).normalize() : null
    const spread = opts.spread ?? 1
    const u = new Vector3()
    for (let i = 0; i < n; i++) {
      pos.set(at, i * 3)
      const s = opts.speed != null ? opts.speed * (0.55 + Math.random() * 0.45) : (1.5 + Math.random() * 3) * Math.max(0.4, size)
      if (dir) {
        u.randomDirection().multiplyScalar(spread * 1.6).add(dir).normalize().multiplyScalar(s)
        vel.push([u.x, u.y, u.z])
      } else {
        const a = Math.random() * Math.PI * 2
        const up = Math.random()
        vel.push([Math.cos(a) * s * (1 - up * 0.5), up * s * 1.2, Math.sin(a) * s * (1 - up * 0.5)])
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    g.setAttribute('vel', new Float32BufferAttribute(vel.flat(), 3))
    g.setAttribute('seed', new Float32BufferAttribute(Float32Array.from({ length: n }, () => Math.random()), 1))
    const m = bitMaterial(color, glow, (glow ? 0.07 : 0.11) * Math.max(0.6, size))
    m.uniforms.pixels!.value = this.pixels
    m.uniforms.screen!.value = this.screen
    const pts = new Points(g, m)
    pts.frustumCulled = false
    if (glow) pts.renderOrder = LIGHT_ORDER
    this.layer.add(pts)
    const t0 = now
    let last = now
    const life = opts.secs ?? (glow ? 0.7 : 0.9)
    this.live.push({
      until: now + life,
      update: (t) => {
        const dt = t - last
        last = t
        const a = g.getAttribute('position') as Float32BufferAttribute
        const va = g.getAttribute('vel') as Float32BufferAttribute
        for (let i = 0; i < n; i++) {
          vel[i]![1] -= 9 * dt
          a.setXYZ(i, a.getX(i) + vel[i]![0] * dt, a.getY(i) + vel[i]![1] * dt, a.getZ(i) + vel[i]![2] * dt)
          va.setXYZ(i, vel[i]![0], vel[i]![1], vel[i]![2])
        }
        a.needsUpdate = true
        va.needsUpdate = true
        m.uniforms.opacity!.value = Math.max(0, 1 - (t - t0) / life)
        m.uniforms.pixels!.value = this.pixels
        m.uniforms.screen!.value = this.screen
      },
      dispose: () => {
        pts.removeFromParent()
        g.dispose()
        m.dispose()
      },
    })
  }

  /** A beam: straight, or with jag a zigzag that crackles (a new zigzag every few hundredths of a second). */
  beam(from: Vec3, to: Vec3, color: string, width: number, secs: number, jag: number, now: number): void {
    const a = new Vector3(...from)
    const b = new Vector3(...to)
    const length = a.distanceTo(b)
    if (length < 1e-4) return
    const m = beamMaterial(color)
    const segs = jag > 0 ? Math.max(4, Math.min(18, Math.round(length / 0.3))) : 1
    const group = new Group()
    const meshes = Array.from({ length: segs }, () => {
      const mesh = new Mesh(CYL, m)
      mesh.renderOrder = LIGHT_ORDER
      group.add(mesh)
      return mesh
    })
    const dir = b.clone().sub(a).normalize()
    const side = new Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize()
    const up = new Vector3().crossVectors(dir, side)
    const amp = jag * Math.min(0.45, length * 0.15)
    const pts = Array.from({ length: segs + 1 }, () => new Vector3())
    const yAxis = new Vector3(0, 1, 0)
    const lay = () => {
      for (let i = 0; i <= segs; i++) {
        const k = i / segs
        const s = i === 0 || i === segs ? 0 : amp * Math.sin(Math.PI * k) ** 0.5
        pts[i]!.copy(a).lerp(b, k).addScaledVector(side, (Math.random() * 2 - 1) * s).addScaledVector(up, (Math.random() * 2 - 1) * s)
      }
      for (let i = 0; i < segs; i++) {
        const p = pts[i]!
        const q = pts[i + 1]!
        const mesh = meshes[i]!
        mesh.position.copy(p).add(q).multiplyScalar(0.5)
        const d = q.clone().sub(p)
        mesh.scale.set(width * 2, d.length() + width, width * 2)
        mesh.quaternion.setFromUnitVectors(yAxis, d.normalize())
      }
    }
    lay()
    this.layer.add(group)
    const t0 = now
    let next = now + 0.045
    this.live.push({
      until: now + secs,
      update: (t) => {
        if (jag > 0 && t > next) {
          lay()
          next = t + 0.045
        }
        // A crackling beam flickers as it fades.
        const fade = Math.max(0, 1 - (t - t0) / secs)
        m.opacity = jag > 0 ? fade * (0.55 + 0.45 * Math.random()) : fade
      },
      dispose: () => {
        group.removeFromParent()
        m.dispose()
      },
    })
  }

  /** A soft cloud swelling to `size` across over `secs`, rising; a glowing one is fire or a flash and lights what is near. */
  puff(at: Vec3, color: string, size: number, secs: number, rise: number, glow: boolean, now: number): void {
    const n = Math.max(3, Math.min(16, Math.round(5 + size * 2.5)))
    const cloud = new Cloud(n, { color, size0: size * (glow ? 0.5 : 0.35), size1: size * (glow ? 0.8 : 0.75), life: secs, rise, glow, opacity: glow ? 1 : 0.85, near: 0 })
    for (let i = 0; i < n; i++) {
      // Puffs round the middle, pushing outward as the cloud swells.
      const d = new Vector3(Math.random() * 2 - 1, Math.random() * 1.6 - 0.6, Math.random() * 2 - 1).normalize().multiplyScalar(Math.random())
      const off = d.clone().multiplyScalar(size * 0.18)
      const v = d.multiplyScalar((size * 0.45) / Math.max(0.2, secs))
      cloud.emit([at[0] + off.x, at[1] + off.y, at[2] + off.z], [v.x, v.y, v.z], this.clock + Math.random() * Math.min(0.08, secs * 0.15))
    }
    this.layer.add(cloud.points)
    this.clouds.add(cloud)
    if (glow) this.flash(at, color, size, Math.min(secs, 0.6))
    this.live.push({
      until: now + secs + 0.1,
      update: () => cloud.tick(this.clock, this.pixels),
      dispose: () => {
        cloud.dispose()
        this.clouds.delete(cloud)
      },
    })
  }

  /** Borrows the lamp that is nearest to done for a flash of light. */
  private flash(at: Vec3, color: string, size: number, secs: number): void {
    if (this.lamps.length === 0) return
    let lamp = this.lamps[0]!
    for (const l of this.lamps) if (l.t0 + l.secs < lamp.t0 + lamp.secs) lamp = l
    lamp.light.position.set(...at)
    lamp.light.color.set(color)
    lamp.light.distance = 4 + size * 5
    lamp.peak = 10 * Math.min(6, size) ** 2 * lighting().effectLight
    lamp.t0 = this.clock
    lamp.secs = Math.max(0.15, secs)
  }

  /**
   * Words floating up from a point (a blow's damage), the same size on the screen near or far:
   * their foot `above` page pixels over it (clear of what stands there), or with null, their
   * middle on it.
   */
  floatText(at: Vec3, text: string, color: string, now: number, above: number | null): void {
    const label = new ScreenLabel(FLOAT[0], FLOAT[1])
    label.sprite.center.set(0.5, above === null ? 0.5 : -above / FLOAT[1])
    label.draw(text, (g, w) => {
      g.font = `700 40px ${LABEL_FONT}`
      g.textAlign = 'center'
      g.lineWidth = 7
      g.strokeStyle = 'rgba(20,10,5,0.9)'
      g.strokeText(text, w / 2, 46)
      g.fillStyle = color
      g.fillText(text, w / 2, 46)
    })
    label.sprite.position.set(...at)
    this.layer.add(label.sprite)
    const t0 = now
    this.live.push({
      until: now + 1.3,
      update: (t) => {
        label.sprite.position.y = at[1] + (t - t0) * 0.8
        ;(label.sprite.material as { opacity: number }).opacity = Math.max(0, 1 - (t - t0) / 1.3)
      },
      dispose: () => {
        label.sprite.removeFromParent()
        label.dispose()
      },
    })
  }

  /** One of each kind of effect's drawing (made to show nothing), kept while these effects last: see `warm`. */
  private kept: { group: Group; dispose: () => void } | null = null

  /**
   * One cloud, one spray of bits, one beam and one floating number, showing nothing, for World to
   * draw once before the round so their shaders are made in the countdown; kept until these
   * effects go, so a shader is not let go of when the last of its kind is gone (and made again on
   * the next).
   */
  warm(): Group {
    this.kept?.dispose()
    const group = new Group()
    const cloud = new Cloud(1, { color: '#ffffff', size0: 1, size1: 1, life: 1, rise: 0, glow: true, opacity: 1, near: 0 })
    const bits = new Points(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3)), bitMaterial('#ffffff', false, 0.1))
    bits.frustumCulled = false
    const beam = new Mesh(CYL, beamMaterial('#ffffff'))
    const number = new ScreenLabel(FLOAT[0], FLOAT[1])
    group.add(cloud.points, bits, beam, number.sprite)
    this.kept = {
      group,
      dispose: () => {
        group.removeFromParent()
        cloud.dispose()
        bits.geometry.dispose()
        bits.material.dispose()
        beam.material.dispose()
        number.dispose()
      },
    }
    return group
  }

  dispose(): void {
    for (const e of this.live) e.dispose()
    this.live.length = 0
    for (const t of [...this.trails, ...this.leftTrails]) t.dispose()
    this.leftTrails.clear()
    this.kept?.dispose()
    this.layer.removeFromParent()
  }
}
