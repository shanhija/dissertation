/**
 * The arena's surfaces: a texture with relief for every material in protocol.ts, painted here
 * from tileable noise and simple layouts (planks, ashlar, bricks, tiles, shelves of books), no
 * image files. Each is a colour map and a normal map made from a height map, tiled in metres.
 * Most are neutral and take the colour they are given whole; books, chalkboard and lava keep
 * most of their own. Geometry gets its texture coordinates by box mapping (each face projected
 * along its strongest axis, in metres), so textures never stretch and adjacent pieces meet.
 */

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
  type Matrix4,
  type Texture,
} from 'three'

import { MATERIALS, type MaterialName } from '../protocol'
import { PAINT_SURFACE, harmonize, paint } from './paint'

const SIZE = 512

// ------------------------------------------------------------------------------ noise

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

const lattices = new Map<number, Float32Array>()
function lattice(seed: number, px: number, py: number): Float32Array {
  // A small integer for a key: a string made for each of the millions of lookups a texture makes
  // took 40% of its painting (measured 2026-11-11).
  if ((seed & 1023) !== seed || (px & 1023) !== px || (py & 1023) !== py) throw new Error(`a lattice of ${px} by ${py} cells, seed ${seed}: each must be a whole number under 1024`)
  const key = (seed * 1024 + px) * 1024 + py
  let l = lattices.get(key)
  if (!l) {
    const r = mulberry(seed * 7919 + px * 131 + py)
    l = Float32Array.from({ length: px * py }, () => r())
    lattices.set(key, l)
  }
  return l
}

/** Value noise that tiles: u and v in 0..1 (fbm wraps them), px by py cells across the tile. */
function noise(u: number, v: number, px: number, py: number, seed: number): number {
  const l = lattice(seed, px, py)
  const x = u * px
  const y = v * py
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const x1 = (x0 + 1) % px
  const y1 = (y0 + 1) % py
  const a = l[y0 * px + x0]!
  const b = l[y0 * px + x1]!
  const c = l[y1 * px + x0]!
  const d = l[y1 * px + x1]!
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** Fractal noise, 0..1: octaves of value noise, each twice as fine. */
function fbm(u: number, v: number, px: number, py: number, octaves: number, seed: number): number {
  // Wrapped into 0..1 once for all the octaves: the remainder of a fraction is slow to take.
  const wu = ((u % 1) + 1) % 1
  const wv = ((v % 1) + 1) % 1
  let sum = 0
  let amp = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += noise(wu, wv, px << o, py << o, seed + o * 17) * amp
    norm += amp
    amp *= 0.5
  }
  return sum / norm
}

/** Ridged noise, 0..1, high on thin lines: cracks, veins, caustics. */
function ridged(u: number, v: number, px: number, py: number, octaves: number, seed: number): number {
  return 1 - Math.abs(fbm(u, v, px, py, octaves, seed) * 2 - 1)
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// ------------------------------------------------------------------------------ painting

/** A texture being painted: colour (0..1, sRGB) and height (0..1) per pixel. */
interface Paint {
  col: Float32Array
  h: Float32Array
  set(x: number, y: number, r: number, g: number, b: number, h: number): void
}

type Def = {
  /** Metres one tile covers. */
  tile: number
  roughness: number
  metalness: number
  /** How strongly the relief shows. */
  relief: number
  /** How much of the given colour it takes: 1 whole, 0 none (its own colours). */
  tint: number
  /** Strokes drawn over the painted colour (chalk). */
  over?: (g: CanvasRenderingContext2D) => void
  emissive?: number
  opacity?: number
} & (
  | {
      /** Each pixel's colour and height from where it is (u and v 0..1, x and y in pixels), painted a band of rows at a time. */
      pixel: (u: number, v: number, x: number, y: number) => [number, number, number, number]
    }
  | {
      /** The whole texture at once. */
      paint: (p: Paint) => void
    }
)

const grey = (l: number, h: number): [number, number, number, number] => [l, l, l, h]

/** Blocks in rows (ashlar, bricks, tiles, planks): the block a pixel is in, and how far it is from the block's edges, in pixels. */
function blocks(u: number, v: number, rows: number, perRow: (row: number) => number[]) {
  const row = Math.floor(v * rows)
  const vy = v * rows - row
  const edges = perRow(row)
  let i = 0
  while (i < edges.length - 1 && u >= edges[i + 1]!) i++
  const left = edges[i]!
  const right = edges[i + 1] ?? 1
  const dx = Math.min(u - left, right - u) * SIZE
  const dy = Math.min(vy, 1 - vy) * (SIZE / rows)
  return { row, index: i, d: Math.min(dx, dy), dx, dy }
}

const rowCache = new Map<string, number[]>()
/** Edges (0 to 1) of blocks along a row: random lengths, the whole row adding up to the tile. */
function rowEdges(seed: number, row: number, min: number, max: number): number[] {
  const key = `${seed}:${row}:${min}:${max}`
  let e = rowCache.get(key)
  if (!e) {
    const r = mulberry(seed * 31 + row * 977)
    const lengths: number[] = []
    let sum = 0
    while (sum < 1) {
      const l = min + r() * (max - min)
      lengths.push(l)
      sum += l
    }
    const k = 1 / sum
    const shift = r()
    e = [0]
    let at = 0
    for (const l of lengths) e.push((at += l * k))
    // Each row starts somewhere else, so joints do not line up (and the tile still wraps).
    e = e.map((x) => (x + shift) % 1).sort((a, b) => a - b)
    if (e[0] !== 0) e.unshift(0)
    if (e.at(-1) !== 1) e.push(1)
    rowCache.set(key, e)
  }
  return e
}

const hash = (a: number, b: number, seed: number) => mulberry(a * 73856093 + b * 19349663 + seed * 83492791)()

const DEFS: Record<MaterialName, Def> = {
  plain: {
    tile: 3,
    roughness: 0.8,
    metalness: 0,
    relief: 0.8,
    tint: 1,
    pixel: (u, v) => grey(0.86 + fbm(u, v, 4, 4, 4, 1) * 0.14, fbm(u, v, 16, 16, 3, 2)),
  },
  plaster: {
    tile: 3,
    roughness: 0.92,
    metalness: 0,
    relief: 1.2,
    tint: 1,
    pixel: (u, v, x, y) => {
      const m = fbm(u, v, 3, 3, 5, 3)
      const speck = hash(x, y, 4) * 0.05
      const l = 0.8 + m * 0.18 + speck
      return [l, l * 0.99, l * 0.96, fbm(u, v, 24, 24, 3, 5) * 0.7 + speck]
    },
  },
  planks: {
    tile: 2.4,
    roughness: 0.55,
    metalness: 0,
    relief: 2.2,
    tint: 1,
    pixel: (u, v) => {
      const b = blocks(u, v, 8, (row) => rowEdges(11, row, 0.45, 0.8))
      const tone = 0.7 + hash(b.row, b.index, 12) * 0.28
      const grain = fbm(u + b.index * 0.31, v, 3, 48, 4, 13)
      const rings = 0.5 + 0.5 * Math.sin((v * 8 * 40 + grain * 14) * Math.PI)
      const seam = smooth(0, 2.2, b.d)
      const l = tone * (0.82 + rings * 0.12 + grain * 0.1) * (0.35 + 0.65 * seam)
      return [l, l * 0.97, l * 0.92, seam * (0.85 + grain * 0.15)]
    },
  },
  wood: {
    tile: 1.6,
    roughness: 0.5,
    metalness: 0,
    relief: 1.0,
    tint: 1,
    pixel: (u, v) => {
      const grain = fbm(u, v, 3, 24, 5, 21)
      const rings = 0.5 + 0.5 * Math.sin((v * 22 + grain * 9) * Math.PI)
      const l = 0.74 + rings * 0.14 + grain * 0.12
      return [l, l * 0.96, l * 0.9, rings * 0.4 + grain * 0.3]
    },
  },
  stone: {
    tile: 3,
    roughness: 0.9,
    metalness: 0,
    relief: 4,
    tint: 1,
    pixel: (u, v) => {
      const b = blocks(u, v, 4, (row) => rowEdges(31, row, 0.22, 0.5))
      const tone = 0.72 + hash(b.row, b.index, 32) * 0.22
      const detail = fbm(u, v, 8, 8, 5, 33)
      const chip = fbm(u, v, 32, 32, 2, 34)
      const edge = smooth(2, 9 + chip * 6, b.d)
      const mortar = b.d < 3
      const l = mortar ? 0.62 + detail * 0.1 : tone * (0.82 + detail * 0.22) * (0.75 + 0.25 * edge)
      return [l, l * 0.99, l * 0.95, mortar ? 0.05 : 0.45 + edge * 0.35 + detail * 0.2]
    },
  },
  brick: {
    tile: 2,
    roughness: 0.92,
    metalness: 0,
    relief: 4,
    tint: 0.9,
    pixel: (u, v) => {
      const rows = 12
      const row = Math.floor(v * rows)
      const off = row % 2 ? 0.125 : 0
      const b = blocks((u + off) % 1, v, rows, () => [0, 0.25, 0.5, 0.75, 1])
      const tone = 0.62 + hash(row, b.index + (row % 2) * 7, 41) * 0.3
      const detail = fbm(u, v, 12, 12, 4, 42)
      const mortar = b.d < 2.6
      const edge = smooth(2.6, 6, b.d)
      const l = mortar ? 0.93 + detail * 0.05 : tone * (0.8 + detail * 0.25)
      return [l, mortar ? l : l * 0.93, mortar ? l * 0.97 : l * 0.88, mortar ? 0.1 : 0.55 + edge * 0.3 + detail * 0.15]
    },
  },
  marble: {
    tile: 3.2,
    roughness: 0.18,
    metalness: 0,
    relief: 0.3,
    tint: 1,
    pixel: (u, v) => {
      const t = fbm(u, v, 3, 3, 6, 51)
      const vein = Math.pow(Math.abs(Math.sin((u * 2 + v + t * 3.2) * Math.PI)), 0.25)
      const fine = ridged(u, v, 6, 6, 4, 52)
      const l = 0.97 - (1 - vein) * 0.45 - Math.pow(fine, 8) * 0.18
      return [l, l, l * 0.98, l]
    },
  },
  tiles: {
    tile: 2,
    roughness: 0.25,
    metalness: 0,
    relief: 2.5,
    tint: 1,
    pixel: (u, v) => {
      const b = blocks(u, v, 4, () => [0, 0.25, 0.5, 0.75, 1])
      const tone = 0.84 + hash(b.row, b.index, 61) * 0.14
      const detail = fbm(u, v, 8, 8, 3, 62)
      const grout = b.d < 2.5
      const l = grout ? 0.58 : tone * (0.94 + detail * 0.08)
      return [l, l, l * 0.98, grout ? 0 : smooth(2.5, 7, b.d)]
    },
  },
  carpet: {
    tile: 1.6,
    roughness: 1,
    metalness: 0,
    relief: 0.8,
    tint: 1,
    pixel: (u, v, x, y) => {
      const fibre = hash(x, y, 71) * 0.12
      const du = Math.abs(((u * 4 + v * 4) % 1) - 0.5)
      const dv = Math.abs(((u * 4 - v * 4 + 8) % 1) - 0.5)
      const lattice = Math.min(du, dv) < 0.04 ? 0.8 : 1
      const rose = Math.hypot(((u * 4) % 1) - 0.5, ((v * 4) % 1) - 0.5) < 0.1 ? 0.86 : 1
      const wear = 0.9 + fbm(u, v, 2, 2, 3, 72) * 0.1
      const l = (0.78 + fibre) * lattice * rose * wear
      return [l, l * 0.97, l * 0.95, fibre * 3 + (lattice < 1 ? 0 : 0.2)]
    },
  },
  fabric: {
    tile: 0.6,
    roughness: 0.95,
    metalness: 0,
    relief: 1.4,
    tint: 1,
    pixel: (u, v) => {
      const a = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 64)
      const b = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 64)
      const weave = Math.floor(u * 64 + v * 64) % 2 ? a : b
      const l = 0.8 + weave * 0.14 + fbm(u, v, 4, 4, 3, 81) * 0.06
      return [l, l, l, weave]
    },
  },
  paper: {
    tile: 1.2,
    roughness: 0.95,
    metalness: 0,
    relief: 0.5,
    tint: 1,
    pixel: (u, v, x, y) => {
      const blot = fbm(u, v, 3, 3, 5, 91)
      const fibre = fbm(u, v, 64, 8, 2, 92)
      const l = 0.86 + blot * 0.12 + fibre * 0.04 - hash(x, y, 93) * 0.02
      return [l, l * 0.97, l * 0.88, fibre]
    },
  },
  books: {
    tile: 1.6,
    roughness: 0.75,
    metalness: 0,
    relief: 3,
    tint: 0.2,
    paint: (p) => {
      const rows = 4
      const palette = [
        [0.45, 0.1, 0.1],
        [0.12, 0.18, 0.4],
        [0.13, 0.3, 0.17],
        [0.55, 0.4, 0.15],
        [0.35, 0.2, 0.12],
        [0.1, 0.1, 0.12],
        [0.12, 0.33, 0.35],
        [0.5, 0.25, 0.3],
        [0.62, 0.55, 0.42],
      ]
      for (let row = 0; row < rows; row++) {
        const r = mulberry(100 + row)
        const widths: number[] = []
        let sum = 0
        while (sum < 1) {
          const w = 0.018 + r() * 0.035
          widths.push(w)
          sum += w
        }
        const books = widths.map((w) => ({ w: w / sum, h: 0.62 + r() * 0.3, c: palette[Math.floor(r() * palette.length)]!, band: r() < 0.6 }))
        const y0 = Math.floor((row * SIZE) / rows)
        const y1 = Math.floor(((row + 1) * SIZE) / rows)
        const rowH = y1 - y0
        const shelf = Math.round(rowH * 0.1)
        let x0 = 0
        for (const b of books) {
          const x1 = Math.round(x0 + b.w * SIZE)
          const top = y1 - shelf - Math.round(b.h * (rowH - shelf))
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < Math.min(x1, SIZE); x++) {
              if (y >= y1 - shelf) {
                const g = fbm(x / SIZE, y / SIZE, 4, 32, 3, 101)
                p.set(x, y, 0.36 + g * 0.08, 0.22 + g * 0.05, 0.12, 0.9)
              } else if (y < top) p.set(x, y, 0.06, 0.05, 0.04, 0.05)
              else {
                const across = (x - x0) / Math.max(1, x1 - x0)
                const round = 0.75 + 0.25 * Math.sin(across * Math.PI)
                const fromTop = (y - top) / Math.max(1, y1 - shelf - top)
                const gold = b.band && (Math.abs(fromTop - 0.12) < 0.025 || Math.abs(fromTop - 0.86) < 0.025)
                const n = 0.9 + fbm(x / SIZE, y / SIZE, 32, 32, 2, 102) * 0.15
                if (gold) p.set(x, y, 0.85 * round, 0.68 * round, 0.3 * round, 0.8)
                else p.set(x, y, b.c[0]! * round * n, b.c[1]! * round * n, b.c[2]! * round * n, 0.5 + round * 0.3)
              }
            }
          }
          x0 = x1
        }
      }
    },
  },
  chalkboard: {
    tile: 2.4,
    roughness: 0.85,
    metalness: 0,
    relief: 0.4,
    tint: 0.2,
    pixel: (u, v) => {
      const smudge = fbm(u, v, 3, 3, 5, 111)
      return [0.16 + smudge * 0.08, 0.24 + smudge * 0.08, 0.2 + smudge * 0.07, smudge]
    },
    over: (g) => {
      const r = mulberry(112)
      g.strokeStyle = 'rgba(235, 235, 225, 0.55)'
      g.lineCap = 'round'
      for (let line = 0; line < 9; line++) {
        let x = 30 + r() * 120
        const y = 40 + line * 52 + r() * 10
        g.lineWidth = 2 + r() * 1.5
        while (x < SIZE - 60) {
          // A word or a formula: a few squiggles, then a gap.
          const len = 20 + r() * 70
          g.beginPath()
          g.moveTo(x, y)
          for (let k = 0; k < len; k += 4) g.lineTo(x + k, y + Math.sin(k * (0.3 + r() * 0.3)) * (5 + r() * 5))
          g.stroke()
          x += len + 14 + r() * 30
        }
      }
      g.strokeStyle = 'rgba(235, 235, 225, 0.4)'
      g.lineWidth = 3
      g.beginPath()
      g.arc(380, 380, 70, 0, Math.PI * 1.6)
      g.stroke()
    },
  },
  metal: {
    tile: 1.2,
    roughness: 0.35,
    metalness: 0.9,
    relief: 0.6,
    tint: 1,
    pixel: (u, v) => {
      const brush = fbm(u, v, 2, 128, 3, 121)
      const l = 0.8 + brush * 0.16
      return [l, l, l, brush * 0.4]
    },
  },
  brass: {
    tile: 1.2,
    roughness: 0.3,
    metalness: 0.95,
    relief: 0.8,
    tint: 1,
    pixel: (u, v) => {
      const patina = smooth(0.55, 0.8, fbm(u, v, 4, 4, 5, 131))
      const brush = fbm(u, v, 2, 96, 2, 132)
      const l = (0.86 + brush * 0.12) * (1 - patina * 0.35)
      return [l, l, l * (1 - patina * 0.1), brush * 0.3 + patina * 0.4]
    },
  },
  glass: {
    tile: 2,
    roughness: 0.05,
    metalness: 0,
    relief: 0.2,
    tint: 1,
    opacity: 0.32,
    pixel: (u, v) => grey(0.92 + fbm(u, v, 3, 3, 3, 141) * 0.08, 0.5),
  },
  concrete: {
    tile: 3,
    roughness: 0.9,
    metalness: 0,
    relief: 2,
    tint: 1,
    pixel: (u, v, x, y) => {
      const m = fbm(u, v, 4, 4, 5, 151)
      const pore = hash(x, y, 152) > 0.996 ? 0.4 : 1
      const l = (0.72 + m * 0.2) * (pore < 1 ? 0.75 : 1)
      return [l, l, l * 0.98, m * 0.6 + (pore < 1 ? 0 : 0.3)]
    },
  },
  rock: {
    tile: 4,
    roughness: 0.95,
    metalness: 0,
    relief: 5,
    tint: 1,
    pixel: (u, v) => {
      const crack = Math.pow(ridged(u, v, 4, 4, 5, 161), 6)
      const m = fbm(u, v, 6, 6, 5, 162)
      const l = (0.62 + m * 0.32) * (1 - crack * 0.5)
      return [l, l * 0.98, l * 0.95, m * 0.8 - crack * 0.6 + 0.3]
    },
  },
  earth: {
    tile: 2.5,
    roughness: 1,
    metalness: 0,
    relief: 3,
    tint: 1,
    pixel: (u, v) => {
      const m = fbm(u, v, 6, 6, 5, 171)
      const pebble = smooth(0.72, 0.78, fbm(u, v, 24, 24, 2, 172))
      const l = 0.6 + m * 0.25 + pebble * 0.18
      return [l, l * 0.95, l * 0.88, m * 0.5 + pebble * 0.5]
    },
  },
  grass: {
    tile: 2,
    roughness: 0.95,
    metalness: 0,
    relief: 2,
    tint: 1,
    pixel: (u, v, x, y) => {
      const blade = fbm(u, v, 96, 24, 2, 181)
      const patch = fbm(u, v, 3, 3, 4, 182)
      const l = 0.62 + blade * 0.3 + patch * 0.15 - hash(x, y, 183) * 0.06
      return [l * 0.95, l, l * 0.85, blade]
    },
  },
  water: {
    tile: 4,
    roughness: 0.04,
    metalness: 0,
    relief: 2.5,
    tint: 1,
    opacity: 0.82,
    pixel: (u, v) => {
      const c = Math.pow(ridged(u, v, 5, 5, 3, 191), 4)
      const l = 0.78 + c * 0.22
      return [l, l, l, c]
    },
  },
  lava: {
    tile: 4,
    roughness: 0.8,
    metalness: 0,
    relief: 4,
    tint: 0.3,
    emissive: 2.2,
    pixel: (u, v) => {
      const crack = Math.pow(ridged(u, v, 4, 4, 4, 201), 3)
      const heat = smooth(0.25, 0.9, crack)
      const crust = 0.12 + fbm(u, v, 10, 10, 3, 202) * 0.08
      return [crust + heat * 0.9, crust * 0.6 + heat * 0.42, crust * 0.4 + heat * 0.06, 1 - heat]
    },
  },
}

// ------------------------------------------------------------------------------ textures and materials

interface Made {
  map: Texture
  normal: Texture
  material: MeshStandardMaterial
}

const made = new Map<MaterialName, Made>()

interface Textures {
  map: CanvasTexture
  normal: CanvasTexture
}

/** Rows painted in one step of a surface's painting: a few milliseconds' work. */
const BAND = 16

/**
 * A surface's two textures, painted a step at a time: a band of rows of colour and height (a
 * texture painted whole, as the books are, in one step), then the canvas, then a band of rows of
 * relief. Run to the end when the surface is wanted (surface), or a few milliseconds at a time
 * ahead of it (warmSurfaces).
 */
function* painting(name: MaterialName): Generator<void, Textures, void> {
  const def = DEFS[name]
  const col = new Float32Array(SIZE * SIZE * 3)
  const h = new Float32Array(SIZE * SIZE)
  const set = (x: number, y: number, r: number, g: number, b: number, hh: number) => {
    const i = y * SIZE + x
    col[i * 3] = r
    col[i * 3 + 1] = g
    col[i * 3 + 2] = b
    h[i] = hh
  }
  if ('paint' in def) def.paint({ col, h, set })
  else {
    for (let y0 = 0; y0 < SIZE; y0 += BAND) {
      for (let y = y0; y < y0 + BAND; y++) {
        for (let x = 0; x < SIZE; x++) {
          const [r, g, b, hh] = def.pixel(x / SIZE, y / SIZE, x, y)
          set(x, y, r, g, b, hh)
        }
      }
      yield
    }
  }
  const colour = document.createElement('canvas')
  colour.width = colour.height = SIZE
  const g = colour.getContext('2d')!
  const img = g.createImageData(SIZE, SIZE)
  const data = img.data
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = clamp01(col[i * 3]!) * 255
    data[i * 4 + 1] = clamp01(col[i * 3 + 1]!) * 255
    data[i * 4 + 2] = clamp01(col[i * 3 + 2]!) * 255
    data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  def.over?.(g)
  yield
  // The relief: the slope of the height, in tangent space (+y up the texture; the canvas's rows run down).
  const normal = document.createElement('canvas')
  normal.width = normal.height = SIZE
  const ng = normal.getContext('2d')!
  const nimg = ng.createImageData(SIZE, SIZE)
  const ndata = nimg.data
  const at = (x: number, y: number) => h[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]!
  for (let y0 = 0; y0 < SIZE; y0 += BAND) {
    for (let y = y0; y < y0 + BAND; y++) {
      for (let x = 0; x < SIZE; x++) {
        const nx = -(at(x + 1, y) - at(x - 1, y)) * def.relief
        const ny = (at(x, y + 1) - at(x, y - 1)) * def.relief
        const l = Math.hypot(nx, ny, 1)
        const i = (y * SIZE + x) * 4
        ndata[i] = ((nx / l) * 0.5 + 0.5) * 255
        ndata[i + 1] = ((ny / l) * 0.5 + 0.5) * 255
        ndata[i + 2] = ((1 / l) * 0.5 + 0.5) * 255
        ndata[i + 3] = 255
      }
    }
    yield
  }
  ng.putImageData(nimg, 0, 0)
  const map = new CanvasTexture(colour)
  map.colorSpace = SRGBColorSpace
  const nmap = new CanvasTexture(normal)
  nmap.colorSpace = NoColorSpace
  for (const t of [map, nmap]) {
    t.wrapS = t.wrapT = RepeatWrapping
    t.anisotropy = 8
  }
  return { map, normal: nmap }
}

/** Surfaces painted part of the way ahead (warmSurfaces). */
const paintings = new Map<MaterialName, Generator<void, Textures, void>>()

/** A surface's material from its textures, kept: every mesh of it shares it. */
function dress(name: MaterialName, { map, normal }: Textures): Made {
  const def = DEFS[name]
  const material = paint(new MeshStandardMaterial({
    map,
    normalMap: normal,
    normalScale: new Vector2(1, 1),
    roughness: def.roughness,
    metalness: def.metalness,
    vertexColors: true,
  }), PAINT_SURFACE)
  if (def.emissive) {
    material.emissiveMap = map
    material.emissive = new Color('#ffffff')
    material.emissiveIntensity = def.emissive
  }
  if (def.opacity !== undefined) {
    material.transparent = true
    material.opacity = def.opacity
    material.depthWrite = def.opacity > 0.6
  }
  const m = { map, normal, material }
  made.set(name, m)
  return m
}

/** The material for a surface, made the first time it is asked for (what was painted ahead of it painted to the end). */
export function surface(name: MaterialName): MeshStandardMaterial {
  let m = made.get(name)
  if (!m) {
    const p = paintings.get(name) ?? painting(name)
    paintings.delete(name)
    let r = p.next()
    while (!r.done) r = p.next()
    m = dress(name, r.value)
  }
  return m.material
}

/** Milliseconds of painting ahead in one go: less than a frame, so the page draws and answers between. */
const SLICE_MS = 6
let warming = false

/**
 * Paints every surface ahead, `first` first, a few milliseconds at a time, so neither the
 * dressing room nor the first round stalls on them and the page answers meanwhile (each painted in
 * one go, they held the page up to 470 ms at a time for 5 s after the dressing room appeared;
 * measured 2026-11-11).
 */
export function warmSurfaces(first: readonly MaterialName[]): void {
  if (warming) return
  warming = true
  const todo = [...new Set([...first, ...MATERIALS])]
  const step = () => {
    const until = performance.now() + SLICE_MS
    while (todo.length && performance.now() < until) {
      const n = todo[0]!
      if (made.has(n)) {
        todo.shift()
        continue
      }
      let p = paintings.get(n)
      if (!p) {
        p = painting(n)
        paintings.set(n, p)
      }
      const r = p.next()
      if (r.done) {
        paintings.delete(n)
        todo.shift()
        dress(n, r.value)
      }
    }
    if (todo.length) setTimeout(step, 0)
    else warming = false
  }
  setTimeout(step, 0)
}

/** Moves the water's and the lava's relief a little each frame. */
export function flowSurfaces(dt: number): void {
  for (const [name, speed] of [
    ['water', 0.03],
    ['lava', 0.006],
  ] as const) {
    const m = made.get(name)
    if (!m) continue
    m.normal.offset.x += dt * speed
    m.normal.offset.y += dt * speed * 0.6
    if (name === 'lava') m.map.offset.copy(m.normal.offset)
  }
}

/** How much of a solid's colour its surface takes. */
export const tintOf = (name: MaterialName) => DEFS[name].tint

const white = new Color(1, 1, 1)
const tmp = new Color()

/** Texture coordinates by box mapping, in tiles of `tile` metres: each face projected along its strongest axis. The geometry must not be indexed. */
export function boxUV(g: BufferGeometry, tile: number): void {
  const pos = g.getAttribute('position')
  const n = pos.count
  const uv = new Float32Array(n * 2)
  for (let i = 0; i + 2 < n; i += 3) {
    const ax = pos.getX(i)
    const ay = pos.getY(i)
    const az = pos.getZ(i)
    const ux = pos.getX(i + 1) - ax
    const uy = pos.getY(i + 1) - ay
    const uz = pos.getZ(i + 1) - az
    const vx = pos.getX(i + 2) - ax
    const vy = pos.getY(i + 2) - ay
    const vz = pos.getZ(i + 2) - az
    const nx = Math.abs(uy * vz - uz * vy)
    const ny = Math.abs(uz * vx - ux * vz)
    const nz = Math.abs(ux * vy - uy * vx)
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k)
      const y = pos.getY(i + k)
      const z = pos.getZ(i + k)
      const [s, t] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y]
      uv[(i + k) * 2] = s / tile
      uv[(i + k) * 2 + 1] = t / tile
    }
  }
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
}

/** A surface's two textures, for meshes that keep a material of their own (a doctor's coat, a crate). */
export function surfaceMaps(name: MaterialName): { map: Texture; normal: Texture } {
  surface(name)
  const m = made.get(name)!
  return { map: m.map, normal: m.normal }
}

/**
 * Geometry ready to merge into one mesh per surface: moved into place by the matrix, texture
 * coordinates by box mapping in metres (each face projected along its strongest axis), and a
 * colour per corner (the given colour, as much as the surface takes; a model's own colours
 * when it has them).
 */
export function prepared(source: BufferGeometry, matrix: Matrix4, name: MaterialName, color: string | null): BufferGeometry {
  const g = source.index ? source.toNonIndexed() : source.clone()
  g.applyMatrix4(matrix)
  for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'color') g.deleteAttribute(key)
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  boxUV(g, DEFS[name].tile)
  const n = g.getAttribute('position').count
  const own = g.getAttribute('color')
  const colours = new Float32Array(n * 3)
  const given = color === null ? null : harmonize(tmp.set(color)).lerp(white, 1 - tintOf(name)).clone()
  for (let i = 0; i < n; i++) {
    if (given) given.toArray(colours, i * 3)
    else if (own) {
      colours[i * 3] = own.getX(i)
      colours[i * 3 + 1] = own.getY(i)
      colours[i * 3 + 2] = own.getZ(i)
    } else white.toArray(colours, i * 3)
  }
  g.setAttribute('color', new Float32BufferAttribute(colours, 3))
  return g
}
