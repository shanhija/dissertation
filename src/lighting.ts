/**
 * The lighting and the look, tunable live on the options screen's second tab (2026-11-10:
 * "give me some options to control the lighting ... i want to be able to find a good general
 * lighting pattern"). They are art direction, not a player's taste: what is found good becomes
 * the game's own defaults below (the tab's "Copy values" gives them). Kept in this browser
 * meanwhile. The drawing reads them every frame; the painted materials share uniforms that follow
 * them (paint.ts), and the finishing passes read them as they draw (post.ts).
 */

import { useSyncExternalStore } from 'react'

export interface Lighting {
  // The light.
  /** The camera's exposure: everything brighter or darker. */
  exposure: number
  /** The sky's and the ground's light from all round. */
  ambient: number
  /** What shiny surfaces reflect of a soft room round them. */
  reflections: number
  /** How much of the light from all round (ambient and reflections) reaches under a roof: a roofed hall is lit by its lamps and windows, not by an open sky. */
  indoor: number
  sun: number
  /** Degrees above the horizon. */
  sunHeight: number
  /** Degrees round from +x toward +z. */
  sunTurn: number
  /** -1 cold blue to 1 low golden, 0 the arena's own sunlight. */
  sunWarmth: number
  /** The arena's lamps, times their own brightness and reach. */
  lamps: number
  lampReach: number
  /** Light from fire, flashes and glowing sights. */
  effectLight: number
  /** How bright glowing shapes are drawn. */
  glow: number
  // The finishing.
  ao: number
  bloom: number
  bloomThreshold: number
  // The book.
  /** 0 smooth light, 1 the full light, mid and dark bands. */
  bands: number
  /** A pale edge on what faces away from the eye. */
  rim: number
  /** The paper's grain in relief. */
  grain: number
  /** Engraved lines in the shadows, and how far apart on the screen (the page's pixels), whatever the size of the thing, how far away, or the drawing's resolution. */
  hatching: number
  hatchSpacing: number
  /** Dust settled on what faces up. */
  dust: number
  /** 0 as made, 1 everything matte as paper. */
  matte: number
  /** 0 grey, 1 the colours as they are. */
  colour: number
  /** Shadows cool and lights warm, 0 not at all. */
  warmth: number
  contrast: number
  vignette: number
  /** The page's own paper over the picture: fibres and foxing. */
  paper: number
}

/** The game's own: what everyone sees until a browser tunes its own. */
export const LIGHTING: Lighting = {
  exposure: 1,
  ambient: 0.9,
  reflections: 0.55,
  indoor: 0.6,
  sun: 2.6,
  sunHeight: 50,
  sunTurn: 38,
  sunWarmth: 0,
  lamps: 1,
  lampReach: 1,
  effectLight: 1,
  glow: 1,
  ao: 0.85,
  bloom: 0.28,
  bloomThreshold: 1.1,
  bands: 1,
  rim: 0.15,
  grain: 0.5,
  hatching: 0.7,
  hatchSpacing: 8,
  dust: 0.35,
  matte: 0.5,
  colour: 0.85,
  warmth: 1,
  contrast: 0.4,
  vignette: 1,
  paper: 1,
}

/** Each one's range and step, for the sliders and for cleaning what was kept. */
export const RANGES: Record<keyof Lighting, [number, number, number]> = {
  exposure: [0.3, 2.5, 0.05],
  ambient: [0, 3, 0.05],
  reflections: [0, 2, 0.05],
  indoor: [0, 1, 0.05],
  sun: [0, 8, 0.1],
  sunHeight: [5, 89, 1],
  sunTurn: [0, 359, 1],
  sunWarmth: [-1, 1, 0.05],
  lamps: [0, 4, 0.05],
  lampReach: [0.3, 3, 0.05],
  effectLight: [0, 4, 0.05],
  glow: [0, 3, 0.05],
  ao: [0, 2, 0.05],
  bloom: [0, 2, 0.02],
  bloomThreshold: [0.2, 3, 0.05],
  bands: [0, 1, 0.05],
  rim: [0, 1, 0.05],
  grain: [0, 1.5, 0.05],
  hatching: [0, 1.5, 0.05],
  hatchSpacing: [3, 24, 0.5],
  dust: [0, 1.5, 0.05],
  matte: [0, 1, 0.05],
  colour: [0, 1.5, 0.05],
  warmth: [0, 2, 0.05],
  contrast: [0, 1, 0.05],
  vignette: [0, 2, 0.05],
  paper: [0, 2, 0.05],
}

const KEY = 'dissertation-lighting'

function clean(l: Partial<Lighting>): Lighting {
  const out = { ...LIGHTING }
  for (const k of Object.keys(LIGHTING) as (keyof Lighting)[]) {
    const v = l[k]
    const [lo, hi] = RANGES[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(lo, Math.min(hi, v))
  }
  return out
}

let current: Lighting | null = null
const listeners = new Set<() => void>()

export function lighting(): Lighting {
  if (!current) {
    try {
      current = clean(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Lighting>)
    } catch {
      current = { ...LIGHTING }
    }
  }
  return current
}

export function setLighting(patch: Partial<Lighting>): void {
  current = clean({ ...lighting(), ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // No storage: it lasts as long as the page.
  }
  for (const l of listeners) l()
}

/** Calls back on every change (and once now). */
export function onLighting(l: () => void): () => void {
  listeners.add(l)
  l()
  return () => listeners.delete(l)
}

export function useLighting(): Lighting {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    lighting,
  )
}

/** The values as code, to paste as the game's own. */
export function lightingText(l: Lighting = lighting()): string {
  return `{\n${(Object.keys(LIGHTING) as (keyof Lighting)[]).map((k) => `  ${k}: ${l[k]},`).join('\n')}\n}`
}
