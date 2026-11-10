/**
 * The Old Lecture Hall: the game's own arena, played when no arena from Opus is ready and in the
 * tests, and the fullest use of the arena builder there is. A plank floor with a carpet runner,
 * stone walls with oak panelling and a cornice, marble columns, arched windows full of daylight,
 * tiers of benches with desks up to a back gallery, a stage with a lectern, chalkboards, a lab
 * bench of glowing flasks, a Tesla coil and a globe, side balconies over bookcases reached by
 * stone stairs, two chandeliers under open roof beams, the doctors' portraits, a lift, a jump pad and a sweeping pointer.
 * What breaks: the bookcases, a glass specimen cabinet and a stack of crates of unmarked exam papers.
 */

import type { Kit } from '../model/kit'
import type { Vec3 } from '../protocol'
import type { ArenaSource } from './arena'

type Opts = { at?: Vec3; rot?: Vec3; color?: string; material?: string; scale?: number }
type A = {
  box: (size: Vec3, opts?: Opts) => unknown
  ramp: (size: Vec3, opts?: Opts) => unknown
  cylinder: (r: number, h: number, opts?: Opts) => unknown
  mover: (build: () => void, move: (t: number) => { at?: Vec3; rot?: Vec3 }) => { id: string }
  breakable: (build: () => void, opts?: { strength?: number }) => { id: string; broken: () => boolean } | null
  zone: (spec: object, handlers: object) => unknown
  every: (fn: (dt: number) => void) => void
  spawn: (at: Vec3) => void
  decor: (build: (m: Kit) => void, opts?: Opts) => void
  solid: (build: (m: Kit) => void, opts?: Opts) => void
  light: (opts: { at: Vec3; color?: string; power?: number; range?: number }) => void
  portrait: (opts: { at: Vec3; rot?: Vec3; size?: number; rank?: number }) => void
  sky: (opts: object) => void
}
type W = { push: (d: unknown, v: Vec3) => void; time: number }

const OAK = '#7a4f2c'
const DARK_OAK = '#4e3220'
const STONE = '#b9ae98'
const PLASTER = '#e0d3b8'
const MARBLE = '#ece6da'
const BRASS = '#d2a84a'
const CARPET = '#7c2430'

export const LECTURE_HALL: ArenaSource = {
  id: 'lecture-hall',
  name: 'The Old Lecture Hall',
  build: (a: A, w: W) => {
    a.sky({ color: '#7f93bb', light: '#ffe2b6', ground: '#3b2f2a', fog: 0.12 })

    // The floor, and the runner from the benches to the stage.
    a.box([44, 1, 44], { at: [0, -0.5, 0], color: '#a8784a', material: 'planks' })
    a.box([4, 0.04, 17], { at: [0, 0.02, 2.5], color: CARPET, material: 'carpet' })

    // Walls: stone, oak panelling below, plaster above, a cornice along the top.
    for (const [x, z, wd, dp] of [
      [0, -22.5, 46, 1],
      [0, 22.5, 46, 1],
      [-22.5, 0, 1, 46],
      [22.5, 0, 1, 46],
    ] as const) {
      a.box([wd, 4, dp], { at: [x, 2, z], color: STONE, material: 'stone' })
      a.box([wd, 6.2, dp], { at: [x, 7.1, z], color: PLASTER, material: 'plaster' })
    }
    for (const [x, z, wd, dp] of [
      [0, -21.94, 44, 0.12],
      [0, 21.94, 44, 0.12],
      [-21.94, 0, 0.12, 44],
      [21.94, 0, 0.12, 44],
    ] as const) {
      a.box([wd, 1.3, dp], { at: [x, 0.65, z], color: DARK_OAK, material: 'wood' })
      a.box([wd === 44 ? 44 : 0.3, 0.45, dp === 44 ? 44 : 0.3], { at: [x * 0.995, 9.8, z * 0.995], color: STONE, material: 'stone' })
    }

    // Marble columns along the side walls.
    const column = (m: Kit) => {
      m.cylinder(0.55, 0.6, 0.5, { at: [0, 0.25, 0], color: MARBLE })
      m.lathe(
        [
          [0.42, 0.5],
          [0.4, 3],
          [0.36, 7.2],
          [0.5, 7.6],
          [0.62, 7.9],
        ],
        { color: MARBLE },
      )
      m.box(1.4, 0.3, 1.4, { at: [0, 8.05, 0], color: MARBLE })
      for (let i = 0; i < 12; i++) m.box(0.06, 6.4, 0.06, { at: [Math.sin((i / 12) * Math.PI * 2) * 0.39, 3.9, Math.cos((i / 12) * Math.PI * 2) * 0.39], color: '#d8d0c0' })
    }
    for (const x of [-21.1, 21.1]) for (const z of [-18, -12, -6, 0, 6, 12, 18]) a.solid(column, { at: [x, 0, z], material: 'marble' })

    // Arched windows high in the side walls, full of daylight.
    const windowShape = (m: Kit) => {
      const arch: number[][] = []
      for (let i = 0; i <= 12; i++) arch.push([Math.cos((i / 12) * Math.PI) * 1.1, 2.6 + Math.sin((i / 12) * Math.PI) * 1.1])
      m.extrude([[1.1, 0], ...arch, [-1.1, 0]], 0.05, { color: '#d6ecff', glow: true })
      m.tube(
        arch.map(([x, y]) => [x!, y!, 0.06]),
        0.08,
        { color: DARK_OAK },
      )
      m.box(0.16, 2.6, 0.16, { at: [-1.1, 1.3, 0.06], color: DARK_OAK })
      m.box(0.16, 2.6, 0.16, { at: [1.1, 1.3, 0.06], color: DARK_OAK })
      m.box(2.6, 0.16, 0.3, { at: [0, 0, 0.1], color: STONE })
      m.box(0.06, 3.6, 0.06, { at: [0, 1.8, 0.07], color: DARK_OAK })
      m.box(2.2, 0.06, 0.06, { at: [0, 1.6, 0.07], color: DARK_OAK })
    }
    for (const side of [-1, 1]) for (const z of [-15, -9, -3, 3, 9, 15]) a.decor(windowShape, { at: [side * 21.96, 5.6, z], rot: [0, (-side * Math.PI) / 2, 0], material: 'wood' })

    // Open roof beams.
    for (let x = -20; x <= 20; x += 5) a.decor((m) => m.box(0.45, 0.6, 46, { color: DARK_OAK }), { at: [x, 10.4, 0], material: 'wood' })
    for (const z of [-11, 0, 11]) a.decor((m) => m.box(46, 0.35, 0.3, { color: DARK_OAK }), { at: [0, 10.9, z], material: 'wood' })

    // Tiers of benches rising toward -z, with desks and an aisle, up to the gallery.
    for (let i = 0; i < 6; i++) {
      const top = 0.6 * (i + 1)
      a.box([30, top, 2.4], { at: [0, top / 2, -8 - i * 2.4], color: i % 2 ? '#8a5c36' : '#7a4f2c', material: 'planks' })
      for (const x of [-9, 9]) a.box([12, 0.08, 0.6], { at: [x, top + 0.74, -7.3 - i * 2.4], color: OAK, material: 'wood' })
      for (const x of [-14.6, -3.4, 3.4, 14.6]) a.box([0.12, 0.74, 0.5], { at: [x, top + 0.37, -7.3 - i * 2.4], color: DARK_OAK, material: 'wood' })
    }
    a.box([44, 3.6, 6], { at: [0, 1.8, -19.5], color: '#8a5c36', material: 'planks' })

    // The doctors' portraits above the gallery: whoever leads the match in the middle, larger.
    a.portrait({ at: [0, 6.5, -21.98], size: 2.4, rank: 0 })
    for (const [x, rank] of [
      [-6, 1],
      [6, 2],
      [-13, 3],
      [13, 4],
    ] as const)
      a.portrait({ at: [x, 6.4, -21.98], size: 1.9, rank })

    // The stage: steps up its front, a ramp at its side, the lectern with its lamp.
    a.box([18, 1, 7], { at: [0, 0.5, 15], color: OAK, material: 'planks' })
    a.box([18.2, 0.16, 0.2], { at: [0, 0.92, 11.45], color: DARK_OAK, material: 'wood' })
    a.box([8, 0.5, 0.8], { at: [0, 0.25, 11.1], color: STONE, material: 'stone' })
    a.ramp([4, 1, 3], { at: [-11, 0.5, 13.5], rot: [0, Math.PI / 2, 0], color: '#8a5c36', material: 'planks' })
    a.solid(
      (m) => {
        m.box(1.0, 1.15, 0.6, { at: [0, 0.575, 0], color: DARK_OAK })
        m.box(1.15, 0.08, 0.75, { at: [0, 1.25, -0.03], rot: [-0.3, 0, 0], color: OAK })
        m.box(1.1, 0.1, 0.7, { at: [0, 0.05, 0], color: DARK_OAK })
      },
      { at: [0, 1, 13.6], material: 'wood' },
    )
    a.decor(
      (m) => {
        m.cylinder(0.03, 0.03, 0.4, { at: [0.35, 0.2, 0], color: BRASS })
        m.cone(0.12, 0.12, { at: [0.35, 0.42, 0.05], rot: [0.4, 0, 0], color: '#2a5a3a' })
        m.sphere(0.04, { at: [0.35, 0.38, 0.08], color: '#fff2c0', glow: true })
        m.box(0.5, 0.04, 0.36, { at: [-0.1, 0.02, 0], color: '#f2ead6' })
      },
      { at: [0, 2.3, 13.6], rot: [-0.3, 0, 0], material: 'brass' },
    )
    a.light({ at: [0.35, 2.9, 13.4], color: '#ffd9a0', power: 0.35, range: 7 })

    // Chalkboards on the back wall, framed in oak.
    for (const x of [-6, 6]) {
      a.box([7, 2.6, 0.08], { at: [x, 3.4, 21.86], color: '#ffffff', material: 'chalkboard' })
      a.decor(
        (m) => {
          m.box(7.3, 0.15, 0.12, { at: [0, 1.36, 0], color: OAK })
          m.box(7.3, 0.15, 0.12, { at: [0, -1.36, 0], color: OAK })
          m.box(0.15, 2.8, 0.12, { at: [-3.6, 0, 0], color: OAK })
          m.box(0.15, 2.8, 0.12, { at: [3.6, 0, 0], color: OAK })
          m.box(7.3, 0.06, 0.25, { at: [0, -1.45, -0.1], color: OAK })
          for (let i = 0; i < 5; i++) m.box(0.12, 0.03, 0.03, { at: [-2 + i * 0.8, -1.4, -0.12], color: '#f4f0e6' })
        },
        { at: [x, 3.4, 21.8], material: 'wood' },
      )
    }

    // The lab bench: glowing flasks and a Tesla coil.
    a.box([5, 1.0, 1.2], { at: [-5.5, 1.5, 17.6], color: DARK_OAK, material: 'wood' })
    a.box([5.2, 0.08, 1.3], { at: [-5.5, 2.04, 17.6], color: '#2a2a2e', material: 'stone' })
    a.decor(
      (m) => {
        const colours = ['#7dff9a', '#ff7ad8', '#7ad8ff', '#fff07a']
        for (let i = 0; i < 7; i++) {
          const x = -2 + i * 0.65
          const c = colours[i % colours.length]!
          m.lathe(
            [
              [0.001, 0],
              [0.16, 0.02],
              [0.18, 0.12],
              [0.06, 0.3],
              [0.05, 0.45],
            ],
            { at: [x, 0, 0], color: '#cfe8f0' },
          )
          m.sphere(0.13, { at: [x, 0.11, 0], scale: [1, 0.7, 1], color: c, glow: true })
        }
        m.tube(
          [
            [-1.6, 0.45, 0],
            [-1.2, 0.8, 0],
            [-0.4, 0.75, 0],
            [0.1, 0.45, 0],
          ],
          0.015,
          { color: '#cfe8f0' },
        )
      },
      { at: [-5.5, 2.08, 17.6], material: 'glass' },
    )
    a.solid(
      (m) => {
        m.cylinder(0.5, 0.6, 0.3, { at: [0, 0.15, 0], color: '#2a2a2e' })
        m.cylinder(0.18, 0.22, 2.2, { at: [0, 1.4, 0], color: '#b06a3a' })
        for (let i = 0; i < 9; i++) m.torus(0.21, 0.025, { at: [0, 0.5 + i * 0.22, 0], rot: [Math.PI / 2, 0, 0], color: '#d08a4a' })
        m.torus(0.42, 0.14, { at: [0, 2.6, 0], rot: [Math.PI / 2, 0, 0], color: '#c4c9d1' })
      },
      { at: [7.8, 1, 18.2], material: 'metal' },
    )
    a.decor((m) => m.sphere(0.12, { color: '#bfe8ff', glow: true }), { at: [7.8, 3.85, 18.2] })
    a.light({ at: [7.8, 4.1, 18.2], color: '#a8d8ff', power: 0.45, range: 9 })

    // A globe on a stand.
    a.solid(
      (m) => {
        m.cylinder(0.3, 0.35, 0.08, { at: [0, 0.04, 0], color: DARK_OAK })
        m.cylinder(0.04, 0.04, 0.8, { at: [0, 0.45, 0], color: BRASS })
        m.torus(0.42, 0.02, { at: [0, 1.2, 0], rot: [0, 0, 0.4], color: BRASS })
        m.sphere(0.38, { at: [0, 1.2, 0], color: '#3a6a8a' })
        m.sphere(0.385, { at: [0.05, 1.25, 0.02], scale: [0.6, 0.7, 0.8], color: '#8aa060' })
      },
      { at: [-2.6, 1, 12.5], material: 'wood' },
    )

    // A specimen cabinet on the right: a glass case on an oak plinth, a skull and two jars inside. A good knock breaks it.
    a.breakable(
      () => {
        a.box([1.6, 0.8, 0.8], { at: [12.5, 0.4, -3], color: DARK_OAK, material: 'wood' })
        a.box([1.5, 1.2, 0.7], { at: [12.5, 1.4, -3], color: '#d6ecf2', material: 'glass' })
        a.decor(
          (m) => {
            m.sphere(0.13, { at: [-0.35, 0.14, 0], scale: [1, 1.1, 1.2], color: '#efe6cf' })
            m.box(0.16, 0.07, 0.14, { at: [-0.35, 0.04, 0.09], color: '#e4d9bf' })
            for (const x of [0.15, 0.45]) {
              m.cylinder(0.1, 0.1, 0.32, { at: [x, 0.16, 0], color: '#cfe8f0' })
              m.cylinder(0.085, 0.085, 0.24, { at: [x, 0.13, 0], color: '#9ccf6a' })
            }
          },
          { at: [12.5, 0.82, -3], material: 'glass' },
        )
      },
      { strength: 300 },
    )

    // Crates of unmarked exam papers stacked on the left, each breaking on its own (the top one falls when one under it goes).
    for (const [x, y, z, turn] of [
      [-12.6, 0.5, -4.2, 0.1],
      [-11.5, 0.5, -3.6, -0.2],
      [-12.05, 1.5, -3.9, 0.35],
    ] as const)
      a.breakable(() => {
        a.box([1, 1, 1], { at: [x, y, z], rot: [0, turn, 0], color: '#b08a5a', material: 'planks' })
        a.decor(
          (m) => {
            for (let i = 0; i < 3; i++) m.box(0.62, 0.05, 0.44, { at: [(i - 1) * 0.04, i * 0.05, (i % 2) * 0.05], rot: [0, i * 0.2, 0], color: '#f2ead6' })
          },
          { at: [x, y + 0.5, z], rot: [0, turn, 0], material: 'paper' },
        )
      })

    // Side balconies on stone corbels, over bookcases, with stairs down by the stage.
    for (const side of [-1, 1]) {
      a.box([6, 0.5, 18], { at: [side * 18.5, 4.05, 3], color: '#8a5c36', material: 'planks' })
      for (const z of [-3, 3, 9]) a.breakable(() => a.box([0.9, 3.8, 4.8], { at: [side * 21.45, 1.9, z], color: '#ffffff', material: 'books' }))
      for (const z of [-5, 0, 5, 10]) a.decor((m) => m.box(0.5, 0.7, 0.5, { at: [0, 0, 0], color: STONE }), { at: [side * 15.75, 3.45, z], material: 'stone' })
      // A balustrade along the inner edge, open where the stairs come up.
      a.decor(
        (m) => {
          for (let z = -5.8; z <= 10.2; z += 0.4) {
            m.lathe(
              [
                [0.05, 0],
                [0.08, 0.15],
                [0.05, 0.4],
                [0.08, 0.7],
                [0.05, 0.85],
              ],
              { at: [0, 0, z], color: MARBLE },
            )
          }
          m.box(0.18, 0.1, 16.2, { at: [0, 0.9, 2.2], color: OAK })
        },
        { at: [side * 15.65, 4.3, 0], material: 'marble' },
      )
      a.box([0.18, 1, 16.2], { at: [side * 15.65, 4.8, 2.2], color: OAK, material: 'wood' })
      for (let i = 0; i < 11; i++) {
        const top = 4.3 - 0.39 * (i + 1)
        if (top < 0.05) break
        a.box([3, top, 0.82], { at: [side * 17.2, top / 2, 12.4 + i * 0.82], color: STONE, material: 'stone' })
      }
      // A sconce on the wall above each balcony.
      a.decor(
        (m) => {
          m.box(0.12, 0.4, 0.3, { at: [0, 0, 0], color: BRASS })
          m.cylinder(0.08, 0.04, 0.25, { at: [-0.18, 0.2, 0], color: BRASS })
          m.sphere(0.07, { at: [-0.18, 0.38, 0], color: '#ffe0a0', glow: true })
        },
        { at: [side * 21.85, 6.2, 3], rot: [0, side > 0 ? 0 : Math.PI, 0], material: 'brass' },
      )
      a.light({ at: [side * 21.4, 6.6, 3], color: '#ffd9a0', power: 0.5, range: 12 })
    }

    // Two chandeliers.
    const chandelier = (m: Kit) => {
      m.tube(
        [
          [0, 0, 0],
          [0, 1.9, 0],
        ],
        0.03,
        { color: '#3a3a3a' },
      )
      m.lathe(
        [
          [0.001, -0.5],
          [0.18, -0.35],
          [0.12, -0.1],
          [0.2, 0.05],
          [0.06, 0.2],
        ],
        { color: BRASS },
      )
      m.torus(1.1, 0.05, { at: [0, -0.2, 0], rot: [Math.PI / 2, 0, 0], color: BRASS })
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2
        const x = Math.sin(ang) * 1.1
        const z = Math.cos(ang) * 1.1
        m.cylinder(0.035, 0.035, 0.22, { at: [x, -0.05, z], color: '#f4ecd8' })
        m.sphere(0.05, { at: [x, 0.11, z], scale: [0.7, 1.3, 0.7], color: '#ffcf70', glow: true })
      }
    }
    for (const z of [-4, 8]) {
      a.decor(chandelier, { at: [0, 8.4, z], material: 'brass' })
      a.light({ at: [0, 8.2, z], color: '#ffd28a', power: 0.85, range: 22 })
    }

    // Two more of the doctors between the columns.
    for (const [side, rank] of [
      [-1, 5],
      [1, 6],
    ] as const) {
      a.portrait({ at: [side * 21.97, 2.95, -15], rot: [0, (-side * Math.PI) / 2, 0], size: 1.5, rank })
    }

    // The lift beside the stage, its brass cage going up with it.
    a.mover(
      () => {
        a.box([3, 0.3, 3], { color: BRASS, material: 'brass' })
        a.decor(
          (m) => {
            for (const [x, z] of [
              [-1.4, -1.4],
              [1.4, -1.4],
              [-1.4, 1.4],
              [1.4, 1.4],
            ])
              m.cylinder(0.04, 0.04, 1.2, { at: [x!, 0.75, z!], color: BRASS })
            m.torus(1.98, 0.035, { at: [0, 1.35, 0], rot: [Math.PI / 2, 0, Math.PI / 4], scale: [1, 1, 1], color: BRASS })
          },
          { material: 'brass' },
        )
      },
      (t) => ({ at: [13.5, 0.15 + 3.85 * (0.5 - 0.5 * Math.cos(t * 0.8)), 15] }),
    )

    // The jump pad by the left balcony: a brass disc with a glowing ring.
    a.cylinder(1.2, 0.16, { at: [-13.5, 0.08, 2], color: BRASS, material: 'brass' })
    a.decor((m) => m.torus(1.0, 0.06, { rot: [Math.PI / 2, 0, 0], color: '#ff9a4a', glow: true }), { at: [-13.5, 0.17, 2] })
    a.zone({ at: [-13.5, 0.6, 2], size: [2.4, 1, 2.4] }, { enter: (d: { id: string }) => w.push(d, [0, 15, 0]) })

    // The pointer that sweeps the right half of the stage.
    a.mover(
      () => {
        a.box([0.25, 0.25, 4], { at: [0, 0, 2], color: '#d8c79a', material: 'wood' })
        a.cylinder(0.4, 0.6, { at: [0, 0, 0], color: BRASS, material: 'brass' })
        a.decor((m) => m.cone(0.16, 0.4, { rot: [Math.PI / 2, 0, 0], color: '#c8402c' }), { at: [0, 0, 4.15] })
      },
      (t) => ({ at: [4.5, 1.6, 15], rot: [0, t * 1.1, 0] }),
    )

    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2
      a.spawn([Math.sin(ang) * 9, 0.05, Math.cos(ang) * 5 + 0.5])
    }
  },
}
