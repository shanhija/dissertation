/**
 * The finishing passes over the round, as the options say: ambient occlusion (corners, creases and
 * the ground under things darken as they do in a real room; see-through things left out), one's own
 * held things drawn over the world, bloom (lamps, glowing things and lava shine past their edges),
 * tone mapping and the screen's colours, the labels over that, antialiasing (MSAA draws into a
 * multisampled target; FXAA or SMAA smooth the edges after), and last, always, the grade every
 * arena shares, as a painter's palette would: highlights warm, shadows cool and deep, colour a
 * little quieter, a soft curve, the corners darker, the weave of a canvas under it all, and as much
 * sharpening as asked. Drawn into a half-float target, so bright things keep their brightness until
 * the end.
 */

import { HalfFloatType, ShaderMaterial, Vector2, WebGLRenderTarget, type Camera, type Material, type Mesh, type Object3D, type Scene, type WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Pass } from 'three/addons/postprocessing/Pass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

import { lighting } from '../lighting'
import type { Antialias } from '../options'

/** The grade, on the screen's colours (after tone mapping). */
export const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new Vector2(1, 1) },
    sharpen: { value: 0 },
    colour: { value: 0.88 },
    warmth: { value: 1 },
    contrast: { value: 0.3 },
    vignette: { value: 1 },
    paper: { value: 1 },
  },
  vertexShader: `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
  fragmentShader: `
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float sharpen;
uniform float colour;
uniform float warmth;
uniform float contrast;
uniform float vignette;
uniform float paper;
varying vec2 vUv;
float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float vnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
void main() {
	vec3 c = texture2D( tDiffuse, vUv ).rgb;
	// Sharpening: away from the four neighbours' mean, kept within what they span (no halos).
	if ( sharpen > 0.0 ) {
		vec2 px = 1.0 / resolution;
		vec3 n = texture2D( tDiffuse, vUv + vec2( 0.0, px.y ) ).rgb;
		vec3 s = texture2D( tDiffuse, vUv - vec2( 0.0, px.y ) ).rgb;
		vec3 e = texture2D( tDiffuse, vUv + vec2( px.x, 0.0 ) ).rgb;
		vec3 w = texture2D( tDiffuse, vUv - vec2( px.x, 0.0 ) ).rgb;
		vec3 lo = min( c, min( min( n, s ), min( e, w ) ) );
		vec3 hi = max( c, max( max( n, s ), max( e, w ) ) );
		c = clamp( c + ( c - ( n + s + e + w ) * 0.25 ) * sharpen * 1.5, lo, hi );
	}
	float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
	// Faded or full colour.
	c = mix( vec3( l ), c, colour );
	// Shadows toward a cool umber-blue, highlights toward the cream of old paper.
	vec3 cool = mix( vec3( 1.0 ), vec3( 0.88, 0.93, 1.05 ), warmth );
	vec3 warm = mix( vec3( 1.0 ), vec3( 1.03, 1.0, 0.89 ), warmth );
	c *= mix( cool, warm, smoothstep( 0.12, 0.75, l ) );
	// A soft curve: deeper darks, fuller lights.
	c = clamp( c, 0.0, 1.0 );
	c = mix( c, c * c * ( 3.0 - 2.0 * c ), contrast );
	// The corners fall into shadow, as an old print's do.
	vec2 d = vUv - 0.5;
	d.x *= resolution.x / resolution.y;
	c *= mix( 1.0, 1.0 - 0.28 * vignette, smoothstep( 0.35, 1.05, length( d ) ) );
	// The page under it all: a slow mottle, fibres and grain, still on the screen.
	vec2 p = gl_FragCoord.xy;
	float mottle = vnoise( p / 180.0 ) * 0.6 + vnoise( p / 60.0 ) * 0.4;
	float fibre = vnoise( vec2( p.x / 3.0 + p.y / 41.0, p.y / 3.0 - p.x / 37.0 ) );
	float grain = hash( floor( p / 1.5 ) );
	c *= 1.0 + paper * ( ( mottle - 0.5 ) * 0.07 + ( fibre - 0.5 ) * 0.03 + ( grain - 0.5 ) * 0.03 );
	c = mix( c, c * vec3( 1.02, 0.99, 0.93 ), paper * 0.35 );
	gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), 1.0 );
}`,
}

/**
 * The layer one's own held things are on. Drawn with the world, half a metre before the eyes,
 * they sank into a wall or a doctor one stood against (and took the shade of what was behind
 * them): they are drawn in a pass of their own, over the world. Every light is on this layer too,
 * so they are lit as everything else is, by the same shaders.
 */
export const VIEW_LAYER = 1

/**
 * The layer the labels are on (name tags, floating numbers, a crate's words, a taunt): drawn after
 * the tone mapping, in the screen's colours as their canvas has them, under the grade only (the
 * user's decision of 2026-11-11: labels not tone-mapped). Drawn among the light before it, a
 * window many times brighter than white shone through a name's soft edges and washed it out, and
 * the bloom spread over it; and the ambient occlusion does not see them (a dark card round each).
 */
export const LABEL_LAYER = 2

/**
 * Ambient occlusion of solid surfaces only: something see-through (glass, a fading sight, a beam)
 * has none to shade, and drew a halo. The sun's shadows are drawn already this frame: not again
 * for its own drawing of the scene.
 */
class SolidAO extends GTAOPass {
  private readonly hidden: Object3D[] = []

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    this.scene.traverseVisible((o) => {
      if ((o as Mesh).isMesh && ((o as Mesh).material as Material).transparent) this.hidden.push(o)
    })
    for (const o of this.hidden) o.visible = false
    const shadows = renderer.shadowMap.autoUpdate
    renderer.shadowMap.autoUpdate = false
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
    renderer.shadowMap.autoUpdate = shadows
    for (const o of this.hidden) o.visible = true
    this.hidden.length = 0
  }
}

/**
 * One layer of the scene drawn over what is drawn so far, nothing else of it drawn again: one's
 * own held things (VIEW_LAYER, the depth cleared first, so they draw over the world) or the labels
 * (LABEL_LAYER).
 */
class LayerPass extends Pass {
  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly layer: number,
    private readonly clearDepth: boolean,
  ) {
    super()
    this.needsSwap = false
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const { scene, camera } = this
    const background = scene.background
    const autoClear = renderer.autoClear
    const shadows = renderer.shadowMap.autoUpdate
    const placing = scene.matrixWorldAutoUpdate
    const layers = camera.layers.mask
    // Placed, lit and shadowed already this frame.
    scene.background = null
    scene.matrixWorldAutoUpdate = false
    renderer.autoClear = false
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(readBuffer)
    if (this.clearDepth) renderer.clearDepth()
    camera.layers.set(this.layer)
    renderer.render(scene, camera)
    camera.layers.mask = layers
    renderer.shadowMap.autoUpdate = shadows
    renderer.autoClear = autoClear
    scene.matrixWorldAutoUpdate = placing
    scene.background = background
  }
}

/** Samples per pixel for an antialiasing choice, as many as this graphics card allows. */
function samplesFor(aa: Antialias, gl: WebGLRenderer): number {
  const want = aa === 'msaa2' ? 2 : aa === 'msaa4' ? 4 : aa === 'msaa8' ? 8 : 0
  return Math.min(want, gl.capabilities.maxSamples)
}

export class Post {
  private readonly composer: EffectComposer
  private readonly grade: ShaderPass
  private readonly ao: SolidAO | null = null
  private readonly glow: UnrealBloomPass | null = null

  constructor(gl: WebGLRenderer, scene: Scene, camera: Camera, passes: { ao: boolean; bloom: boolean; antialias: Antialias }, width: number, height: number) {
    const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: samplesFor(passes.antialias, gl) })
    this.composer = new EffectComposer(gl, target)
    this.composer.addPass(new RenderPass(scene, camera))
    if (passes.ao) {
      const ao = new SolidAO(scene, camera, width, height)
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: 12 })
      ao.blendIntensity = 0.85
      this.composer.addPass(ao)
      this.ao = ao
    }
    this.composer.addPass(new LayerPass(scene, camera, VIEW_LAYER, true))
    if (passes.bloom) {
      this.glow = new UnrealBloomPass(new Vector2(width, height), 0.28, 0.45, 1.1)
      this.composer.addPass(this.glow)
    }
    this.composer.addPass(new OutputPass())
    this.composer.addPass(new LayerPass(scene, camera, LABEL_LAYER, false))
    if (passes.antialias === 'fxaa') this.composer.addPass(new FXAAPass())
    if (passes.antialias === 'smaa') this.composer.addPass(new SMAAPass())
    this.grade = new ShaderPass(new ShaderMaterial(GRADE))
    this.composer.addPass(this.grade)
    this.setSize(width, height)
  }

  /** The drawing's size in the page's points; the pixels are the renderer's own (the options' resolution). */
  setSize(width: number, height: number): void {
    const ratio = this.composer.renderer.getPixelRatio()
    this.composer.setPixelRatio(ratio)
    this.composer.setSize(width, height)
    ;(this.grade.uniforms.resolution!.value as Vector2).set(width * ratio, height * ratio)
  }

  /** 0..1. */
  setSharpen(amount: number): void {
    this.grade.uniforms.sharpen!.value = amount
  }

  render(dt: number): void {
    // The lighting tab's finishing, as it is now.
    const l = lighting()
    if (this.ao) this.ao.blendIntensity = l.ao
    if (this.glow) {
      this.glow.strength = l.bloom
      this.glow.threshold = l.bloomThreshold
    }
    const u = this.grade.uniforms
    u.colour!.value = l.colour
    u.warmth!.value = l.warmth
    u.contrast!.value = l.contrast
    u.vignette!.value = l.vignette
    u.paper!.value = l.paper
    this.composer.render(dt)
  }

  dispose(): void {
    this.composer.dispose()
  }
}
