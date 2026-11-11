/**
 * The player's options, kept in this browser and changed on the options screen (OptionsScreen.tsx,
 * open from the dressing room, the pause card, or O at any time): the mouse (sensitivity, invert),
 * the field of view, the display (fullscreen, the drawing's resolution, sharpening, a frame
 * counter), the graphics (a preset, or shadows, ambient occlusion, bloom, antialiasing, lights
 * from effects and dust one by one) and the sound (volume, spoken taunts). Anything may read
 * them at any time; a React component follows them with useOptions.
 */

import { useSyncExternalStore } from 'react'

export type Quality = 'high' | 'medium' | 'low'
export type Shadows = 'off' | 'soft' | 'fine'
/** FXAA and SMAA smooth edges after drawing (cheap); MSAA draws each pixel's edges several times over (sharper, dearer). */
export type Antialias = 'off' | 'fxaa' | 'smaa' | 'msaa2' | 'msaa4' | 'msaa8'

export interface Options {
  /** Radians the view turns for a pixel of mouse. */
  sensitivity: number
  /** Moving the mouse up looks down. */
  invertY: boolean
  /** Degrees, top to bottom of the view. */
  fov: number
  /** The share of the screen's own pixels the picture is drawn with, 0.5..1. */
  resolution: number
  /** 0..1. */
  sharpen: number
  fps: boolean
  preset: Quality | 'custom'
  shadows: Shadows
  ao: boolean
  bloom: boolean
  antialias: Antialias
  /** Fire, flashes and glowing sights light what is near them. */
  lamps: boolean
  /** Dust hanging in the light. */
  dust: boolean
  /** 0..1. */
  volume: number
  /** Taunts spoken aloud (they are always shown as subtitles). */
  voices: boolean
}

type Graphics = Pick<Options, 'shadows' | 'ao' | 'bloom' | 'antialias' | 'lamps' | 'dust'>

export const PRESETS: Record<Quality, Graphics> = {
  high: { shadows: 'fine', ao: true, bloom: true, antialias: 'msaa4', lamps: true, dust: true },
  medium: { shadows: 'soft', ao: false, bloom: true, antialias: 'msaa4', lamps: true, dust: false },
  low: { shadows: 'off', ao: false, bloom: false, antialias: 'fxaa', lamps: false, dust: false },
}
const GRAPHICS = Object.keys(PRESETS.high) as (keyof Graphics)[]

/** Drawn at no more than 1.5 pixels to the screen's point unless asked: a fine screen at full resolution is costly. */
const fitResolution = () => Math.min(1, 1.5 / Math.max(1, window.devicePixelRatio || 1))

export function defaults(): Options {
  return { sensitivity: 0.0022, invertY: false, fov: 75, resolution: fitResolution(), sharpen: 0.2, fps: false, preset: 'high', ...PRESETS.high, volume: 0.8, voices: true }
}

const KEY = 'dissertation-options'

function load(): Options {
  const o = defaults()
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Options> | null
    if (kept) return clean({ ...o, ...kept })
    // What the settings card kept before there was an options screen.
    const old = JSON.parse(localStorage.getItem('dissertation-graphics') ?? 'null') as { quality?: Quality; bloom?: boolean } | null
    if (old?.quality && old.quality in PRESETS) Object.assign(o, { preset: old.quality, ...PRESETS[old.quality] })
    if (typeof old?.bloom === 'boolean' && old.bloom !== o.bloom) Object.assign(o, { bloom: old.bloom, preset: 'custom' })
    const sens = Number(localStorage.getItem('dissertation-sensitivity'))
    if (sens > 0) o.sensitivity = sens
  } catch {
    // No storage, or something else in it: the defaults.
  }
  return o
}

const clamp = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def)
const oneOf = <T extends string>(v: unknown, all: readonly T[], def: T): T => (all.includes(v as T) ? (v as T) : def)

function clean(o: Options): Options {
  const d = defaults()
  return {
    sensitivity: clamp(o.sensitivity, d.sensitivity / 4, d.sensitivity * 10, d.sensitivity),
    invertY: o.invertY === true,
    fov: clamp(o.fov, 55, 110, d.fov),
    resolution: clamp(o.resolution, 0.5, 1, d.resolution),
    sharpen: clamp(o.sharpen, 0, 1, d.sharpen),
    fps: o.fps === true,
    preset: oneOf(o.preset, ['high', 'medium', 'low', 'custom'] as const, 'custom'),
    shadows: oneOf(o.shadows, ['off', 'soft', 'fine'] as const, d.shadows),
    ao: o.ao === true,
    bloom: o.bloom !== false,
    antialias: oneOf(o.antialias, ['off', 'fxaa', 'smaa', 'msaa2', 'msaa4', 'msaa8'] as const, d.antialias),
    lamps: o.lamps !== false,
    dust: o.dust === true,
    volume: clamp(o.volume, 0, 1, d.volume),
    voices: o.voices !== false,
  }
}

let current: Options | null = null
const listeners = new Set<() => void>()

/** The options now. */
export function options(): Options {
  current ??= load()
  return current
}

/**
 * Changes some options and keeps them. A preset sets the graphics it stands for; changing one of
 * those by hand makes the preset 'custom'.
 */
export function setOptions(patch: Partial<Options>): void {
  let next: Options = { ...options(), ...patch }
  if (patch.preset && patch.preset !== 'custom') next = { ...next, ...PRESETS[patch.preset] }
  else if (GRAPHICS.some((k) => k in patch)) {
    const p = next.preset
    if (p !== 'custom' && GRAPHICS.some((k) => next[k] !== PRESETS[p][k])) next.preset = 'custom'
  }
  current = clean(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // No storage: they last as long as the page.
  }
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The options, for a component: it draws again when they change. */
export function useOptions(): Options {
  return useSyncExternalStore(subscribe, options)
}

// ------------------------------------------------------------------------------ the screen

let open = false
const openListeners = new Set<() => void>()

/** Opens the options screen (letting go of the mouse, if the game had it). */
export function openOptions(): void {
  if (document.pointerLockElement) document.exitPointerLock()
  open = true
  for (const l of openListeners) l()
}

export function closeOptions(): void {
  open = false
  for (const l of openListeners) l()
}

export function useOptionsOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      openListeners.add(l)
      return () => openListeners.delete(l)
    },
    () => open,
  )
}

// ------------------------------------------------------------------------------ fullscreen

export const canFullscreen = (): boolean => document.fullscreenEnabled === true

export const isFullscreen = (): boolean => document.fullscreenElement !== null

/** Fills the screen with the page, or gives the screen back. */
export function toggleFullscreen(): void {
  if (isFullscreen()) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
}

/** The pixels the picture is drawn with for each of the page's points. */
export const pixelRatio = (o: Options): number => Math.max(0.5, (window.devicePixelRatio || 1) * o.resolution)
