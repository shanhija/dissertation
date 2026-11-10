/**
 * The doctor's body plan, shared by the server (the look designer's prompt, the bots' names) and
 * the page (drawing). A standard doctor is 1.75 m tall, feet at y 0, facing +z; a doctor of
 * another height is the standard one scaled whole, and `build` widens the body (not the head).
 * Worn parts are built in the frames below and drawn in them, scaled with the doctor.
 */

import { GAITS, type Look, type Slot, type Vec3 } from './protocol'

export const BODY = {
  height: 1.75,
  head: { center: [0, 1.6, 0] as Vec3, radius: 0.13 },
  shoulders: { y: 1.42, half: 0.22 },
  hips: { y: 0.92, half: 0.12 },
  torso: { bottom: 0.92, top: 1.46, width: 0.4, depth: 0.24 },
  coat: { bottom: 0.42, top: 1.46 },
  arm: { length: 0.62, radius: 0.055 },
  leg: { radius: 0.075 },
} as const

/** Where each slot's origin is on the standard doctor, and what that frame means. */
export const SLOT_FRAMES: Record<Slot, { origin: Vec3; about: string }> = {
  hair: { origin: [0, 1.6, 0], about: 'the middle of the head: a ball of radius 0.13, the face toward +z (eyes at z 0.115, y 0.02, 0.045 apart each side), the top of the head at y 0.13, the neck below at y -0.14' },
  head: { origin: [0, 1.6, 0], about: 'the middle of the head, as for hair: a hat sits on the top at y 0.13, over any hair' },
  face: { origin: [0, 1.6, 0], about: 'the middle of the head, as for hair: the face is its front, z 0.1 to 0.14, from y -0.1 (chin) to 0.07 (brow)' },
  body: { origin: [0, 0, 0], about: 'between the feet on the ground: hips at y 0.92, shoulders at y 1.42 and 0.44 wide, the chest at z 0.13, a lab coat from y 0.42 to 1.46. It goes with the trunk as it bends, while the legs and arms move on their own' },
  back: { origin: [0, 1.25, -0.13], about: 'between the shoulder blades, the back facing -z: the shoulders are at y 0.17 and x ±0.22' },
  feet: { origin: [0.1, 0, 0], about: 'on the ground under the left ankle, toes toward +z, the outer side toward +x: the foot is 0.12 wide and 0.1 high, from the heel at z -0.1 to the toes at z 0.19, the trouser leg ending just above it at y 0.04. The code makes the left foot and the right wears it mirrored; it moves with each foot and takes the place of the shoes' },
}

export const PLAYER_COLORS = ['#e05a47', '#3f8fd8', '#5bb55b', '#e3b23c', '#a46ad8', '#e07fb8', '#3cc0b8', '#e08a3a'] as const

const SKINS = ['#f3d2b3', '#e8b892', '#c98e66', '#a06a44', '#7a4b2e', '#f5dccb', '#d9a27a', '#5c3a24']
const EYES = ['#3a2a1e', '#2a4a7a', '#3f6a3a', '#5a5a5a', '#6a3a1e']
const COATS = ['#f4f1ea', '#f4f1ea', '#f4f1ea', '#e9efe8', '#f2ecdc']
const SHIRTS = ['#4a6a9a', '#8a3a3a', '#3a5a3a', '#6a5a8a', '#c8b07a', '#2a2a30', '#9a6a3a']
const TROUSERS = ['#2a2a30', '#4a3a2a', '#3a3a4a', '#5a5048', '#24304a']
const SHOES = ['#1e1a18', '#4a2a1a', '#2a2a2a', '#5a3a24']

/** A look for a new doctor or a bot: picked colours, a standard body and whatever starter parts are given. */
export function randomLook(random: () => number, worn: Look['worn']): Look {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!
  return {
    height: Math.round((1.62 + random() * 0.3) * 100) / 100,
    build: Math.round((0.9 + random() * 0.3) * 100) / 100,
    skin: pick(SKINS),
    eyes: pick(EYES),
    coat: pick(COATS),
    shirt: pick(SHIRTS),
    trousers: pick(TROUSERS),
    shoes: pick(SHOES),
    gait: pick(GAITS.slice(1)),
    worn,
  }
}

/** A look made sane: sizes in range, colours as '#rrggbb', worn parts only by id. */
export function cleanLook(l: Look, known: (id: string) => Slot | null): Look {
  const color = (c: unknown, def: string) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : def)
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def)
  const worn: Look['worn'] = {}
  // A part goes in its own slot, whatever slot it was worn in (a part can move to a new slot).
  for (const id of Object.values(l.worn ?? {})) {
    const slot = typeof id === 'string' ? known(id) : null
    if (slot) worn[slot] = id as string
  }
  return {
    height: num(l.height, 1.5, 2.05, 1.75),
    build: num(l.build, 0.8, 1.3, 1),
    skin: color(l.skin, '#e8b892'),
    eyes: color(l.eyes, '#3a2a1e'),
    coat: color(l.coat, '#f4f1ea'),
    shirt: color(l.shirt, '#4a6a9a'),
    trousers: color(l.trousers, '#2a2a30'),
    shoes: color(l.shoes, '#1e1a18'),
    gait: GAITS.includes(l.gait) ? l.gait : 'chance',
    worn,
  }
}

const FIRST = ['Ambrose', 'Ottilie', 'Barnaby', 'Cordelia', 'Ignatius', 'Philippa', 'Mortimer', 'Eudora', 'Thaddeus', 'Wilhelmina', 'Cornelius', 'Hester', 'Lysander', 'Prudence', 'Erasmus', 'Agatha']
const LAST = ['Quill', 'Fenwick', 'Bramblecote', 'Vexley', 'Huxtable', 'Grimsditch', 'Ollerenshaw', 'Pettigrew', 'Snodbury', 'Wormald', 'Crumpsall', 'Fothergill']

export function botName(random: () => number, taken: ReadonlySet<string>): string {
  for (let i = 0; i < 50; i++) {
    const name = `${FIRST[Math.floor(random() * FIRST.length)]} ${LAST[Math.floor(random() * LAST.length)]} (bot)`
    if (!taken.has(name)) return name
  }
  return `Bot ${taken.size + 1}`
}

/** The game's own wardrobe parts, written as the look designer writes them (the body of function (m), in the slot's frame). */
export const STARTER_WEAR: { id: string; name: string; slot: Slot; code: string }[] = [
  {
    id: 'wild-white-hair',
    name: 'Wild white hair',
    slot: 'hair',
    code: `const c = '#f2f0ea'
m.sphere(0.135, { at: [0, 0.03, -0.02], scale: [1, 0.8, 1], color: c })
for (let i = 0; i < 9; i++) {
  const a = Math.PI * 0.25 + (i / 8) * Math.PI * 1.5
  const [x, z] = [Math.sin(a), Math.cos(a) * -0.86]
  m.part('tuft', { at: [x * 0.09, 0.02 + (i % 3) * 0.03, z * 0.09 - 0.02] }, () => m.sphere(0.06, { at: [x * 0.05, 0.01, z * 0.05], color: c }))
}`,
  },
  {
    id: 'slick-parting',
    name: 'Slick parting',
    slot: 'hair',
    code: `m.sphere(0.138, { at: [0, 0.035, -0.015], scale: [1, 0.78, 1.02], color: '#2a1e18' })
m.box(0.005, 0.02, 0.2, { at: [0.04, 0.142, 0], color: '#f3d2b3' })`,
  },
  {
    id: 'tight-bun',
    name: 'Tight bun',
    slot: 'hair',
    code: `m.sphere(0.137, { at: [0, 0.035, -0.02], scale: [1, 0.8, 1], color: '#6a3a1e' })
m.sphere(0.065, { at: [0, 0.1, -0.13], color: '#6a3a1e' })`,
  },
  {
    id: 'round-goggles',
    name: 'Round goggles',
    slot: 'face',
    code: `for (const x of [-0.05, 0.05]) {
  m.torus(0.035, 0.012, { at: [x, 0.025, 0.13], color: '#b08a3c' })
  m.cylinder(0.03, 0.03, 0.01, { at: [x, 0.025, 0.13], rot: [Math.PI / 2, 0, 0], color: '#9fd8e8' })
}
m.torus(0.135, 0.008, { at: [0, 0.025, 0], rot: [Math.PI / 2, 0, 0], color: '#2a2a2a' })`,
  },
  {
    id: 'monocle',
    name: 'Monocle',
    slot: 'face',
    code: `m.torus(0.035, 0.006, { at: [0.045, 0.02, 0.128], color: '#e2b33c' })
m.part('chain', { at: [0.08, 0, 0.125] }, () => m.tube([[0, 0, 0], [0.02, -0.08, -0.025], [0, -0.2, -0.005]], 0.003, { color: '#e2b33c' }))`,
  },
  {
    id: 'mortarboard',
    name: 'Mortarboard',
    slot: 'head',
    code: `m.cylinder(0.13, 0.135, 0.07, { at: [0, 0.1, 0], color: '#1e1e24' })
m.box(0.34, 0.02, 0.34, { at: [0, 0.145, 0], rot: [0, Math.PI / 4, 0], color: '#1e1e24' })
m.sphere(0.014, { at: [0, 0.158, 0], color: '#e2b33c' })
m.tube([[0, 0.158, 0], [0.245, 0.158, 0]], 0.006, { color: '#e2b33c' })
m.part('tassel', { at: [0.25, 0.152, 0] }, () => {
  m.tube([[0, 0, 0], [0, -0.06, 0]], 0.006, { color: '#e2b33c' })
  m.part('tassel end', { at: [0, -0.06, 0] }, () => {
    m.sphere(0.012, { color: '#e2b33c' })
    m.cylinder(0.008, 0.02, 0.07, { at: [0, -0.042, 0], color: '#e2b33c' })
  })
})`,
  },
  {
    id: 'head-mirror',
    name: 'Head mirror',
    slot: 'head',
    code: `m.torus(0.137, 0.012, { at: [0, 0.06, 0], rot: [Math.PI / 2, 0, 0], color: '#2a2a30' })
m.cylinder(0.05, 0.05, 0.01, { at: [0, 0.1, 0.15], rot: [Math.PI / 2 - 0.4, 0, 0], color: '#d8dde4' })`,
  },
  {
    id: 'bow-tie',
    name: 'Bow tie',
    slot: 'body',
    code: `m.cone(0.04, 0.07, { at: [-0.035, 1.43, 0.135], rot: [0, 0, -Math.PI / 2], color: '#a02a3a' })
m.cone(0.04, 0.07, { at: [0.035, 1.43, 0.135], rot: [0, 0, Math.PI / 2], color: '#a02a3a' })
m.sphere(0.018, { at: [0, 1.43, 0.14], color: '#7a1a2a' })`,
  },
  {
    id: 'tesla-pack',
    name: 'Tesla pack',
    slot: 'back',
    code: `m.box(0.3, 0.4, 0.14, { at: [0, 0, -0.08], color: '#5a4632' })
for (const x of [-0.08, 0.08]) {
  m.part('coil', { at: [x, 0.18, -0.08] }, () => {
    m.cylinder(0.025, 0.025, 0.25, { at: [0, 0.12, 0], color: '#b08a3c' })
    m.sphere(0.045, { at: [0, 0.26, 0], color: '#9fe8ff', glow: true })
  })
}`,
  },
]
