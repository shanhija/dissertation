/**
 * The players' colours told apart where it counts: on the screen, as a name tag or a pip is drawn
 * (the canvas's colour under the grade's defaults: labels are drawn after the tone mapping,
 * post.ts), and as a glowing shape in the player's colour would be (harmonized, through three.js's
 * ACES tone mapping, then the grade).
 */
import { Color } from 'three'
import { describe, expect, it } from 'vitest'

import { PLAYER_COLORS } from '../doctor'
import { LIGHTING } from '../lighting'
import { harmonize } from './paint'

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** three.js's ACESFilmicToneMapping (tonemapping_pars_fragment), at the tab's exposure. */
function aces([r, g, b]: number[]): number[] {
  const k = LIGHTING.exposure / 0.6
  const [x, y, z] = [r! * k, g! * k, b! * k]
  const i = [0.59719 * x + 0.35458 * y + 0.04823 * z, 0.076 * x + 0.90834 * y + 0.01566 * z, 0.0284 * x + 0.13383 * y + 0.83777 * z]
  const [p, q, s] = i.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081))
  return [1.60475 * p! - 0.53108 * q! - 0.07367 * s!, -0.10208 * p! + 1.10813 * q! - 0.00605 * s!, -0.00327 * p! - 0.07276 * q! + 1.07602 * s!].map(clamp)
}

/** The grade (post.ts) at the tab's defaults, in the middle of the screen: faded colour, warm lights and cool shadows, the curve, the page's tint. */
function grade(c: number[]): number[] {
  const l = 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!
  const t = clamp((l - 0.12) / (0.75 - 0.12))
  const s = t * t * (3 - 2 * t)
  const w = LIGHTING.warmth
  const cool = [1 - 0.12 * w, 1 - 0.07 * w, 1 + 0.05 * w]
  const warm = [1 + 0.03 * w, 1, 1 - 0.11 * w]
  const paper = [1.02, 0.99, 0.93]
  return c.map((v, i) => {
    let x = clamp((l + (v - l) * LIGHTING.colour) * (cool[i]! + (warm[i]! - cool[i]!) * s))
    x += (x * x * (3 - 2 * x) - x) * LIGHTING.contrast
    return clamp(x + (x * paper[i]! - x) * LIGHTING.paper * 0.35)
  })
}

function oklab([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!)
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!)
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

/** A colour as it comes out on the screen, in OKLab, drawn as a label or as a glowing shape. */
function seen(hex: string, as: 'label' | 'glow'): number[] {
  const c = new Color(hex)
  const shown = as === 'label' ? [c.r, c.g, c.b] : aces(harmonize(c, true).toArray())
  return oklab(grade(shown.map(toSrgb)).map(toLinear))
}

function nearest(as: 'label' | 'glow'): number {
  const s = PLAYER_COLORS.map((h) => seen(h, as))
  let best = Infinity
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) best = Math.min(best, Math.hypot(s[i]![0]! - s[j]![0]!, s[i]![1]! - s[j]![1]!, s[i]![2]! - s[j]![2]!))
  return best
}

describe("the players' colours", () => {
  it('stay at least 0.12 apart in OKLab on the screen, as labels and as glowing shapes', () => {
    expect(nearest('label')).toBeGreaterThanOrEqual(0.12)
    expect(nearest('glow')).toBeGreaterThanOrEqual(0.12)
  })

  it('are light enough to read as a name over its dark outline', () => {
    for (const h of PLAYER_COLORS) expect(seen(h, 'label')[0]).toBeGreaterThan(0.55)
  })
})
