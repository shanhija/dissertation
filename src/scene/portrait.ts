/**
 * The doctors' portraits, as A Gentlemen's Dispute hangs its players in its banquet hall: each
 * doctor as they look now, head and shoulders turned a little, lit from one side against a dark
 * umber ground, drawn once into a texture and then painted over with a Kuwahara filter (each
 * pixel takes the calmest of the four patches round it, so the picture falls into flat dabs of
 * colour, as oils do). The arena hangs it in a gilt frame with a brass plaque for the name.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'

import { BODY } from '../doctor'
import type { Look, WardrobePart } from '../protocol'
import { DoctorMesh, type DoctorPose } from './doctor'
import { PAINT_MODEL, paint, strokeTexture } from './paint'
import { LABEL_FONT } from '../fonts'

const W = 384
const H = 480

const KUWAHARA = new ShaderMaterial({
  uniforms: { src: { value: null }, strokes: { value: null }, texel: { value: new Vector2(1 / W, 1 / H) } },
  vertexShader: `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
  fragmentShader: `
uniform sampler2D src;
uniform sampler2D strokes;
uniform vec2 texel;
varying vec2 vUv;
const int R = 5;
void main() {
	// Each dab of the brush drags the colour under it a little along its stroke.
	vec4 st = texture2D( strokes, vUv * vec2( 2.4, 3.0 ) );
	vec2 uv = vUv + ( st.xy - 0.5 ) * 0.035;
	vec3 m0 = vec3( 0.0 ), m1 = vec3( 0.0 ), m2 = vec3( 0.0 ), m3 = vec3( 0.0 );
	vec3 s0 = vec3( 0.0 ), s1 = vec3( 0.0 ), s2 = vec3( 0.0 ), s3 = vec3( 0.0 );
	for ( int j = 0; j <= R; j++ ) {
		for ( int i = 0; i <= R; i++ ) {
			vec3 c;
			c = texture2D( src, uv + vec2( -i, -j ) * texel ).rgb; m0 += c; s0 += c * c;
			c = texture2D( src, uv + vec2( i, -j ) * texel ).rgb; m1 += c; s1 += c * c;
			c = texture2D( src, uv + vec2( -i, j ) * texel ).rgb; m2 += c; s2 += c * c;
			c = texture2D( src, uv + vec2( i, j ) * texel ).rgb; m3 += c; s3 += c * c;
		}
	}
	float n = float( ( R + 1 ) * ( R + 1 ) );
	m0 /= n; m1 /= n; m2 /= n; m3 /= n;
	float v0 = dot( abs( s0 / n - m0 * m0 ), vec3( 1.0 ) );
	float v1 = dot( abs( s1 / n - m1 * m1 ), vec3( 1.0 ) );
	float v2 = dot( abs( s2 / n - m2 * m2 ), vec3( 1.0 ) );
	float v3 = dot( abs( s3 / n - m3 * m3 ), vec3( 1.0 ) );
	vec3 c = m0;
	float v = v0;
	if ( v1 < v ) { c = m1; v = v1; }
	if ( v2 < v ) { c = m2; v = v2; }
	if ( v3 < v ) { c = m3; v = v3; }
	// Varnish: the picture a little warmer and softer at its brightest.
	c = c / ( 1.0 + c * 0.35 );
	c *= vec3( 1.04, 1.0, 0.9 ) * ( 1.0 + ( st.z - 0.5 ) * 0.12 );
	gl_FragColor = vec4( c, 1.0 );
}`,
  depthTest: false,
  depthWrite: false,
})

/** The dark ground behind a sitter: warm umber, lighter behind the head. */
function groundTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 160
  const g = c.getContext('2d')!
  const r = g.createRadialGradient(70, 52, 4, 64, 80, 120)
  r.addColorStop(0, '#6a5038')
  r.addColorStop(0.45, '#3a2a1e')
  r.addColorStop(1, '#140e0a')
  g.fillStyle = r
  g.fillRect(0, 0, 128, 160)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

const IDLE: DoctorPose = { yaw: 0, pitch: 0, vel: [0, 0, 0] as [number, number, number], grounded: true, hands: [null, null], riding: false, writing: false, held: false, hurt: 10, size: 1, shake: 0, glow: null, cred: 100 }

/** Paints doctors' portraits once each (by how they look) and keeps them while the page lives. */
export class Portraits {
  private readonly made = new Map<string, WebGLRenderTarget>()
  private ground: CanvasTexture | null = null

  constructor(private readonly gl: WebGLRenderer) {}

  /** The painted portrait of a doctor who looks like this. */
  of(look: Look, wardrobe: ReadonlyMap<string, WardrobePart>): Texture {
    const key = JSON.stringify(look)
    const known = this.made.get(key)
    if (known) return known.texture
    const sitter = new WebGLRenderTarget(W, H, { type: HalfFloatType, samples: 4 })
    const painted = new WebGLRenderTarget(W, H, { type: HalfFloatType })
    const scene = new Scene()
    this.ground ??= groundTexture()
    scene.background = this.ground
    const doctor = new DoctorMesh()
    doctor.dress(look, wardrobe)
    doctor.tag.sprite.visible = false
    doctor.pose(IDLE, 0)
    // Turned a little to the light, which falls from high on its right.
    doctor.root.rotation.y = 0.42
    scene.add(doctor.root)
    const key1 = new DirectionalLight('#ffe0b8', 3.2)
    key1.position.set(-2.2, 3, 2.6)
    const rim = new DirectionalLight('#c8d4ff', 1.1)
    rim.position.set(2.5, 2, -2)
    scene.add(key1, rim, new HemisphereLight('#6a5a4a', '#1a1410', 0.9))
    const head = (BODY.head.center[1] * look.height) / BODY.height
    const camera = new PerspectiveCamera(28, W / H, 0.1, 20)
    camera.position.set(0.12, head - 0.05, 1.75)
    camera.lookAt(0, head - 0.16, 0)
    const was = this.gl.getRenderTarget()
    this.gl.setRenderTarget(sitter)
    this.gl.clear()
    this.gl.render(scene, camera)
    // The filter, as a picture-sized triangle pair.
    const quad = new Mesh(new PlaneGeometry(2, 2), KUWAHARA)
    const flat = new Scene()
    flat.add(quad)
    KUWAHARA.uniforms.src!.value = sitter.texture
    KUWAHARA.uniforms.strokes!.value = strokeTexture()
    this.gl.setRenderTarget(painted)
    this.gl.render(flat, new OrthographicCamera(-1, 1, 1, -1, 0, 1))
    this.gl.setRenderTarget(was)
    quad.geometry.dispose()
    sitter.dispose()
    doctor.dispose()
    this.made.set(key, painted)
    return painted.texture
  }

  dispose(): void {
    for (const t of this.made.values()) t.dispose()
    this.made.clear()
    this.ground?.dispose()
  }
}

// ------------------------------------------------------------------------------ the frame

const GILT = paint(new MeshStandardMaterial({ color: '#8f6a28', metalness: 0.7, roughness: 0.5 }), PAINT_MODEL)
const BACKING = new MeshStandardMaterial({ color: '#2a1d14', roughness: 0.9 })
const BOX = new BoxGeometry(1, 1, 1)
const KNOB = new SphereGeometry(0.5, 12, 8)

/** A name on a brass plaque. */
function plaqueTexture(name: string): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 96
  const g = c.getContext('2d')!
  g.fillStyle = '#a07a30'
  g.fillRect(0, 0, 512, 96)
  g.strokeStyle = '#5a4018'
  g.lineWidth = 6
  g.strokeRect(6, 6, 500, 84)
  g.fillStyle = '#2a1a0a'
  g.font = `italic 600 44px ${LABEL_FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(name.length > 22 ? `${name.slice(0, 21)}…` : name, 256, 50, 470)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

/**
 * A framed portrait, its back at the origin and its canvas facing +z, the canvas `size` metres
 * tall; picture null hangs an empty dark canvas. Returns the group and what to dispose with it.
 */
export function framed(picture: Texture | null, name: string | null, size: number): { group: Group; dispose: () => void } {
  const group = new Group()
  const w = size * 0.8
  const h = size
  const b = size * 0.11
  const owned: { dispose(): void }[] = []
  const canvasMat = paint(
    new MeshStandardMaterial({ color: picture ? '#ffffff' : '#3a2a1e', map: picture, emissiveMap: picture, emissive: new Color(picture ? '#ffffff' : '#000000'), emissiveIntensity: 0.3, roughness: 0.75 }),
    { stroke: 0.3, relief: 0.45, bands: 0, tone: 0.05, hatch: 0.03, ink: 0 },
  )
  owned.push(canvasMat)
  const canvas = new Mesh(new PlaneGeometry(w, h), canvasMat)
  owned.push(canvas.geometry)
  canvas.position.z = 0.045
  const back = new Mesh(BOX, BACKING)
  back.scale.set(w + b, h + b, 0.04)
  back.position.z = 0.02
  group.add(canvas, back)
  // Four bars of moulding, a lip inside them, and a knob at each corner.
  for (const [x, y, sx, sy] of [
    [0, h / 2 + b / 2, w + 2 * b, b],
    [0, -h / 2 - b / 2, w + 2 * b, b],
    [w / 2 + b / 2, 0, b, h],
    [-w / 2 - b / 2, 0, b, h],
  ] as const) {
    const bar = new Mesh(BOX, GILT)
    bar.scale.set(sx, sy, b * 0.55)
    bar.position.set(x, y, b * 0.3)
    const lip = new Mesh(BOX, GILT)
    lip.scale.set(sx === b ? b * 0.3 : sx - b, sy === b ? b * 0.3 : sy - b, b * 0.75)
    lip.position.set(x - Math.sign(x) * b * 0.32, y - Math.sign(y) * b * 0.32, b * 0.3)
    bar.castShadow = lip.castShadow = true
    group.add(bar, lip)
  }
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      const knob = new Mesh(KNOB, GILT)
      knob.scale.setScalar(b * 0.9)
      knob.position.set(x * (w / 2 + b / 2), y * (h / 2 + b / 2), b * 0.6)
      group.add(knob)
    }
  }
  if (name) {
    const tex = plaqueTexture(name)
    const mat = new MeshBasicMaterial({ map: tex, color: new Color(0.85, 0.85, 0.85) })
    owned.push(tex, mat)
    const plaque = new Mesh(new PlaneGeometry(w * 0.55, w * 0.1), mat)
    owned.push(plaque.geometry)
    plaque.position.set(0, -h / 2 - b * 0.5, b * 0.62)
    group.add(plaque)
  }
  return { group, dispose: () => owned.forEach((o) => o.dispose()) }
}
