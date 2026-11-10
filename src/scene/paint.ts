/**
 * The one look everything is drawn in: an old, dusty, illustrated book. Its lineage is A Gentlemen's
 * Dispute's painterly pipeline (detail in the normal map, so it catches the light; the diffuse light
 * in light, mid and dark), turned from oil to an old page when the brush strokes made things
 * look like "sockpuppets" and the wish was for "a dusty book". Whatever made a model (the game,
 * Opus, a player), the page draws it the same way, so a thing in a hand belongs to the hall it is in.
 *
 * - `paint(material)` lays a sheet of paper over the surface from the three sides in the mesh's
 *   own space (so it stays on a moving part): fine fibres and grain in relief, a slow mottle with
 *   foxed spots; dust settled on what faces up; engraved hatching where the light falls off,
 *   crossed in the dark; the sun's and lamps' light in three soft bands; a pale rim if asked. How
 *   much of each follows the lighting tab (lighting.ts) live, through uniforms all painted
 *   materials share. The shadow side's hue and the page's own paper are the finishing grade's (post.ts).
 * - `harmonize` pulls a colour into an old print's range: no pure black or white, the inks faded
 *   (glowing colour keeps more). Every model's colours pass through it once.
 * - `strokeTexture` is a flat brush's dabs, for the portraits, which are paintings on the walls.
 */

import { CanvasTexture, Color, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, ShaderChunk, type BufferAttribute, type InterleavedBufferAttribute, type MeshStandardMaterial } from 'three'

import { lighting, onLighting } from '../lighting'

const SIZE = 512

let strokes: CanvasTexture | null = null

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The stroke texture: x and y of each pixel's normal in red and green, the stroke's tone in blue. Tiles. */
export function strokeTexture(): CanvasTexture {
  if (strokes) return strokes
  const rnd = mulberry(1897)
  const h = new Float32Array(SIZE * SIZE)
  const tone = new Float32Array(SIZE * SIZE).fill(0.5)
  // The flow the brush follows: a slow turn across the canvas, the same at its edges so it tiles.
  const flow = (x: number, y: number) => 0.9 * Math.sin((x / SIZE) * Math.PI * 2 + 0.7) + 0.7 * Math.cos((y / SIZE) * Math.PI * 4 + 1.3) + 0.45 * Math.sin(((x + y) / SIZE) * Math.PI * 2)
  const count = 1500
  for (let i = 0; i < count; i++) {
    const cx = rnd() * SIZE
    const cy = rnd() * SIZE
    const len = 26 + rnd() * 34
    const wid = 8 + rnd() * 8
    const ang = flow(cx, cy) + (rnd() - 0.5) * 0.7
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const t = rnd()
    const lift = 0.6 + rnd() * 0.4
    const grooves = 3 + Math.floor(rnd() * 4)
    const phase = rnd() * 6.28
    const r = Math.ceil(len / 2 + wid)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Along the stroke (u) and across it (v), from -1 to 1.
        const u = (dx * ca + dy * sa) / (len / 2)
        const v = (-dx * sa + dy * ca) / (wid / 2)
        // A flat brush: square at its start, tapering where it lifts off.
        const end = u < 0 ? 1 - Math.max(0, -u - 0.85) / 0.15 : 1 - u * u * u * u
        const across = 1 - v * v
        if (end <= 0 || across <= 0 || Math.abs(u) > 1) continue
        const bristle = 0.75 + 0.25 * Math.sin(v * grooves * Math.PI + phase)
        const height = Math.sqrt(across) * Math.min(1, end * 1.5) * bristle * lift
        const x = (((Math.round(cx) + dx) % SIZE) + SIZE) % SIZE
        const y = (((Math.round(cy) + dy) % SIZE) + SIZE) % SIZE
        const k = y * SIZE + x
        // The later stroke lies over the earlier where it is laid thick.
        if (height > 0.12) {
          h[k] = height
          tone[k] = t
        }
      }
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const g = canvas.getContext('2d')!
  const img = g.createImageData(SIZE, SIZE)
  const at = (x: number, y: number) => h[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]!
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * 2.2
      const ny = (at(x, y + 1) - at(x, y - 1)) * 2.2
      const l = Math.hypot(nx, ny, 1)
      const i = (y * SIZE + x) * 4
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255
      img.data[i + 2] = tone[y * SIZE + x]! * 255
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  strokes = new CanvasTexture(canvas)
  strokes.colorSpace = NoColorSpace
  strokes.wrapS = strokes.wrapT = RepeatWrapping
  strokes.minFilter = LinearMipmapLinearFilter
  strokes.anisotropy = 4
  return strokes
}

/** The paper every painted surface is drawn on: fine fibres and grain in relief (red, green), a slow mottle with a few foxed spots (blue). Tiles. */
let paper: CanvasTexture | null = null
export function paperTexture(): CanvasTexture {
  if (paper) return paper
  const rnd = mulberry(1411)
  // Value noise on a lattice that wraps, so the paper tiles.
  const lattice = (period: number) => Float32Array.from({ length: period * period }, () => rnd())
  const noise = (lat: Float32Array, period: number, x: number, y: number) => {
    const fx = (x / SIZE) * period
    const fy = (y / SIZE) * period
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const at = (i: number, j: number) => lat[(((j % period) + period) % period) * period + (((i % period) + period) % period)]!
    const sx = tx * tx * (3 - 2 * tx)
    const sy = ty * ty * (3 - 2 * ty)
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy
  }
  const fine = [lattice(128), lattice(64), lattice(32)]
  const slow = [lattice(4), lattice(8)]
  const h = new Float32Array(SIZE * SIZE)
  const tone = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x
      h[i] = 0.5 * noise(fine[0]!, 128, x, y) + 0.3 * noise(fine[1]!, 64, x, y) + 0.2 * noise(fine[2]!, 32, x, y)
      tone[i] = 0.6 * noise(slow[0]!, 4, x, y) + 0.4 * noise(slow[1]!, 8, x, y)
    }
  }
  // Fibres: short fine threads pressed into the sheet.
  for (let f = 0; f < 2600; f++) {
    const cx = rnd() * SIZE
    const cy = rnd() * SIZE
    const a = rnd() * Math.PI
    const n = 5 + rnd() * 14
    const bend = (rnd() - 0.5) * 0.08
    const lift = 0.25 + rnd() * 0.35
    let x = cx
    let y = cy
    let dir = a
    for (let k = 0; k < n; k++) {
      const i = ((Math.round(y) % SIZE) + SIZE) % SIZE * SIZE + ((Math.round(x) % SIZE) + SIZE) % SIZE
      h[i] = Math.min(1.4, h[i]! + lift)
      x += Math.cos(dir)
      y += Math.sin(dir)
      dir += bend
    }
  }
  // Foxing: a few soft brown spots, as an old page has.
  for (let f = 0; f < 22; f++) {
    const cx = rnd() * SIZE
    const cy = rnd() * SIZE
    const r = 3 + rnd() * 9
    for (let dy = -Math.ceil(r * 2); dy <= r * 2; dy++) {
      for (let dx = -Math.ceil(r * 2); dx <= r * 2; dx++) {
        const d = Math.hypot(dx, dy) / r
        if (d > 2) continue
        const i = ((((Math.round(cy) + dy) % SIZE) + SIZE) % SIZE) * SIZE + ((((Math.round(cx) + dx) % SIZE) + SIZE) % SIZE)
        tone[i] = tone[i]! - 0.35 * Math.exp(-d * d * 1.5)
      }
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const g = canvas.getContext('2d')!
  const img = g.createImageData(SIZE, SIZE)
  const at = (x: number, y: number) => h[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]!
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * 1.6
      const ny = (at(x, y + 1) - at(x, y - 1)) * 1.6
      const l = Math.hypot(nx, ny, 1)
      const i = (y * SIZE + x) * 4
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255
      img.data[i + 2] = Math.max(0, Math.min(1, tone[y * SIZE + x]!)) * 255
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  paper = new CanvasTexture(canvas)
  paper.colorSpace = NoColorSpace
  paper.wrapS = paper.wrapT = RepeatWrapping
  paper.minFilter = LinearMipmapLinearFilter
  paper.anisotropy = 4
  return paper
}

export interface PaintOpts {
  /** Metres one tile of paper spans. */
  stroke: number
  /** How much the paper's grain stands out in the light. */
  relief: number
  /** 0 smooth light, 1 three bands. */
  bands: number
  /** How far the paper's mottle strays, 0..1. */
  tone: number
  /** Metres between the engraved lines in the shadows, and how much engraving it takes (0 none: a painting). */
  hatch: number
  ink: number
}

export const PAINT_MODEL: PaintOpts = { stroke: 0.9, relief: 0.6, bands: 1, tone: 0.1, hatch: 0.04, ink: 1 }
export const PAINT_DOCTOR: PaintOpts = { stroke: 0.7, relief: 0.45, bands: 0.85, tone: 0.06, hatch: 0.03, ink: 0.4 }
export const PAINT_SURFACE: PaintOpts = { stroke: 3.4, relief: 0.4, bands: 0.7, tone: 0.1, hatch: 0.06, ink: 1 }

/** What every painted material shares, following the lighting tab. */
const SHARED = {
  paintBandScale: { value: 1 },
  paintRim: { value: 0 },
  paintGrain: { value: 1 },
  paintHatch: { value: 0 },
  paintHatchScale: { value: 1 },
  paintDust: { value: 0 },
  paintMatte: { value: 0 },
}
onLighting(() => {
  const l = lighting()
  SHARED.paintBandScale.value = l.bands
  SHARED.paintRim.value = l.rim
  SHARED.paintGrain.value = l.grain
  SHARED.paintHatch.value = l.hatching
  SHARED.paintHatchScale.value = l.hatchSize
  SHARED.paintDust.value = l.dust
  SHARED.paintMatte.value = l.matte
})

const DOT_NL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );'
const LIGHTS = ShaderChunk.lights_physical_pars_fragment.replace(
  DOT_NL,
  `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	dotNL = mix( dotNL, paintBand( dotNL ), paintBands * paintBandScale );`,
)
if (LIGHTS === ShaderChunk.lights_physical_pars_fragment) console.warn('paint: the lighting chunk changed; the light is not banded')

const VERTEX_HEAD = `
varying vec3 vPaintPos;
varying vec3 vPaintNormal;
varying vec3 vPaintUp;
`
const FRAGMENT_HEAD = `
uniform sampler2D paintMap;
uniform float paintStroke;
uniform float paintRelief;
uniform float paintBands;
uniform float paintTone;
uniform float paintHatchSize;
uniform float paintInk;
uniform float paintBandScale;
uniform float paintRim;
uniform float paintGrain;
uniform float paintHatch;
uniform float paintHatchScale;
uniform float paintDust;
uniform float paintMatte;
uniform mat3 normalMatrix;
varying vec3 vPaintPos;
varying vec3 vPaintNormal;
varying vec3 vPaintUp;
// Dark, mid and light, the steps between them soft; on average as bright as the light itself.
float paintBand( float x ) {
	float mid = smoothstep( 0.08, 0.16, x );
	float light = smoothstep( 0.5, 0.6, x );
	return mix( mix( x * 0.5, 0.4, mid ), 0.86, light );
}
// An engraved line every unit of c, w wide (0..0.5), smoothed over a pixel.
float paintLine( float c, float w ) {
	float d = 0.5 - abs( fract( c ) - 0.5 );
	float aa = fwidth( c );
	return 1.0 - smoothstep( w - aa, w + aa, d );
}
`
const FRAGMENT_PAPER = `
	float paintDusty = 0.0;
	vec3 paintWt;
	{
		vec3 pn = normalize( vPaintNormal );
		vec3 wt = pow( abs( pn ), vec3( 4.0 ) );
		wt /= wt.x + wt.y + wt.z;
		paintWt = wt;
		vec3 pp = vPaintPos / paintStroke;
		vec4 sx = texture2D( paintMap, pp.zy );
		vec4 sy = texture2D( paintMap, pp.xz + 0.37 );
		vec4 sz = texture2D( paintMap, pp.xy + 0.71 );
		vec2 dx = sx.xy * 2.0 - 1.0;
		vec2 dy = sy.xy * 2.0 - 1.0;
		vec2 dz = sz.xy * 2.0 - 1.0;
		vec3 d = wt.x * vec3( 0.0, dx.y, dx.x ) + wt.y * vec3( dy.x, 0.0, dy.y ) + wt.z * vec3( dz.x, dz.y, 0.0 );
		vec3 bent = normalize( pn + d * paintRelief * paintGrain );
		normal = normalize( normal + ( normalize( normalMatrix * bent ) - normalize( normalMatrix * pn ) ) );
		float mottle = sx.z * wt.x + sy.z * wt.y + sz.z * wt.z;
		diffuseColor.rgb *= 1.0 + ( mottle - 0.5 ) * 2.0 * paintTone;
		// Dust settled in patches on what faces up; dust is matte.
		float up = normalize( vPaintUp ).y;
		float clumps = smoothstep( 0.4, 0.62, 1.0 - mottle );
		paintDusty = clamp( smoothstep( 0.4, 0.95, up ) * paintDust * clumps, 0.0, 1.0 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.47, 0.43, 0.36 ), paintDusty * 0.55 );
		roughnessFactor = mix( roughnessFactor, 1.0, paintDusty );
	}
`
const FRAGMENT_INK = `
	{
		// Engraved lines where the light falls off (by the light that arrives, not by how dark the
		// paint is): one way in the half shadow, crossed in the dark. Gone where they would be
		// finer than the screen can draw.
		vec3 lw = vec3( 0.2126, 0.7152, 0.0722 );
		float irr = dot( totalDiffuse, lw ) / max( dot( material.diffuseColor, lw ), 0.03 );
		float dark = 1.0 - smoothstep( 0.35, 1.9, irr );
		if ( paintHatch * paintInk > 0.0 && dark > 0.0 ) {
			vec3 hp = vPaintPos / ( paintHatchSize * paintHatchScale );
			float w = mix( 0.04, 0.2, dark );
			float one = paintWt.x * paintLine( hp.z + hp.y, w ) + paintWt.y * paintLine( hp.x + hp.z, w ) + paintWt.z * paintLine( hp.x + hp.y, w );
			float two = paintWt.x * paintLine( hp.z - hp.y, w ) + paintWt.y * paintLine( hp.x - hp.z, w ) + paintWt.z * paintLine( hp.x - hp.y, w );
			float fine = fwidth( hp.x + hp.y + hp.z );
			float fade = 1.0 - smoothstep( 0.2, 0.45, fine );
			float ink = ( one * smoothstep( 0.12, 0.5, dark ) + two * smoothstep( 0.78, 0.97, dark ) ) * fade * paintHatch * paintInk;
			outgoingLight *= 1.0 - 0.6 * clamp( ink, 0.0, 1.0 );
		}
		// A pale edge on what turns away from the eye.
		float facing = saturate( dot( normal, normalize( vViewPosition ) ) );
		outgoingLight += vec3( 1.0, 0.92, 0.8 ) * pow( 1.0 - facing, 3.0 ) * paintRim * 0.5;
	}
`

/** Makes a standard material painterly (in place) and returns it. */
export function paint<M extends MeshStandardMaterial>(m: M, o: PaintOpts = PAINT_MODEL): M {
  m.onBeforeCompile = (shader) => {
    // Painted at the first draw, not before: the page may make materials before it has a canvas to paint on.
    shader.uniforms.paintMap = { value: paperTexture() }
    shader.uniforms.paintStroke = { value: o.stroke }
    shader.uniforms.paintRelief = { value: o.relief }
    shader.uniforms.paintBands = { value: o.bands }
    shader.uniforms.paintTone = { value: o.tone }
    shader.uniforms.paintHatchSize = { value: o.hatch }
    shader.uniforms.paintInk = { value: o.ink }
    Object.assign(shader.uniforms, SHARED)
    shader.vertexShader =
      VERTEX_HEAD +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvPaintPos = transformed;\n\tvPaintNormal = objectNormal;\n\tvPaintUp = mat3( modelMatrix ) * objectNormal;')
    shader.fragmentShader =
      FRAGMENT_HEAD +
      shader.fragmentShader
        .replace('#include <lights_physical_pars_fragment>', LIGHTS)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 1.0, paintMatte );')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAGMENT_PAPER}`)
        .replace('#include <opaque_fragment>', `${FRAGMENT_INK}\n\t#include <opaque_fragment>`)
  }
  // One program for every painted material of a kind: the code is the same, only the numbers differ.
  m.customProgramCacheKey = () => 'paint'
  m.needsUpdate = true
  return m
}

// ------------------------------------------------------------------------------ colour

const cbrt = Math.cbrt

/**
 * Pulls a colour (linear, as three.js keeps them) into the painting's range, in place: lightness
 * between a deep umber and a warm white, and colour no louder than oil paint (a glowing colour may
 * be louder: it is light, not paint).
 */
export function harmonize(c: Color, glow = false): Color {
  const [r, g, b] = harmonized(c.r, c.g, c.b, glow)
  return c.setRGB(r, g, b)
}

function harmonized(r: number, g: number, b: number, glow: boolean): [number, number, number] {
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  let L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  let A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  let B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  // Inks faded with age, a little toward the yellow of old paper.
  const cmax = glow ? 0.2 : 0.095
  const C = Math.hypot(A, B)
  if (C > 1e-6) {
    const k = (cmax * Math.tanh(C / cmax)) / C
    A *= k
    B *= k
  }
  if (!glow) {
    L = 0.18 + L * 0.68
    B += 0.012
    A += 0.003
  }
  const l2 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m2 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s2 = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return [clamp(4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2), clamp(-1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2), clamp(-0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2)]
}

/** Harmonizes a geometry's colours, in place. */
export function harmonizeColors(attr: BufferAttribute | InterleavedBufferAttribute, glow = false): void {
  for (let i = 0; i < attr.count; i++) {
    const [r, g, b] = harmonized(attr.getX(i), attr.getY(i), attr.getZ(i), glow)
    attr.setXYZ(i, r, g, b)
  }
  attr.needsUpdate = true
}

/** A '#rrggbb' harmonized, as '#rrggbb'. */
export function harmonizedHex(hex: string, glow = false): string {
  return `#${harmonize(new Color(hex), glow).getHexString()}`
}
